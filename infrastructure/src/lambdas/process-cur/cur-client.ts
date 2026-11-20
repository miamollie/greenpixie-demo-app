import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { parse } from "csv-parse";
import { CurRow } from "./emissions";

export interface CurObject {
  key: string;
  size: number;
}

export class CurClient {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly prefix: string,
    private readonly maxBytes: number,
  ) {}

  async listObjects(period: string): Promise<CurObject[]> {
    const root = this.prefix.replace(/^\/+|\/+$/g, "");
    const prefix = `${root ? `${root}/` : ""}data/BILLING_PERIOD=${period}/`;
    const objects: CurObject[] = [];
    let continuationToken: string | undefined;
    let totalBytes = 0;

    do {
      const response = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const item of response.Contents ?? []) {
        const key = item.Key ?? "";
        if (!key.endsWith(".csv") && !key.endsWith(".csv.gz")) continue;
        const size = item.Size ?? 0;
        totalBytes += size;
        objects.push({ key, size });
      }
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    if (totalBytes > this.maxBytes) {
      throw new Error(
        `CUR period is ${totalBytes} compressed bytes; Phase 0 limit is ${this.maxBytes}. Use the Athena-based Phase 1 pipeline for this export.`,
      );
    }
    if (!objects.length) {
      throw new Error(
        `No CSV CUR objects found under s3://${this.bucket}/${prefix}; Phase 0 requires CSV or CSV/GZIP, not Parquet.`,
      );
    }
    return objects;
  }

  async *readRows(objects: CurObject[]): AsyncGenerator<CurRow> {
    for (const object of objects) yield* this.rowsFromObject(object.key);
  }

  private async *rowsFromObject(key: string): AsyncGenerator<CurRow> {
    const result = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!result.Body) throw new Error(`S3 returned an empty body for ${key}`);
    const body = result.Body as Readable;
    const input = key.endsWith(".gz") ? body.pipe(createGunzip()) : body;
    const parser = parse({ columns: true, bom: true, skip_empty_lines: true });
    input.pipe(parser);
    for await (const row of parser) yield row as CurRow;
  }
}
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { parse } from "csv-parse";
import { aggregateRows, CurRow, joinKey, mergeHistory } from "./logic";

const s3 = new S3Client({}); //make this region aware and move the CUR bucket to eu-north-1
const secrets = new SecretsManagerClient({});
const apiRoot = "https://api.greenpixie.com";
const outputKey = "data/emissions.json";

interface RunEvent {
  gridPeriod?: string;
}

interface RateCardRecord {
  rate_code?: string;
  pricing_unit?: string;
  total_tonnes_co2e_per_pricing_unit?: number | string | null;
  version?: string;
}

interface RateCardPage {
  columns?: string[];
  records?: Array<RateCardRecord | unknown[]>;
  links?: { next?: string | null };
}

function previousMonth(): string {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7);
}

async function getApiKey(): Promise<string> {
  const result = await secrets.send(
    new GetSecretValueCommand({ SecretId: process.env.GREENPIXIE_SECRET_ARN }),
  );
  if (!result.SecretString)
    throw new Error("Greenpixie secret has no SecretString");
  try {
    return JSON.parse(result.SecretString).api_key ?? result.SecretString;
  } catch {
    return result.SecretString;
  }
}

async function getJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(`Greenpixie API returned HTTP ${response.status}`);
  return (await response.json()) as T;
}

function objectRecords(page: RateCardPage): RateCardRecord[] {
  return (page.records ?? []).map((row) => {
    if (!Array.isArray(row)) return row as RateCardRecord;
    return Object.fromEntries(
      (page.columns ?? []).map((column, index) => [column, row[index]]),
    ) as RateCardRecord;
  });
}

async function fetchRateCard(period: string, token: string) {
  const query = new URLSearchParams({ limit: "1000", grid_period: period });
  let nextUrl: string | null =
    `${apiRoot}/v1/ratecards/cloud/aws/full?${query}`;
  let version = "unknown";
  const rates = new Map<string, number | null>();

  while (nextUrl) {
    const url: URL = new URL(nextUrl);
    if (url.protocol !== "https:" || url.hostname !== "api.greenpixie.com") {
      throw new Error("Greenpixie pagination returned an unexpected URL");
    }
    const page = await getJson<RateCardPage>(url.toString(), token);
    for (const item of objectRecords(page)) {
      if (!item.rate_code || !item.pricing_unit) continue;
      const code = String(item.rate_code);
      const unit = String(item.pricing_unit);
      const key = joinKey(code, unit);
      if (rates.has(key))
        throw new Error(`Duplicate Greenpixie rate card key: ${code}/${unit}`);

      const rowVersion = String(item.version ?? version);
      if (rowVersion !== "unknown") version = rowVersion;
      const rawFactor = item.total_tonnes_co2e_per_pricing_unit;
      const factor = rawFactor == null ? null : Number(rawFactor);
      rates.set(
        key,
        factor !== null && Number.isFinite(factor) ? factor : null,
      );
    }
    nextUrl = page.links?.next
      ? new URL(page.links.next, apiRoot).toString()
      : null;
  }

  if (!rates.size) throw new Error("Greenpixie returned no rate-code rows");

  return { rates, version };
}

async function listCurObjects(
  period: string,
  bucket: string,
): Promise<Array<{ key: string; size: number }>> {
  const root = process.env.CUR_PREFIX!.replace(/^\/+|\/+$/g, "");
  const prefix = `${root ? `${root}/` : ""}data/BILLING_PERIOD=${period}/`;
  const objects: Array<{ key: string; size: number }> = [];
  let continuationToken: string | undefined;
  let totalBytes = 0;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
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

  const maxBytes = Number(process.env.MAX_CUR_BYTES ?? 67_108_864);
  if (totalBytes > maxBytes) {
    throw new Error(
      `CUR period is ${totalBytes} compressed bytes; Phase 0 limit is ${maxBytes}. Use the Athena-based Phase 1 pipeline for this export.`,
    );
  }
  if (!objects.length) {
    throw new Error(
      `No CSV CUR objects found under s3://${bucket}/${prefix}; Phase 0 requires CSV or CSV/GZIP, not Parquet.`,
    );
  }
  return objects;
}

async function* rowsFromObject(
  key: string,
  bucket: string,
): AsyncGenerator<CurRow> {
  const result = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (!result.Body) throw new Error(`S3 returned an empty body for ${key}`);
  const body = result.Body as Readable;
  const input = key.endsWith(".gz") ? body.pipe(createGunzip()) : body;
  const parser = parse({ columns: true, bom: true, skip_empty_lines: true });
  input.pipe(parser);
  for await (const row of parser) yield row as CurRow;
}

async function readHistory(): Promise<Record<string, unknown> | undefined> {
  try {
    const result = await s3.send(
      new GetObjectCommand({
        Bucket: process.env.EMISSIONS_BUCKET!,
        Key: outputKey,
      }),
    );
    if (!result.Body) return undefined;
    return JSON.parse(await result.Body.transformToString()) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if (error instanceof Error && error.name === "NoSuchKey") return undefined;
    throw error;
  }
}

export async function handler(event: RunEvent) {
  const period = event.gridPeriod ?? previousMonth();
  if (!/^\d{4}-\d{2}$/.test(period))
    throw new Error("gridPeriod must use YYYY-MM format");

  const curBucket =
    process.env.IS_DEMO === "true"
      ? process.env.DEMO_CUR_BUCKET!
      : process.env.CUR_BUCKET!;
  const objects = await listCurObjects(period, curBucket);
  const { rates, version } = await fetchRateCard(period, await getApiKey());

  /***
   *  This syntax is idiomatic for streaming rows via a generator.
   *  It has the benefit being not all rows are stored in memory at once.
   *  This is important for large CUR exports, which can be hundreds of
   *  MBs compressed and several GBs uncompressed.
   *  */
  const allRows = (async function* () {
    for (const object of objects) yield* rowsFromObject(object.key, curBucket);
  })();

  const { totals, matchedRows } = await aggregateRows(allRows, rates);
  const history = mergeHistory(await readHistory(), period, totals, version);

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.EMISSIONS_BUCKET!,
      Key: outputKey,
      Body: JSON.stringify(history),
      ContentType: "application/json",
      CacheControl: "no-store",
    }),
  );

  console.info(
    JSON.stringify({
      period,
      objects: objects.length,
      compressedBytes: objects.reduce((sum, object) => sum + object.size, 0),
      matchedRows,
      services: totals.size,
    }),
  );
  return {
    published: true,
    period,
    services: totals.size,
    periods: history.periods.length,
  };
}

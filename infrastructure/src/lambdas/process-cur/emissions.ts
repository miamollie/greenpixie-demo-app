import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface CurRow {
  pricing_rate_code?: string;
  pricing_unit?: string;
  line_item_usage_amount?: string;
  line_item_product_code?: string;
}

export interface EmissionsHistory {
  schema_version: number;
  dataset: string;
  generated_at?: string;
  unit?: string;
  period?: string;
  periods: string[];
  series: Array<{ id: string; label: string; values: number[] }>;
  methodology?: string;
  methodology_version?: string;
}

export const joinKey = (rateCode: string, unit: string) =>
  `${rateCode}\u0000${unit}`;

export class Emissions {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    private readonly key = "data/emissions.json",
  ) {}

  async publish(
    rows: AsyncIterable<CurRow>,
    period: string,
    rates: Map<string, number | null>,
    methodologyVersion: string,
  ) {
    const { totals, matchedRows } = await Emissions.calculateRows(rows, rates);
    const history = Emissions.mergeHistory(
      await this.readHistory(),
      period,
      totals,
      methodologyVersion,
    );
    await this.writeHistory(history);
    return { history, totals, matchedRows };
  }

  static async calculateRows(
    rows: AsyncIterable<CurRow>,
    rates: Map<string, number | null>,
  ): Promise<{ totals: Map<string, number>; matchedRows: number }> {
    const totals = new Map<string, number>();
    const unmatched = new Set<string>();
    let matchedRows = 0;

    for await (const row of rows) {
      const rateCode = row.pricing_rate_code?.trim();
      if (!rateCode) continue;

      const unit = row.pricing_unit?.trim() || "unspecified";
      const factor = rates.get(joinKey(rateCode, unit));
      const usage = Number(row.line_item_usage_amount || 0);
      if (factor === undefined || factor === null || !Number.isFinite(usage)) {
        unmatched.add(`${rateCode}/${unit}`);
        continue;
      }

      const service = row.line_item_product_code?.trim() || "Unknown";
      totals.set(service, (totals.get(service) ?? 0) + usage * factor * 1000);
      matchedRows += 1;
    }

    if (unmatched.size) {
      const sample = [...unmatched].slice(0, 5).join(", ");
      throw new Error(
        `${unmatched.size} CUR rate-code/unit keys did not match a Greenpixie factor; sample: ${sample}`,
      );
    }
    if (!matchedRows) throw new Error("No CUR rows matched Greenpixie factors");
    return { totals, matchedRows };
  }

  static mergeHistory(
    existing: Partial<EmissionsHistory> | undefined,
    period: string,
    totals: Map<string, number>,
    methodologyVersion: string,
  ): EmissionsHistory {
    const oldPeriods =
      existing?.dataset === "demo" ? [] : (existing?.periods ?? []);
    const oldSeries =
      existing?.dataset === "demo" ? [] : (existing?.series ?? []);
    const periods = [...new Set([...oldPeriods, period])].sort();
    const services = new Map<
      string,
      { id: string; label: string; values: number[] }
    >();

    for (const item of oldSeries) {
      const oldValues = item.values ?? [];
      services.set(item.label, {
        id: item.id,
        label: item.label,
        values: periods.map((month) => {
          const index = oldPeriods.indexOf(month);
          return index >= 0 ? (oldValues[index] ?? 0) : 0;
        }),
      });
    }

    for (const [label, value] of totals) {
      const series = services.get(label) ?? {
        id: label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, ""),
        label,
        values: Array(periods.length).fill(0),
      };
      series.values[periods.indexOf(period)] = Number(value.toFixed(6));
      services.set(label, series);
    }

    return {
      schema_version: 1,
      dataset: "greenpixie",
      generated_at: new Date().toISOString(),
      unit: "kgCO2e",
      period: "month",
      periods,
      series: [...services.values()].sort((a, b) =>
        a.label.localeCompare(b.label),
      ),
      methodology: `Estimated from AWS CUR usage and Greenpixie rate-card factors for ${period} (methodology ${methodologyVersion}); not a direct energy measurement.`,
      methodology_version: methodologyVersion,
    };
  }

  private async readHistory(): Promise<
    Record<string, unknown> | undefined
  > {
    try {
      const result = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key }),
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

  private async writeHistory(history: EmissionsHistory): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
        Body: JSON.stringify(history),
        ContentType: "application/json",
        CacheControl: "no-store",
      }),
    );
  }
}
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

const joinKey = (rateCode: string, unit: string) => `${rateCode}\u0000${unit}`;

export async function aggregateRows(
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
    const key = joinKey(rateCode, unit);
    const factor = rates.get(key);
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

export function mergeHistory(
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

export { joinKey };

import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateRows, joinKey, mergeHistory } from "./logic";

async function* rows(items: Array<Record<string, string>>) {
  yield* items;
}

test("joins rate code and unit and converts tonnes to kilograms", async () => {
  const result = await aggregateRows(
    rows([
      {
        pricing_rate_code: "sku.term.price",
        pricing_unit: "Hrs",
        line_item_usage_amount: "2",
        line_item_product_code: "AmazonEC2",
      },
      {
        pricing_rate_code: "sku.term.price",
        pricing_unit: "Hrs",
        line_item_usage_amount: "1",
        line_item_product_code: "AmazonEC2",
      },
    ]),
    new Map([[joinKey("sku.term.price", "Hrs"), 0.0002]]),
  );

  assert.equal(result.matchedRows, 2);
  assert.ok(Math.abs((result.totals.get("AmazonEC2") ?? 0) - 0.6) < 1e-10);
});

test("fails when a coded CUR row has no matching factor", async () => {
  await assert.rejects(
    aggregateRows(
      rows([
        {
          pricing_rate_code: "unknown",
          pricing_unit: "Hrs",
          line_item_usage_amount: "1",
          line_item_product_code: "AmazonEC2",
        },
      ]),
      new Map(),
    ),
    /did not match a Greenpixie factor/,
  );
});

test("adds a period without losing previous emissions", () => {
  const merged = mergeHistory(
    {
      schema_version: 1,
      dataset: "greenpixie",
      periods: ["2026-09"],
      series: [{ id: "amazon-ec2", label: "AmazonEC2", values: [1.5] }],
    },
    "2026-10",
    new Map([["AmazonEC2", 2.5]]),
    "meth-v5",
  );

  assert.deepEqual(merged.periods, ["2026-09", "2026-10"]);
  assert.deepEqual(merged.series[0].values, [1.5, 2.5]);
});

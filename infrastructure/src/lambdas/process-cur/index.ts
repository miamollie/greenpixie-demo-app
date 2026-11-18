import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { CurClient } from "./cur-client";
import { Emissions } from "./emissions";
import { GreenpixieClient } from "./greenpixie-client";

interface RunEvent {
  gridPeriod?: string;
}

function previousMonth(): string {
  const date = new Date();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 1);
  return date.toISOString().slice(0, 7);
}

const curBucket =
  process.env.IS_DEMO === "true"
    ? process.env.DEMO_CUR_BUCKET!
    : process.env.CUR_BUCKET!;
const s3 = new S3Client({ region: process.env.AWS_REGION });
const curClient = new CurClient(
  s3,
  curBucket,
  process.env.CUR_PREFIX ?? "",
  Number(process.env.MAX_CUR_BYTES ?? 67_108_864),
);
const greenpixieClient = new GreenpixieClient(
  new SecretsManagerClient({}),
  process.env.GREENPIXIE_SECRET_ARN!,
);
const emissions = new Emissions(s3, process.env.EMISSIONS_BUCKET!);

export async function handler(event: RunEvent) {
  const period = event.gridPeriod ?? previousMonth();
  if (!/^\d{4}-\d{2}$/.test(period))
    throw new Error("gridPeriod must use YYYY-MM format");

  const objects = await curClient.listObjects(period);
  const { rates, version } = await greenpixieClient.fetchRateCard(period);
  const { totals, matchedRows, history } = await emissions.publish(
    curClient.readRows(objects),
    period,
    rates,
    version,
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

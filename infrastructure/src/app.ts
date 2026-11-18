import * as cdk from "aws-cdk-lib";
import { CarbonProcessingStack } from "./processing-stack";
import { CarbonVisualiserStack } from "./visualisation-stack";

const app = new cdk.App();
const env = {
  account:
    process.env.AWS_ACCOUNT_ID ??
    process.env.CDK_DEFAULT_ACCOUNT ??
    "000000000000",
  region:
    process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? "eu-north-1",
};

new CarbonVisualiserStack(app, "CarbonVisualiserStack", {
  env,
  siteDomainName: process.env.SITE_DOMAIN_NAME,
  cloudFrontCertificateArn: process.env.CLOUDFRONT_CERTIFICATE_ARN,
});

const processingConfigKeys = [
  "EMISSIONS_BUCKET_NAME",
  "CUR_BUCKET_NAME",
  "CUR_DATA_PREFIX",
  "GREENPIXIE_SECRET_ARN",
];

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

if (
  process.env.CDK_PROCESSING_STACK === "true" ||
  processingConfigKeys.some((name) => process.env[name])
) {
  new CarbonProcessingStack(app, "CarbonProcessingStack", {
    env,
    emissionsBucketName: requireEnv("EMISSIONS_BUCKET_NAME"),
    curBucketName: requireEnv("CUR_BUCKET_NAME"),
    curDataPrefix: requireEnv("CUR_DATA_PREFIX"),
    maxCurBytes: process.env.CUR_MAX_BYTES ?? "67108864",
    greenpixieSecretArn: requireEnv("GREENPIXIE_SECRET_ARN"),
    isDemo: process.env.IS_DEMO === "true",
  });
}

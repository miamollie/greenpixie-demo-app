import * as cdk from "aws-cdk-lib";
import { CarbonProcessingStack } from "./processing-stack";
import { CarbonVisualiserStack } from "./visualisation-stack";

const app = new cdk.App();
const env = {
  account: "424795685451",
  region:
    process.env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION ?? "eu-north-1",
};

new CarbonVisualiserStack(app, "CarbonVisualiserStack", {
  env,
  siteDomainName: process.env.SITE_DOMAIN_NAME,
  cloudFrontCertificateArn: process.env.CLOUDFRONT_CERTIFICATE_ARN,
});

new CarbonProcessingStack(app, "CarbonProcessingStack", { env });

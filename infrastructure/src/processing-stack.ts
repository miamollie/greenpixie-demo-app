import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export class CarbonProcessingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const emissionsBucketName = new cdk.CfnParameter(
      this,
      "EmissionsBucketName",
      {
        type: "String",
        description:
          "Existing private emissions bucket from the Carbon Visualiser site stack.",
      },
    );
    const curBucketName = new cdk.CfnParameter(this, "CurBucketName", {
      type: "String",
      description: "S3 bucket receiving the AWS CUR 2.0 Data Export.",
    });
    const curPrefix = new cdk.CfnParameter(this, "CurDataPrefix", {
      type: "String",
      description:
        "CUR export prefix ending immediately before /data/BILLING_PERIOD=YYYY-MM/.",
    });
    const maxCurBytes = new cdk.CfnParameter(this, "MaxCurBytes", {
      type: "Number",
      default: 67108864,
      description:
        "Maximum combined compressed CSV size for one billing period (default 64 MiB).",
    });
    const greenpixieSecretArn = new cdk.CfnParameter(
      this,
      "GreenpixieApiKeySecretArn",
      {
        type: "String",
        description:
          "Secrets Manager secret ARN in eu-north-1. SecretString may be the key or JSON containing api_key.",
        noEcho: true,
      },
    );

    const rateCardBucket = new s3.Bucket(this, "RateCardBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        { prefix: "snapshots/", expiration: cdk.Duration.days(1825) },
      ],
    });

    const processor = new nodejs.NodejsFunction(this, "ProcessCurAndPublish", {
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: path.resolve(__dirname, "../src/lambdas/process-cur/index.ts"),
      handler: "handler",
      timeout: cdk.Duration.minutes(14),
      memorySize: 2048,
      reservedConcurrentExecutions: 1,
      bundling: { minify: true, sourceMap: false },
      environment: {
        CUR_BUCKET: curBucketName.valueAsString,
        CUR_PREFIX: curPrefix.valueAsString,
        MAX_CUR_BYTES: maxCurBytes.valueAsString,
        RATE_CARD_BUCKET: rateCardBucket.bucketName,
        EMISSIONS_BUCKET: emissionsBucketName.valueAsString,
        GREENPIXIE_SECRET_ARN: greenpixieSecretArn.valueAsString,
      },
    });

    rateCardBucket.grantReadWrite(processor);
    processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [greenpixieSecretArn.valueAsString],
      }),
    );

    const curArn = `arn:${this.partition}:s3:::${curBucketName.valueAsString}`;
    processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetBucketLocation", "s3:ListBucket"],
        resources: [curArn],
      }),
    );
    processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [
          `${curArn}/${curPrefix.valueAsString}/data/BILLING_PERIOD=*/*`,
        ],
      }),
    );
    processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [
          `arn:${this.partition}:s3:::${emissionsBucketName.valueAsString}/data/emissions.json`,
        ],
      }),
    );

    new events.Rule(this, "MonthlyProcessingSchedule", {
      description:
        "Process the previous month after Greenpixie's monthly rate-card refresh.",
      schedule: events.Schedule.cron({ minute: "0", hour: "8", day: "4" }),
      targets: [new targets.LambdaFunction(processor)],
    });

    new cdk.CfnOutput(this, "ProcessingLambdaName", {
      value: processor.functionName,
    });
    new cdk.CfnOutput(this, "RateCardBucketName", {
      value: rateCardBucket.bucketName,
    });
  }
}

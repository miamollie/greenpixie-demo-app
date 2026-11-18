import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export interface CarbonProcessingStackProps extends cdk.StackProps {
  emissionsBucketName: string;
  curBucketName: string;
  curDataPrefix: string;
  maxCurBytes: string;
  greenpixieSecretArn: string;
  isDemo?: boolean;
}

export class CarbonProcessingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: CarbonProcessingStackProps) {
    super(scope, id, props);

    const {
      emissionsBucketName,
      curBucketName,
      curDataPrefix,
      maxCurBytes,
      greenpixieSecretArn,
      isDemo = false,
    } = props;

    const demoDataBucket = new s3.Bucket(this, "DemoDataBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
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
        CUR_BUCKET: curBucketName,
        CUR_PREFIX: curDataPrefix,
        MAX_CUR_BYTES: maxCurBytes,
        DEMO_CUR_BUCKET: demoDataBucket.bucketName,
        IS_DEMO: String(isDemo),
        EMISSIONS_BUCKET: emissionsBucketName,
        GREENPIXIE_SECRET_ARN: greenpixieSecretArn,
      },
    });

    if (isDemo) {
      demoDataBucket.grantRead(processor);
    } else {
      const curArn = `arn:${this.partition}:s3:::${curBucketName}`;
      processor.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["s3:GetBucketLocation", "s3:ListBucket"],
          resources: [curArn],
        }),
      );
      processor.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["s3:GetObject"],
          resources: [`${curArn}/${curDataPrefix}/data/BILLING_PERIOD=*/*`],
        }),
      );
    }

    processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [greenpixieSecretArn],
      }),
    );

    processor.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [
          `arn:${this.partition}:s3:::${emissionsBucketName}/data/emissions.json`,
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
    new cdk.CfnOutput(this, "DemoDataBucketName", {
      value: demoDataBucket.bucketName,
    });
  }
}

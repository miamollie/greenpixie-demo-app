# Carbon Visualiser 🌱

A little experiment in making cloud carbon emissions more visible.

This project uses the [Greenpixie API](https://greenpixie.com/) to enrich AWS Cost and Usage Report (CUR) data with emissions factors, then turns the results into a simple dashboard.

The idea is straightforward: **make cloud-carbon data visible, explore what it tells us, and give people something concrete to start a GreenOps conversation with.**

It's a demonstration project, not a production-ready carbon-accounting pipeline. You can run it with the supplied sample data or connect it to your own AWS usage data.

## 👋 Who's this for?

This is for the **eco-curious engineer**: someone interested in cloud sustainability who might not work in GreenOps or FinOps day to day.

Perhaps you:

- are curious about what cloud emissions data actually looks like;
- would like to show your team what cloud-carbon visibility could look like;
- are looking for a small, tangible way to advocate for GreenOps in your organisation.

Some familiarity with the following will help, but aren't required:

- AWS accounts, IAM and the AWS CLI;
- S3 and basic AWS billing concepts;
- Cost and Usage Reports (CUR);
- Node.js/npm and TypeScript if you want to explore or modify the code;
- AWS CDK if you want to deploy or change the infrastructure.


## ⚡ Quickstart

Want see what you'll be doing? Here's the journey:

1. Clone the repo — get the project onto your machine.
2. Get a Greenpixie API key — you'll need this to retrieve emissions data.
3. Choose your data source — use the supplied demo data or configure your own AWS CUR export.
4. Configure your environment — set up your AWS credentials and project configuration.
5. Deploy the stacks — get the website and processing pipeline running.
6. Run a processing job — manually trigger the pipeline for a billing period to generate emissions data.
7. Explore your dashboard — check out the live site and see what your cloud emissions look like.

The detailed instructions are below. If you're interested in the implementation choices, see [Architecture and design decisions](./docs/architecture.md).



## 🔍 What does it do?

The application brings together two data sources:

1. **AWS CUR data** — what services and resources your account has been using.
2. **Greenpixie rate-card data** — emissions factors associated with that cloud usage.

A small processing pipeline joins the two datasets, calculates emissions and produces a JSON file for the dashboard.

The JSON file will grow monthly as new emissions data are generated.

```text
AWS CUR ──────────────┐
                      ├──> Processing Lambda ──> emissions.json ──> Dashboard
Greenpixie Rate Card ─┘
```

The dashboard currently shows emissions trends over time, broken down by service.

One important caveat: a change in emissions isn't necessarily a change in usage. It could also reflect changes in the underlying emissions factors. The current visualisation shows the trend but doesn't attempt to attribute the cause.

## 🚀 Try it out

There are two ways to experiment with the project.

### Option 1: Use the supplied demo data

The quickest route. You can deploy the application and run the processing pipeline with sample AWS usage data, without having to configure a real CUR export.

This is a good starting point if you want to:

- see the dashboard working;
- understand how the Greenpixie data is used;
- create a small demonstration for your team;
- explore the possibilities before committing to a larger integration.

You'll still need a Greenpixie API key, because the processing pipeline retrieves the rate card from Greenpixie.

### Option 2: Use your own AWS data

If you already have an AWS CUR export, you can point the processing pipeline at your own data.

The MVP expects CUR 2.0 exported as CSV with GZIP compression. It processes one billing month at a time.

For larger-scale use, Greenpixie recommends Parquet in its CUR export guidance. This project deliberately uses CSV/GZIP to keep the demonstration infrastructure simple.

See:
- [Greenpixie's AWS CUR export guide](https://greenpixie.com/docs/guides/cloud-usage-data/aws)
- [Greenpixie's CUR enrichment guide](https://greenpixie.com/docs/guides/enrich-cur-api)

## 🔑 Get your Greenpixie API key

The processing pipeline calls the Greenpixie API to retrieve the rate card used to enrich the AWS usage data.

You'll need a Greenpixie account and an API key before deploying the processing stack.

- Start with the [Greenpixie website](https://greenpixie.com/).
- Explore the Greenpixie Data Explorer and its API.
- Follow the Greenpixie API documentation to create or retrieve an API key.

**API key instructions:** [Add the direct link to the current API-key instructions.]

Keep your API key secret. This application stores it in AWS Secrets Manager and uses it server-side; it is never included in the browser application. If you've cloned this repo, don't commit the API key. 

## 🧰 Run it yourself

### Prerequisites

You'll need:

- an AWS account and configured CLI credentials;
- Node.js and npm;
- AWS CDK;
- a Greenpixie API key.

The examples below use `eu-north-1`. Replace `PROFILE` with your AWS CLI profile, or omit `--profile PROFILE` if you're using your default credentials.

### 1. Install dependencies and bootstrap CDK

```sh
cd infrastructure
npm install

npx cdk bootstrap aws://ACCOUNT_ID/eu-north-1 --profile PROFILE
```

### 2. Configure the environment

Copy `.env.dev` to `.env` in the `infrastructure` directory and replace the `YOUR_...` placeholders.

The `.env` file is gitignored and contains environment-specific configuration used by both stacks.

### 3. Deploy the website

```sh
npm run deploy:site -- --profile PROFILE
```

The deployment creates the static site and its separate emissions-data bucket.

Retrieve the emissions bucket name:

```sh
aws cloudformation describe-stacks \
  --stack-name CarbonVisualiserStack \
  --region eu-north-1 \
  --profile PROFILE \
  --query "Stacks[0].Outputs[?OutputKey=='EmissionsBucketName'].OutputValue | [0]" \
  --output text
```

Keep the bucket name handy.

### 4. Configure your data source

**For your own AWS data:** configure AWS Data Export / CUR 2.0 to export CSV with GZIP compression. Set `CUR_DATA_PREFIX` in your environment configuration to the path immediately before:

```text
/data/BILLING_PERIOD=YYYY-MM/
```

For example:

```text
billing/greenpixie-cur2
```

**For the supplied demo data:** set `IS_DEMO=true` in your environment configuration. You'll upload the sample data to the demo bucket in step 7.

### 5. Store your Greenpixie API key

Create a secret in AWS Secrets Manager:

```sh
printf 'Greenpixie API key: '
read -r -s GREENPIXIE_API_KEY
printf '\n'

printf '%s' "$GREENPIXIE_API_KEY" | aws secretsmanager create-secret \
  --name greenpixie-api-key \
  --secret-string file:///dev/stdin \
  --region eu-north-1 \
  --query ARN \
  --output text

unset GREENPIXIE_API_KEY
```

Copy the returned ARN into `GREENPIXIE_SECRET_ARN` in `infrastructure/.env`.

If the secret already exists, update it with `put-secret-value` rather than creating it again.

### 6. Deploy the processing stack

```sh
npm run deploy:processing -- --profile PROFILE
```

### 7. Upload the sample data (demo mode only)

If you're using the supplied demo data, upload it to the demo bucket created by the processing stack:

```sh
aws s3 cp ../dummy-data/sample_aws_usage_data.csv.gz \
  "s3://<DEMO_BUCKET_NAME>/<CUR_DATA_PREFIX>/data/BILLING_PERIOD=<YYYY-MM>/sample_aws_usage_data.csv.gz" \
  --region eu-north-1
```

Replace the placeholders with the bucket name, CUR prefix and billing period you are using.

The billing period in the S3 path must match the period you ask the Lambda to process.

### 8. Run a processing job

Once the data is in place, manually invoke the processing Lambda for a completed billing period:

```sh
aws lambda invoke \
  --function-name PROCESSING_LAMBDA_NAME \
  --region eu-north-1 \
  --profile PROFILE \
  --cli-binary-format raw-in-base64-out \
  --payload '{"gridPeriod":"2026-10"}' \
  /tmp/carbon-processing-result.json

cat /tmp/carbon-processing-result.json
```

Replace `PROCESSING_LAMBDA_NAME` with the deployed function name.

If processing succeeds, the Lambda writes the generated `emissions.json` to the emissions bucket. The website retrieves that file through CloudFront.

The scheduled job runs on the 4th of each month, after Greenpixie's previous-month rate-card refresh. Manual invocation is useful for testing and rerunning a period.

## 📝 A few things to know

- **Monthly cadence:** the MVP processes one billing month at a time.
- **Data format:** it currently supports CSV and CSV/GZIP, not Parquet.
- **Processing limits:** the Lambda has a 14-minute timeout, 4 GiB memory and a default 64 MiB compressed-input limit.
- **Emissions trends:** the dashboard doesn't yet distinguish changes in usage from changes in emissions factors.
- **Historical reproducibility:** the MVP doesn't yet preserve a complete versioned history of source data and rate-card snapshots.

These are deliberate boundaries for a small demonstration. See [Architecture and design decisions](docs/architecture.md) for the reasoning, alternatives and possible production evolution.

## 🌍 A note on the website's own footprint

The repository also includes `site/carbon.txt`, which links to `site/data/site-footprint.json`.

This is a separate placeholder for estimating the footprint associated with page views of the visualisation itself. It is not part of the Greenpixie AWS-account emissions data.

## 📚 Further reading

- [Greenpixie](https://greenpixie.com/)
- [Greenpixie AWS CUR export guide](https://greenpixie.com/docs/guides/cloud-usage-data/aws)
- [Greenpixie CUR enrichment guide](https://greenpixie.com/docs/guides/enrich-cur-api)
- [Greenpixie CloudHealth integration guide](https://greenpixie.com/docs/guides/cloudhealth-integration-aws)
- [Architecture and design decisions](docs/architecture.md)

Have a play, see what you discover, and use it to start a conversation about making cloud sustainability a little more visible. 🌱
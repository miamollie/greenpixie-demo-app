import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

export interface CarbonVisualiserStackProps extends cdk.StackProps {
  siteDomainName?: string;
  cloudFrontCertificateArn?: string;
}

export class CarbonVisualiserStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    props?: CarbonVisualiserStackProps,
  ) {
    super(scope, id, props);

    const siteDomainName = props?.siteDomainName;
    const cloudFrontCertificateArn = props?.cloudFrontCertificateArn;
    if (Boolean(siteDomainName) !== Boolean(cloudFrontCertificateArn)) {
      throw new Error(
        "Set both siteDomainName and cloudFrontCertificateArn to configure a custom domain.",
      );
    }
    if (
      cloudFrontCertificateArn &&
      !cloudFrontCertificateArn.includes(":acm:us-east-1:")
    ) {
      throw new Error("CloudFront certificates must be issued in us-east-1.");
    }

    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    });
    const emissionsBucket = new s3.Bucket(this, "EmissionsBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
    });

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(
      this,
      "SiteSecurityHeaders",
      {
        securityHeadersBehavior: {
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy:
              cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(730),
            includeSubdomains: true,
            preload: true,
            override: true,
          },
          contentSecurityPolicy: {
            contentSecurityPolicy:
              "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
            override: true,
          },
        },
      },
    );

    const siteOrigin = S3BucketOrigin.withOriginAccessControl(siteBucket);
    const emissionsOrigin =
      S3BucketOrigin.withOriginAccessControl(emissionsBucket);
    const distribution = new cloudfront.Distribution(this, "SiteDistribution", {
      defaultRootObject: "index.html",
      enabled: true,
      httpVersion: cloudfront.HttpVersion.HTTP2,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      ...(siteDomainName && cloudFrontCertificateArn
        ? {
            domainNames: [siteDomainName],
            certificate: acm.Certificate.fromCertificateArn(
              this,
              "SiteCertificate",
              cloudFrontCertificateArn,
            ),
          }
        : {}),
      defaultBehavior: {
        origin: siteOrigin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
      },
      additionalBehaviors: {
        "data/emissions.json": {
          origin: emissionsOrigin,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          responseHeadersPolicy: securityHeaders,
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          compress: true,
        },
      },
    });

    new s3deploy.BucketDeployment(this, "DeploySite", {
      sources: [s3deploy.Source.asset(path.resolve(__dirname, "../../site"))],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
      prune: true,
    });

    new cdk.CfnOutput(this, "SiteUrl", {
      description: "Public HTTPS URL for the visualiser.",
      value: `https://${siteDomainName ?? distribution.distributionDomainName}`,
    });
    new cdk.CfnOutput(this, "CloudFrontDomainName", {
      description: "CloudFront hostname used as the custom-domain DNS target.",
      value: distribution.distributionDomainName,
    });
    new cdk.CfnOutput(this, "SiteBucketName", {
      description: "Private bucket containing the deployed static site.",
      value: siteBucket.bucketName,
    });
    new cdk.CfnOutput(this, "EmissionsBucketName", {
      description:
        "Private bucket containing generated public-safe emissions data.",
      value: emissionsBucket.bucketName,
    });
    new cdk.CfnOutput(this, "DistributionId", {
      description: "CloudFront distribution ID.",
      value: distribution.distributionId,
    });
  }
}

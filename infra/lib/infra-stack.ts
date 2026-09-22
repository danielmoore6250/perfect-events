import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';import { execSync } from 'child_process';import { Construct } from 'constructs';

// ACM certificate for the custom domain. Must live in us-east-1 for CloudFront.
// Created/validated out-of-band via Route53 DNS validation (see cutover notes).
const SITE_CERT_ARN =
  'arn:aws:acm:us-east-1:091869720829:certificate/76dcffc5-760a-4592-9098-ba0245d99cde';
const SITE_DOMAINS = ['perfecteventsni.com', 'www.perfecteventsni.com'];

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // S3 bucket for static website hosting
    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      bucketName: 'perfect-events-ni-site',
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'index.html',
      publicReadAccess: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        ignorePublicAcls: false,
        blockPublicPolicy: false,
        restrictPublicBuckets: false,
      }),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Custom domain certificate (imported; validated via Route53 DNS).
    const siteCertificate = acm.Certificate.fromCertificateArn(
      this,
      'SiteCertificate',
      SITE_CERT_ARN
    );

    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: 'Perfect Events NI',
      domainNames: SITE_DOMAINS,
      certificate: siteCertificate,
      defaultBehavior: {
        origin: new origins.HttpOrigin(
          `${websiteBucket.bucketName}.s3-website-${this.region}.amazonaws.com`,
          { protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY }
        ),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: 'index.html',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      errorResponses: [
        {
          httpStatus: 404,
          responsePagePath: '/index.html',
          responseHttpStatus: 200,
          ttl: cdk.Duration.minutes(5),
        },
      ],
    });

    // DynamoDB table holding one record per enquiry/booking.
    // RETAIN so booking history survives a stack delete; on-demand billing keeps
    // the cost proportional to the handful of enquiries that actually arrive.
    const bookingsTable = new dynamodb.Table(this, 'BookingsTable', {
      tableName: 'perfect-events-bookings',
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // Lets the admin screen list every booking in event-date order without a
    // full table scan: every record carries recordType = 'booking'.
    bookingsTable.addGlobalSecondaryIndex({
      indexName: 'ByEventDate',
      partitionKey: { name: 'recordType', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'eventDate', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Lambda function for sending enquiries
    const lambdaDir = path.join(__dirname, '../../aws/lambda/send-enquiry');

    const sendEnquiryFn = new lambda.Function(this, 'SendEnquiryFunction', {
      functionName: 'perfect-events-send-enquiry',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(lambdaDir, {
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          local: {
            tryBundle(outputDir: string) {
              execSync(`cp -r ${lambdaDir}/* ${outputDir}/ && cd ${outputDir} && npm ci --omit=dev`);
              return true;
            },
          },
          command: ['echo', 'Docker fallback not needed'],
        },
      }),
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      environment: {
        BOOKINGS_TABLE: bookingsTable.tableName,
      },
      // Email is sent via Amazon SES using this Lambda's IAM role — no credentials needed.
    });

    // Allow the enquiry Lambda to send email through SES (verified domain: perfecteventsni.com)
    sendEnquiryFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail', 'ses:SendRawEmail'],
      resources: ['*'],
    }));

    // The enquiry Lambda only ever creates records — no read, update or delete.
    sendEnquiryFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem'],
      resources: [bookingsTable.tableArn],
    }));

    // HTTP API Gateway
    const httpApi = new apigatewayv2.HttpApi(this, 'HttpApi', {
      apiName: 'perfect-events-api',
      corsPreflight: {
        allowHeaders: ['content-type'],
        allowMethods: [apigatewayv2.CorsHttpMethod.POST, apigatewayv2.CorsHttpMethod.OPTIONS],
        allowOrigins: ['*'],
      },
    });

    httpApi.addRoutes({
      path: '/send-enquiry',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('SendEnquiryIntegration', sendEnquiryFn),
    });

    // Deploy React build to S3
    new s3deploy.BucketDeployment(this, 'DeployWebsite', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../../build'))],
      destinationBucket: websiteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    // Outputs
    new cdk.CfnOutput(this, 'WebsiteBucketName', {
      value: websiteBucket.bucketName,
    });

    new cdk.CfnOutput(this, 'CloudFrontUrl', {
      value: `https://${distribution.distributionDomainName}`,
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: distribution.distributionId,
    });

    new cdk.CfnOutput(this, 'BookingsTableName', {
      value: bookingsTable.tableName,
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: `${httpApi.apiEndpoint}/send-enquiry`,
    });
  }
}

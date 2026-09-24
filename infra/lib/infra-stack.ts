import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { HttpUserPoolAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { execSync } from 'child_process';
import { Construct } from 'constructs';

// ACM certificate for the custom domain. Must live in us-east-1 for CloudFront.
// Created/validated out-of-band via Route53 DNS validation (see cutover notes).
const SITE_CERT_ARN =
  'arn:aws:acm:us-east-1:091869720829:certificate/76dcffc5-760a-4592-9098-ba0245d99cde';
const SITE_DOMAINS = ['perfecteventsni.com', 'www.perfecteventsni.com'];

// The one admin login. Override with `cdk deploy -c adminEmail=someone@example.com`.
// Cognito emails a temporary password to this address on first deploy.
const DEFAULT_ADMIN_EMAIL = 'enquiries@perfecteventsni.com';

// Bundles a plain Node Lambda from aws/lambda/<name>: copies the source and
// installs production dependencies. No Docker needed.
const nodeLambdaCode = (name: string): lambda.Code => {
  const dir = path.join(__dirname, '../../aws/lambda', name);
  return lambda.Code.fromAsset(dir, {
    bundling: {
      image: lambda.Runtime.NODEJS_20_X.bundlingImage,
      local: {
        tryBundle(outputDir: string) {
          execSync(
            `cp -r ${dir}/* ${outputDir}/ && rm -rf ${outputDir}/test && cd ${outputDir} && npm ci --omit=dev`
          );
          return true;
        },
      },
      command: ['echo', 'Docker fallback not needed'],
    },
  });
};

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

    // Lets the public planning form find a booking by its private link token.
    // Sparse: only bookings that have been given a link carry planningToken.
    bookingsTable.addGlobalSecondaryIndex({
      indexName: 'ByPlanningToken',
      partitionKey: { name: 'planningToken', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Lambda function for sending enquiries
    const sendEnquiryFn = new lambda.Function(this, 'SendEnquiryFunction', {
      functionName: 'perfect-events-send-enquiry',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: nodeLambdaCode('send-enquiry'),
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

    // ---- Admin: Cognito user pool with a single user ----------------------
    // Nobody can sign themselves up; the one user is created below and gets a
    // temporary password by email. RETAIN so a stack rebuild does not lock the
    // admin out or force a password reset.
    const adminEmail: string = this.node.tryGetContext('adminEmail') ?? DEFAULT_ADMIN_EMAIL;

    const adminUserPool = new cognito.UserPool(this, 'AdminUserPool', {
      userPoolName: 'perfect-events-admin',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      mfa: cognito.Mfa.OFF,
      userInvitation: {
        emailSubject: 'Your Perfect Events NI admin login',
        emailBody:
          'Your admin login for perfecteventsni.com/admin is {username} and your temporary password is {####}. ' +
          'You will be asked to choose a new password the first time you sign in.',
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // The React admin screen signs in with username + password directly against
    // Cognito (no hosted UI, no client secret, nothing extra in the bundle).
    const adminClient = adminUserPool.addClient('AdminWebClient', {
      userPoolClientName: 'perfect-events-admin-web',
      generateSecret: false,
      authFlows: { userPassword: true },
      preventUserExistenceErrors: true,
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
    });

    new cognito.CfnUserPoolUser(this, 'AdminUser', {
      userPoolId: adminUserPool.userPoolId,
      username: adminEmail,
      desiredDeliveryMediums: ['EMAIL'],
      userAttributes: [
        { name: 'email', value: adminEmail },
        { name: 'email_verified', value: 'true' },
      ],
    });

    // ---- Admin: bookings API Lambda --------------------------------------
    const adminBookingsFn = new lambda.Function(this, 'AdminBookingsFunction', {
      functionName: 'perfect-events-admin-bookings',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: nodeLambdaCode('admin-bookings'),
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        BOOKINGS_TABLE: bookingsTable.tableName,
        USER_POOL_ID: adminUserPool.userPoolId,
        USER_POOL_CLIENT_ID: adminClient.userPoolClientId,
      },
    });

    // Read and update only — the admin screen never deletes a booking.
    adminBookingsFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
      resources: [bookingsTable.tableArn],
    }));
    adminBookingsFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [`${bookingsTable.tableArn}/index/ByEventDate`],
    }));

    // ---- Calendar feed Lambda -------------------------------------------
    // Public route guarded only by the token in the URL, which is why the
    // Lambda can read but never write.
    const calendarFeedFn = new lambda.Function(this, 'CalendarFeedFunction', {
      functionName: 'perfect-events-calendar-feed',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: nodeLambdaCode('calendar-feed'),
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        BOOKINGS_TABLE: bookingsTable.tableName,
      },
    });
    calendarFeedFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:GetItem'],
      resources: [bookingsTable.tableArn],
    }));
    calendarFeedFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [`${bookingsTable.tableArn}/index/ByEventDate`],
    }));

    // ---- Client planning form Lambda ------------------------------------
    // Public, guarded by the per-booking token. Reads by token, writes only
    // the planning answers (and the resulting stage change), emails the
    // business on submission.
    const planningFormFn = new lambda.Function(this, 'PlanningFormFunction', {
      functionName: 'perfect-events-planning-form',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: nodeLambdaCode('planning-form'),
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        BOOKINGS_TABLE: bookingsTable.tableName,
      },
    });
    planningFormFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [`${bookingsTable.tableArn}/index/ByPlanningToken`],
    }));
    planningFormFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [bookingsTable.tableArn],
    }));
    planningFormFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ses:SendEmail'],
      resources: ['*'],
    }));

    // ---- Song search Lambda ---------------------------------------------
    // Public: searches Apple Music (key from Parameter Store, see
    // DEPLOYMENT.md) with Deezer as the no-key fallback. Reads nothing else.
    const appleMusicParamPrefix = '/perfect-events/apple-music';
    const musicSearchFn = new lambda.Function(this, 'MusicSearchFunction', {
      functionName: 'perfect-events-music-search',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: nodeLambdaCode('music-search'),
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      environment: {
        APPLE_MUSIC_PARAM_PREFIX: appleMusicParamPrefix,
      },
    });
    musicSearchFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter${appleMusicParamPrefix}/*`],
    }));

    // HTTP API Gateway
    const httpApi = new apigatewayv2.HttpApi(this, 'HttpApi', {
      apiName: 'perfect-events-api',
      corsPreflight: {
        allowHeaders: ['content-type', 'authorization'],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.PATCH,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ['*'],
      },
    });

    httpApi.addRoutes({
      path: '/send-enquiry',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('SendEnquiryIntegration', sendEnquiryFn),
    });

    // API Gateway checks the Cognito JWT before the Lambda ever runs.
    const adminAuthorizer = new HttpUserPoolAuthorizer('AdminAuthorizer', adminUserPool, {
      userPoolClients: [adminClient],
    });
    const adminIntegration = new integrations.HttpLambdaIntegration('AdminBookingsIntegration', adminBookingsFn);

    // Public: the ids the login screen needs. Nothing secret in there.
    httpApi.addRoutes({
      path: '/admin/config',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: adminIntegration,
    });

    httpApi.addRoutes({
      path: '/admin/bookings',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: adminIntegration,
      authorizer: adminAuthorizer,
    });

    httpApi.addRoutes({
      path: '/admin/bookings/{id}',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.PATCH],
      integration: adminIntegration,
      authorizer: adminAuthorizer,
    });

    httpApi.addRoutes({
      path: '/admin/bookings/{id}/planning-link',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: adminIntegration,
      authorizer: adminAuthorizer,
    });

    httpApi.addRoutes({
      path: '/admin/calendar',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: adminIntegration,
      authorizer: adminAuthorizer,
    });

    httpApi.addRoutes({
      path: '/admin/calendar/rotate',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: adminIntegration,
      authorizer: adminAuthorizer,
    });

    // Song search and playlist import for the planning form. Public, read-only,
    // and API Gateway's default throttling is the rate limit.
    const musicIntegration = new integrations.HttpLambdaIntegration('MusicSearchIntegration', musicSearchFn);
    httpApi.addRoutes({ path: '/music/search', methods: [apigatewayv2.HttpMethod.GET], integration: musicIntegration });
    httpApi.addRoutes({ path: '/music/playlist', methods: [apigatewayv2.HttpMethod.GET], integration: musicIntegration });

    // The client planning form: <api>/plan/<token>. Token is the credential.
    httpApi.addRoutes({
      path: '/plan/{token}',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('PlanningFormIntegration', planningFormFn),
    });

    // The subscribe URL: <api>/calendar/<token>.ics. No authorizer; the token
    // is the credential and the Lambda 404s on a mismatch.
    httpApi.addRoutes({
      path: '/calendar/{token}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new integrations.HttpLambdaIntegration('CalendarFeedIntegration', calendarFeedFn),
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

    new cdk.CfnOutput(this, 'AdminUserPoolId', {
      value: adminUserPool.userPoolId,
    });

    new cdk.CfnOutput(this, 'AdminUserPoolClientId', {
      value: adminClient.userPoolClientId,
    });
  }
}

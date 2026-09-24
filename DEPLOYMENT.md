# Deployment

Deploys run in GitHub Actions and assume an AWS role through OIDC, so no AWS keys
are ever stored in GitHub. This mirrors the setup used by the Irish dancing app.

| Workflow | File | Trigger | What it does |
| --- | --- | --- | --- |
| Deploy | `.github/workflows/deploy.yml` | Manual ("Run workflow" / `gh workflow run deploy.yml`) | Builds the React app and runs `cdk deploy`, which uploads `build/` to S3, invalidates CloudFront and updates the Lambda, API and DynamoDB table |
| PR Checks | `.github/workflows/pr-checks.yml` | Pull requests to `main`, and pushes to `main` | `npm ci`, Lambda handler tests, React build, infra type check, `cdk synth` |

Deploys never happen automatically on merge — you choose when to deploy.

## One-time AWS setup

All of this is in account `091869720829`, region `eu-west-1`.

### 1. GitHub OIDC provider

One provider serves the whole account, so if the Irish dancing app already deploys
this way, it exists and you can skip this step.

IAM → Identity providers → check for `token.actions.githubusercontent.com`. If it
is missing, add an OpenID Connect provider:

| Field | Value |
| --- | --- |
| Provider URL | `https://token.actions.githubusercontent.com` |
| Audience | `sts.amazonaws.com` |

### 2. Deploy role

IAM → Roles → Create role → Custom trust policy. Name it
`perfect-events-github-deploy`.

Trust policy — this is what limits the role to this one repository:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::091869720829:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:danielmoore6250/perfect-events:*"
        }
      }
    }
  ]
}
```

Permissions — attach this as an inline policy. The role itself can do almost
nothing: it can only assume the CDK bootstrap roles, which are what actually
deploy the stack. That keeps the blast radius small if the role is ever misused.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AssumeCdkBootstrapRoles",
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::091869720829:role/cdk-hnb659fds-*-091869720829-eu-west-1"
    },
    {
      "Sid": "ReadBootstrapVersion",
      "Effect": "Allow",
      "Action": "ssm:GetParameter",
      "Resource": "arn:aws:ssm:eu-west-1:091869720829:parameter/cdk-bootstrap/hnb659fds/version"
    }
  ]
}
```

`hnb659fds` is the default CDK bootstrap qualifier; this project does not override
it. The bootstrap roles already exist, since the stack deploys from your Mac today.

To tighten this later, replace the `sub` condition with
`repo:danielmoore6250/perfect-events:ref:refs/heads/main`, which stops the deploy
workflow running from any branch other than `main`.

### 3. GitHub secret

Repository → Settings → Secrets and variables → Actions → New repository secret:

| Name | Value |
| --- | --- |
| `AWS_ROLE_ARN` | `arn:aws:iam::091869720829:role/perfect-events-github-deploy` |

## Deploying

From the Actions tab, choose **Deploy** → Run workflow, or from a terminal:

```bash
gh workflow run deploy.yml -f branch=main
gh run watch
```

The stack outputs (CloudFront URL, API endpoint, bookings table name) are printed
at the end of the run.

## Deploying from your Mac

`./infra/deploy.sh` still works and does the same thing with your local AWS
credentials. Useful if GitHub Actions is unavailable, but the workflow is the
normal route so that every deploy is traceable to a run.

## Apple Music key (song search)

The planning form's song search uses Apple Music when a MusicKit key is in
Parameter Store, and Deezer otherwise. Nothing needs redeploying when the key is
added; the Lambda picks it up on its next cold start.

1. Apple Developer portal → Certificates, Identifiers & Profiles → Keys → **+**.
   Name it, tick **MusicKit**, continue, register, download the `.p8` file. It can
   only be downloaded once. Note the **Key ID** on that page and the **Team ID**
   from the top right of the portal.
2. Store the three values as SecureString parameters (region `eu-west-1`):

```bash
aws ssm put-parameter --region eu-west-1 --type SecureString --name /perfect-events/apple-music/private-key --value "$(cat AuthKey_XXXXXXXXXX.p8)"
aws ssm put-parameter --region eu-west-1 --type SecureString --name /perfect-events/apple-music/key-id --value XXXXXXXXXX
aws ssm put-parameter --region eu-west-1 --type SecureString --name /perfect-events/apple-music/team-id --value YYYYYYYYYY
```

3. Force a fresh container so it re-reads the parameters, or just wait:

```bash
aws lambda update-function-configuration --region eu-west-1 --function-name perfect-events-music-search --description "apple key $(date +%F)"
```

To check which catalogue is answering: the JSON from `/music/search?q=test` has
`"source": "apple"` or `"source": "deezer"`.

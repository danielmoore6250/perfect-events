#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Perfect Events NI - Deploy ==="

# Email is sent via Amazon SES using the Lambda's IAM role — no credentials needed.

# Build the React app
echo "Building React app..."
cd "$PROJECT_ROOT"
npm run build

# Deploy CDK stack
echo "Deploying CDK stack..."
cd "$PROJECT_ROOT/infra"
npx cdk deploy --require-approval never

echo ""
echo "=== Deploy complete ==="
echo "Stack outputs above contain your CloudFront URL and API endpoint."

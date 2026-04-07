# Deployment Guide

> From zero to running platform — local development, Docker, and Azure production.

## Prerequisites

| Tool      | Version | Purpose                            |
| --------- | ------- | ---------------------------------- |
| Node.js   | 22+     | Runtime                            |
| npm       | 10+     | Package manager                    |
| Docker    | 24+     | Local Redis + containerised builds |
| Terraform | 1.5+    | Azure infrastructure provisioning  |
| Azure CLI | 2.50+   | Authenticating with Azure          |

## Local Development

### Option A: Docker Compose (Recommended)

The fastest way to get running — brings up Redis and the API in one command.

```bash
# 1. Clone and install
git clone <repo-url> && cd agent-team-app
npm install

# 2. Configure
cp .env.example .env
# Edit .env:
#   AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
#   AZURE_OPENAI_API_KEY=your-key
#   AZURE_OPENAI_DEPLOYMENT=gpt-4o
#   JWT_SECRET=any-random-string-for-local-dev

# 3. Start everything
docker compose up
```

The API will be available at `http://localhost:3000`.

### Option B: Native (Redis on Host)

```bash
# Start Redis (macOS)
brew install redis && brew services start redis

# Or start Redis (Docker standalone)
docker run -d -p 6379:6379 redis:7-alpine

# Install and run
npm install
cp .env.example .env   # configure as above
npm run start:dev       # watch mode with hot reload
```

### Generating a Test JWT

For local testing, generate a JWT with the required claims:

```bash
# Using Node.js
node -e "
  const jwt = require('@nestjs/jwt');
  // Or use https://jwt.io with your JWT_SECRET
  console.log('Use jwt.io or a script to create a token with:');
  console.log('{ sub: \"user-1\", teamId: \"team-1\", email: \"dev@test.com\" }');
"
```

Or at [jwt.io](https://jwt.io), paste your `JWT_SECRET` and create a token with:

```json
{
  "sub": "user-1",
  "teamId": "team-1",
  "email": "dev@test.com"
}
```

### Testing the API Locally

```bash
# Set your token
export JWT="eyJhbGciOiJIUzI1NiIs..."

# Submit a task
curl -s -X POST http://localhost:3000/agent/run \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"message": "Review our API authentication flow", "sessionId": "test-1"}' \
  | jq .

# Stream results (in another terminal)
curl -N http://localhost:3000/agent/stream/<jobId-from-above>

# Clear session
curl -X POST http://localhost:3000/agent/session/test-1/clear \
  -H "Authorization: Bearer $JWT"
```

---

## Building Docker Images

The Dockerfile uses a multi-stage build for minimal production images:

```bash
# Build
docker build -t agent-api:latest .

# Run standalone
docker run -p 3000:3000 \
  -e REDIS_URL=redis://host.docker.internal:6379 \
  -e AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com \
  -e AZURE_OPENAI_API_KEY=your-key \
  -e AZURE_OPENAI_DEPLOYMENT=gpt-4o \
  -e JWT_SECRET=your-secret \
  agent-api:latest
```

**Image details:**

- Base: `node:22-alpine`
- Non-root user (`app`)
- Dev dependencies excluded (`npm ci --omit=dev`)
- Final image: ~150 MB

---

## Azure Production Deployment

### Step 1: Provision Infrastructure

```bash
cd infra

# Login to Azure
az login

# Initialize Terraform
terraform init \
  -backend-config="resource_group_name=rg-tfstate" \
  -backend-config="storage_account_name=<your-storage-account>" \
  -backend-config="container_name=tfstate" \
  -backend-config="key=agent-platform.tfstate"

# Plan (review changes)
terraform plan \
  -var="azure_openai_api_key=<your-key>" \
  -var="azure_openai_endpoint=https://your-resource.openai.azure.com" \
  -var="azure_openai_deployment=gpt-4o"

# Apply
terraform apply \
  -var="azure_openai_api_key=<your-key>" \
  -var="azure_openai_endpoint=https://your-resource.openai.azure.com" \
  -var="azure_openai_deployment=gpt-4o"
```

Terraform creates:

- Resource group `rg-agent-platform-prod`
- Container Apps environment + API + Worker apps
- Azure Cache for Redis (Standard, TLS 1.2)
- Container Registry (ACR)
- Key Vault with Azure OpenAI API key secret

### Step 2: Push Docker Images to ACR

```bash
# Get ACR login server from Terraform output
ACR_SERVER=$(terraform output -raw acr_login_server 2>/dev/null || echo "agentplatformacr.azurecr.io")

# Login to ACR
az acr login --name agentplatformacr

# Tag and push API image
docker tag agent-api:latest $ACR_SERVER/agent-api:latest
docker push $ACR_SERVER/agent-api:latest

# Tag and push Worker image (same Dockerfile, different env config)
docker tag agent-api:latest $ACR_SERVER/agent-worker:latest
docker push $ACR_SERVER/agent-worker:latest
```

### Step 3: Verify Deployment

```bash
# Get the API URL
API_URL=$(terraform output -raw api_url)
echo "API running at: $API_URL"

# Health check
curl -s $API_URL | jq .

# Test with a JWT (configure your auth provider first)
curl -s -X POST $API_URL/agent/run \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, agents!", "sessionId": "deploy-test"}'
```

---

## CI/CD Pipeline (GitHub Actions)

Example workflow for automated deployments:

```yaml
# .github/workflows/deploy.yml
name: Build & Deploy

on:
  push:
    branches: [main]

env:
  ACR_NAME: agentplatformacr
  API_APP: ca-api-gateway
  WORKER_APP: ca-agent-worker
  RESOURCE_GROUP: rg-agent-platform-prod

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: azure/login@v2
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}

      - name: Build and push to ACR
        run: |
          az acr login --name $ACR_NAME
          docker build -t $ACR_NAME.azurecr.io/agent-api:${{ github.sha }} .
          docker push $ACR_NAME.azurecr.io/agent-api:${{ github.sha }}

      - name: Deploy API Gateway
        run: |
          az containerapp update \
            --name $API_APP \
            --resource-group $RESOURCE_GROUP \
            --image $ACR_NAME.azurecr.io/agent-api:${{ github.sha }}

      - name: Deploy Workers
        run: |
          az containerapp update \
            --name $WORKER_APP \
            --resource-group $RESOURCE_GROUP \
            --image $ACR_NAME.azurecr.io/agent-api:${{ github.sha }}
```

---

## Environment Variables Reference

| Variable                  | Required | Default       | Description                      |
| ------------------------- | -------- | ------------- | -------------------------------- |
| `AZURE_OPENAI_ENDPOINT`   | Yes      | —             | Azure OpenAI resource URL        |
| `AZURE_OPENAI_API_KEY`    | Yes      | —             | API key for Azure OpenAI         |
| `AZURE_OPENAI_DEPLOYMENT` | No       | `gpt-4o`      | Model deployment name            |
| `JWT_SECRET`              | Yes      | —             | HMAC secret for JWT verification |
| `REDIS_URL`               | Yes      | —             | Redis connection string          |
| `PORT`                    | No       | `3000`        | HTTP server port                 |
| `NODE_ENV`                | No       | `development` | `development` or `production`    |
| `CORS_ORIGIN`             | No       | `*`           | Allowed CORS origin              |

---

## Troubleshooting

| Symptom                            | Likely Cause                          | Fix                                                              |
| ---------------------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `401 Unauthorized` on all requests | Invalid JWT_SECRET or token           | Check JWT_SECRET matches token signing key                       |
| Jobs enqueued but never processed  | Worker not connected to Redis         | Verify REDIS_URL is the same for API + Worker                    |
| SSE stream never receives events   | Worker and API on different instances | In production, SSE push requires shared process (see note below) |
| `ECONNREFUSED` to Redis            | Redis not running                     | `docker compose up redis` or check Azure Redis firewall          |
| Azure OpenAI `401`                 | Invalid API key or endpoint           | Verify AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY            |
| Sub-agents returning empty         | Wrong deployment name                 | Verify AZURE_OPENAI_DEPLOYMENT matches your Azure portal         |

> **Note on SSE in multi-instance deployments:** The current SSE implementation uses an in-memory `Map` in the controller. In a multi-replica deployment, the API instance that received the SSE connection may not be the same one receiving `pushEvent` calls from the worker. For production, consider using Redis Pub/Sub to bridge events between instances, or ensure sticky sessions route SSE connections to the correct replica.

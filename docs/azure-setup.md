# Azure Setup — Non-Production (NPR)

One-time setup steps to get the deployment pipeline working.
Everything lives in a **single resource group** (`rg-agent-team-npr`) for simple cost tracking.

## Prerequisites

- Azure CLI (`az`) installed and logged in
- Access to NPR subscription `<NPR_SUBSCRIPTION_ID>`
- Admin access to the `<your-org>/agent-team-app` GitHub repo

## 1. Create the Resource Group

One RG for everything — app resources, TF state, OpenAI:

```bash
az group create \
  --name rg-agent-team-npr \
  --location swedencentral \
  --subscription <NPR_SUBSCRIPTION_ID>
```

Share `rg-agent-team-npr` with the SRE so they can track costs.

## 2. Terraform State Storage (in the same RG)

```bash
az storage account create \
  --name agnt0001nprtf \
  --resource-group rg-agent-team-npr \
  --location swedencentral \
  --sku Standard_LRS \
  --subscription <NPR_SUBSCRIPTION_ID>

az storage container create \
  --name tfstate \
  --account-name agnt0001nprtf
```

## 3. Azure AD App Registration (OIDC)

Create a federated identity so GitHub Actions authenticates without secrets:

```bash
# Create the app registration
az ad app create --display-name "agent-team-npr-deploy"
# Note the appId — this is your NPR_OIDC_CLIENT_ID

# Create a service principal
az ad sp create --id <APP_ID>

# Add federated credential for GitHub Actions
az ad app federated-credential create --id <APP_ID> --parameters '{
  "name": "github-main-branch",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:<your-org>/agent-team-app:environment:npr",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

After creation, update `<NPR_OIDC_CLIENT_ID>` in `config/workflow-config.yml` with the actual app ID.

## 4. RBAC for the Service Principal

```bash
SP_OBJECT_ID=$(az ad sp show --id <APP_ID> --query id -o tsv)

# Contributor on the resource group (covers all resources inside it)
az role assignment create \
  --assignee-object-id "$SP_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal \
  --role Contributor \
  --scope /subscriptions/<NPR_SUBSCRIPTION_ID>/resourceGroups/rg-agent-team-npr

# Storage Blob Data Contributor (for terraform state)
az role assignment create \
  --assignee-object-id "$SP_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal \
  --role "Storage Blob Data Contributor" \
  --scope /subscriptions/<NPR_SUBSCRIPTION_ID>/resourceGroups/rg-agent-team-npr
```

> **Note:** RBAC is scoped to the single RG, not the whole subscription. Least-privilege.

## 5. Azure OpenAI Resource (in the same RG)

> **Auth:** No API key needed. Terraform assigns `Cognitive Services OpenAI User` to both Container Apps
> via managed identity. The app uses `DefaultAzureCredential` automatically.

```bash
az cognitiveservices account create \
  --name agent-team-openai-npr \
  --resource-group rg-agent-team-npr \
  --location swedencentral \
  --kind OpenAI \
  --sku S0 \
  --subscription <NPR_SUBSCRIPTION_ID>

az cognitiveservices account deployment create \
  --name agent-team-openai-npr \
  --resource-group rg-agent-team-npr \
  --deployment-name gpt-4o \
  --model-name gpt-4o \
  --model-version "2024-08-06" \
  --model-format OpenAI \
  --sku-capacity 30 \
  --sku-name Standard
```

## 6. GitHub Repository Setup

In repo settings (`<your-org>/agent-team-app`):

1. Go to **Settings → Environments → New environment**
2. Create environment named `npr`
3. No secrets needed — OIDC handles Azure auth, `GITHUB_TOKEN` handles GHCR

## Checklist

- [ ] Resource group `rg-agent-team-npr` created
- [ ] RG name shared with SRE for cost tracking
- [ ] Terraform state storage account `agnt0001nprtf` + `tfstate` container created
- [ ] App Registration created + federated credential added
- [ ] `<NPR_OIDC_CLIENT_ID>` updated in `config/workflow-config.yml`
- [ ] RBAC roles assigned (Contributor + Storage Blob Data Contributor) on RG
- [ ] Azure OpenAI resource + GPT-4o model deployed
- [ ] `npr` GitHub environment created
- [ ] Push to `main` — pipeline runs automatically

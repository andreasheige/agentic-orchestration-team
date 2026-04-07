# Infrastructure

> Azure infrastructure managed by Terraform — Container Apps, Redis, Key Vault, and ACR.

## Resource Map

```
rg-agent-platform-prod (Sweden Central)
├── cae-agent-prod                  Container Apps Environment
│   ├── ca-api-gateway              API Gateway (public, 1–3 replicas)
│   └── ca-agent-worker             Worker Pool (internal, 0–10 replicas)
├── agent-redis-prod                Azure Cache for Redis (Standard C1)
├── agentplatformacr                Azure Container Registry (Basic)
├── kv-agent-prod                   Azure Key Vault
│   └── azure-openai-api-key        Secret
└── (data source)                   Current Azure client config
```

## Container Apps

### API Gateway (`ca-api-gateway`)

| Setting       | Value                         | Rationale                                  |
| ------------- | ----------------------------- | ------------------------------------------ |
| Ingress       | External, port 3000           | Only public-facing component               |
| Min replicas  | 1                             | Always-on for low-latency first requests   |
| Max replicas  | 3                             | Handles burst traffic from 10 teams        |
| CPU / Memory  | 0.5 vCPU / 1 GiB              | Lightweight — just auth, enqueue, SSE      |
| Scale trigger | HTTP concurrent requests > 50 | One replica per ~50 concurrent connections |

**Environment variables:**

- `REDIS_URL` — connection string with TLS (`rediss://`)
- `NODE_ENV` — `production`

### Worker Pool (`ca-agent-worker`)

| Setting       | Value                                        | Rationale                                        |
| ------------- | -------------------------------------------- | ------------------------------------------------ |
| Ingress       | **None**                                     | Internal only — pulls from Redis queue           |
| Min replicas  | 0                                            | Scale to zero when idle (no cost)                |
| Max replicas  | 10                                           | One worker per team (10 teams)                   |
| CPU / Memory  | 1.0 vCPU / 2 GiB                             | More headroom for concurrent sub-agent API calls |
| Scale trigger | Redis list `bull:agent-jobs:wait` length ≥ 1 | KEDA-based: 1 pending job → 1 new replica        |

**Environment variables:**

- `REDIS_URL` — connection string with TLS
- `AZURE_OPENAI_API_KEY` — from Key Vault secret
- `AZURE_OPENAI_ENDPOINT` — Azure OpenAI resource URL
- `AZURE_OPENAI_DEPLOYMENT` — model deployment name (default: `gpt-4o`)

### Scaling Behavior

```
Queue depth: 0  → Workers: 0  (zero cost)
Queue depth: 1  → Workers: 1  (cold start ~10s)
Queue depth: 5  → Workers: 5  (parallel processing)
Queue depth: 10 → Workers: 10 (max capacity)
Queue depth: 15 → Workers: 10 (5 jobs wait in queue)
```

Workers process **one job at a time**. This ensures each team's orchestration gets dedicated resources and prevents memory pressure from concurrent agentic loops.

## Azure Cache for Redis

| Setting  | Value                              |
| -------- | ---------------------------------- |
| SKU      | Standard (replicated)              |
| Capacity | C1 (1 GB)                          |
| TLS      | 1.2 minimum, non-SSL port disabled |
| Port     | 6380 (TLS)                         |

**Dual purpose:**

1. **BullMQ queue** — job storage, dequeue, retry tracking
2. **Session state** — conversation history per team per session

### Capacity Planning

Each session stores up to 40 messages as JSON. Typical session size: 20–50 KB. With 10 teams and multiple sessions:

```
10 teams × 10 sessions × 50 KB = ~5 MB
BullMQ overhead: ~10 MB
Total: ~15 MB (well within 1 GB)
```

Bump to C2 (2.5 GB) if you add more teams or increase the message window.

## Azure Key Vault

Stores sensitive configuration away from environment variables:

| Secret                 | Used By           |
| ---------------------- | ----------------- |
| `azure-openai-api-key` | Worker containers |

Access is controlled via Azure RBAC / managed identity. The Container Apps runtime pulls secrets at deployment time.

## Azure Container Registry

| Setting | Value                                                |
| ------- | ---------------------------------------------------- |
| SKU     | Basic                                                |
| Admin   | Disabled (use managed identity or service principal) |

Two images are pushed here:

- `agent-api:latest` — the API Gateway
- `agent-worker:latest` — the Worker Pool

Both use the same NestJS codebase but are configured differently via environment variables.

## Network Topology

```
Internet
    │
    ▼
┌─────────────────────────────────────────────┐
│  Container Apps Environment (cae-agent-prod) │
│                                              │
│  ┌──────────────┐    ┌───────────────────┐  │
│  │ API Gateway  │    │  Worker Pool      │  │
│  │ (external)   │    │  (internal only)  │  │
│  └──────┬───────┘    └─────────┬─────────┘  │
│         │                      │             │
│         └──────┬───────────────┘             │
│                │                              │
│                ▼                              │
│  ┌──────────────────────┐                    │
│  │ Azure Redis (TLS)    │                    │
│  └──────────────────────┘                    │
│                                              │
│  ┌──────────────────────┐                    │
│  │ Key Vault            │                    │
│  └──────────────────────┘                    │
└──────────────────────────────────────────────┘
         │
         ▼
┌──────────────────┐
│ Azure OpenAI     │
│ (swedencentral)  │
└──────────────────┘
```

## Terraform Variables

| Variable                  | Type               | Default         | Description                                |
| ------------------------- | ------------------ | --------------- | ------------------------------------------ |
| `env`                     | string             | `prod`          | Environment name (used in resource naming) |
| `location`                | string             | `swedencentral` | Azure region                               |
| `azure_openai_api_key`    | string (sensitive) | —               | Azure OpenAI API key                       |
| `azure_openai_endpoint`   | string             | —               | Azure OpenAI resource endpoint URL         |
| `azure_openai_deployment` | string             | `gpt-4o`        | Deployed model name                        |

## Terraform Outputs

| Output       | Description                          | Sensitive |
| ------------ | ------------------------------------ | --------- |
| `api_url`    | Public HTTPS URL for the API Gateway | No        |
| `redis_host` | Redis hostname                       | Yes       |

## Cost Estimate (Sweden Central)

| Resource                            | Approx. Monthly Cost | Notes                   |
| ----------------------------------- | -------------------- | ----------------------- |
| Container Apps (API, 1 replica)     | ~$30                 | Always-on               |
| Container Apps (Workers, avg 2)     | ~$40                 | Scale-to-zero when idle |
| Azure Cache for Redis (C1 Standard) | ~$50                 | Replicated              |
| Container Registry (Basic)          | ~$5                  |                         |
| Key Vault                           | < $1                 | Per-operation pricing   |
| Azure OpenAI (GPT-4o)               | Variable             | ~$5–15/1M tokens        |
| **Total (excluding OpenAI)**        | **~$126/mo**         |                         |

Costs scale linearly with team count and usage volume. Scale-to-zero workers mean you only pay for active orchestrations.

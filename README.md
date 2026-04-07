# Agent Team App

Multi-tenant AI agent orchestration platform. An **orchestrator agent** decomposes tasks and delegates to specialist **sub-agents** (frontend, backend, security, database, devsecops) — powered by **Azure OpenAI** (GPT-4o).

## How It Works

```
Client → API Gateway (NestJS) → BullMQ (Redis) → Worker Pool → Azure OpenAI
                                                      ↓
                                              Sub-agents (parallel)
```

1. Client sends a task via `POST /agent/run` — gets back a `jobId` immediately
2. Client opens `GET /agent/stream/:jobId` (SSE) for real-time progress
3. Worker picks up the job, orchestrator calls Azure OpenAI with tool-use
4. Orchestrator delegates to specialist sub-agents in parallel
5. Sub-agent results are synthesised into a final response, streamed to client

**Key design decisions:**

- **Multi-tenant** — each team gets isolated sessions via JWT `teamId`
- **Async via queue** — requests enqueued, processed by workers, streamed back via SSE
- **Scale-to-zero workers** — Azure Container Apps scales 0→10 based on queue depth
- **Session state in Redis** — conversation history persisted with 24h TTL, 40-message window
- **Pluggable agents** — add a new specialist in two lines of code

## Quick Start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Set: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, JWT_SECRET

# 3. Run (Docker — includes Redis)
docker compose up

# Or natively (requires Redis on localhost:6379)
npm run start:dev
```

## Documentation

| Document                                                 | Description                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| [Architecture](docs/architecture.md)                     | System design, data flow, security boundaries, component map       |
| [API Reference](docs/api-reference.md)                   | Endpoints, auth, SSE events, error handling, rate limits           |
| [Orchestrator Deep Dive](docs/orchestrator-deep-dive.md) | Agentic loop, sub-agent dispatch, tool-use pattern, session format |
| [Infrastructure](docs/infrastructure.md)                 | Terraform resources, scaling, network topology, cost estimate      |
| [Deployment Guide](docs/deployment.md)                   | Local dev, Docker, Azure production, CI/CD, troubleshooting        |
| [Architecture Diagram](docs/arch.svg)                    | Visual SVG diagram of the full system                              |
| [Repo Workflows](docs/repo-workflows.md)                 | CLI, GitHub webhooks, CI integration — multi-repo usage            |

## API At a Glance

| Method | Path                              | Description                          |
| ------ | --------------------------------- | ------------------------------------ |
| `POST` | `/agent/run`                      | Submit a task → returns `{ jobId }`  |
| `GET`  | `/agent/stream/:jobId`            | SSE stream of progress events        |
| `POST` | `/agent/session/:sessionId/clear` | Clear conversation history           |
| `POST` | `/webhooks/github`                | GitHub PR webhook (automatic review) |

All endpoints require `Authorization: Bearer <jwt>` with a `teamId` claim.

## Specialist Agents

| Agent       | Focus                                                 |
| ----------- | ----------------------------------------------------- |
| `frontend`  | Next.js, React, UI/UX, accessibility, performance     |
| `backend`   | NestJS, PostgreSQL, API design, service patterns      |
| `security`  | OWASP top 10, auth, secrets, GDPR compliance          |
| `database`  | Schema design, migrations, queries, indexing, caching |
| `devsecops` | Kubernetes, Terraform, Azure, CI/CD, containers       |

New agents are added by editing one object in [orchestrator.service.ts](src/orchestrator/orchestrator.service.ts) — the orchestrator auto-discovers them.

## Project Structure

```
src/
├── main.ts                          # NestJS bootstrap
├── app.module.ts                    # Root module
├── auth/
│   ├── auth.module.ts               # JWT auth module
│   ├── jwt.strategy.ts              # Passport JWT strategy
│   └── jwt.guard.ts                 # Auth guard
├── orchestrator/
│   ├── orchestrator.module.ts       # Redis + BullMQ wiring
│   ├── agent.controller.ts          # HTTP endpoints + SSE streaming
│   ├── orchestrator.service.ts      # Agentic loop + Azure OpenAI
│   └── agent-job.processor.ts       # BullMQ job processor
└── webhooks/
    ├── webhook.module.ts            # Webhook module registration
    └── github-webhook.controller.ts # GitHub PR webhook handler

cli/
├── agent-team.ts                    # CLI tool for ad-hoc reviews
└── tsconfig.json                    # CLI build config

docs/                                # Full documentation suite
infra/main.tf                        # Azure Terraform config
```

## Infrastructure

Deploy to Azure with Terraform:

```bash
cd infra && terraform init && terraform apply \
  -var="azure_openai_api_key=..." \
  -var="azure_openai_endpoint=https://your-resource.openai.azure.com"
```

See [Infrastructure docs](docs/infrastructure.md) for resource details and cost estimates.

# Architecture

> System architecture for the Agent Team App — a multi-tenant AI orchestration platform running on Azure.

## High-Level Overview

```
┌─────────────┐     HTTPS + SSE     ┌───────────────────┐
│  Teams 1–10 │ ──────────────────▶  │   API Gateway     │
│  Browser /  │                      │   NestJS          │
│  Next.js    │ ◀─── SSE stream ──── │   Container App   │
└─────────────┘                      └────────┬──────────┘
                                              │ enqueue
                                              ▼
                                     ┌───────────────────┐
                                     │   Job Queue       │
                                     │   BullMQ · Redis  │
                                     └────────┬──────────┘
                                              │ dequeue
                                              ▼
                                     ┌───────────────────┐
                                     │   Worker Pool     │     ┌────────────┐
                                     │   Orchestrator    │ ──▶ │ Azure      │
                                     │   Container Apps  │     │ OpenAI API │
                                     │   (scale 0–10)    │ ◀── │ GPT-4o     │
                                     └──┬──┬──┬──┬──┬────┘     └────────────┘
                                        │  │  │  │  │
                          ┌─────────────┼──┼──┼──┼──┼─────────────┐
                          ▼             ▼  ▼  ▼  ▼  ▼             ▼
                     ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌──────────┐
                     │Frontend │  │Backend  │  │Security │  │Database  │ ...
                     │Agent    │  │Agent    │  │Agent    │  │Agent     │
                     └─────────┘  └─────────┘  └─────────┘  └──────────┘
```

For the full visual diagram, see [arch.svg](arch.svg).

## Core Design Principles

### 1. Async-First via Job Queue

Every client request is **enqueued immediately** and returns a `jobId`. The client never blocks on AI processing — instead it subscribes to an SSE stream and receives live progress events. This keeps HTTP connections short-lived and prevents timeouts with long-running multi-agent orchestrations.

```
Client                    API Gateway              BullMQ              Worker
  │                           │                      │                   │
  │─── POST /agent/run ──────▶│                      │                   │
  │                           │─── queue.add() ─────▶│                   │
  │◀── { jobId } ────────────│                      │                   │
  │                           │                      │── dequeue ───────▶│
  │─── GET /stream/:jobId ──▶│                      │                   │
  │                           │                      │                   │── Azure OpenAI
  │◀── SSE: agent_start ─────│◀───── pushEvent ─────│◀──────────────────│
  │◀── SSE: agent_done ──────│◀───── pushEvent ─────│◀──────────────────│
  │◀── SSE: final ───────────│◀───── pushEvent ─────│◀──────────────────│
  │                           │                      │                   │
```

### 2. Multi-Tenancy via JWT Isolation

Tenant isolation is enforced at every layer through `teamId` extracted from JWTs:

| Layer              | Isolation mechanism                                         |
| ------------------ | ----------------------------------------------------------- |
| **API Gateway**    | JWT guard extracts `teamId` from token                      |
| **Job Queue**      | Job payload carries `teamId`; jobId prefixed with `teamId:` |
| **Redis sessions** | Keys are `agent:session:{teamId}:{sessionId}`               |
| **Workers**        | `teamId` propagated through the full orchestration pipeline |

There is **no shared state** between teams. A team can never read another team's conversation history or receive another team's SSE events.

### 3. Scale-to-Zero Workers

Workers have **no public ingress**. They pull jobs from BullMQ and scale based on queue depth:

- **0 jobs** → 0 worker replicas (no cost)
- **1 job** → 1 worker spins up
- **10 jobs** → 10 workers (one per team, max)

This maps naturally to per-team concurrency: each team can have one active orchestration at a time, and Azure Container Apps handles scaling automatically via KEDA.

### 4. Pluggable Sub-Agent Architecture

The orchestrator uses **OpenAI function calling** (`delegate_to_agent` tool) to route tasks to specialist agents. New agents require only adding an entry to the `AGENTS` registry — the tool schema, routing logic, and parallel execution all happen automatically.

```typescript
const AGENTS: Record<string, string> = {
  frontend: `You are a senior Frontend engineer...`,
  backend: `You are a senior Backend engineer...`,
  // Add new agents here — nothing else changes
};
```

## Component Responsibilities

| Component              | Technology               | Responsibility                                            |
| ---------------------- | ------------------------ | --------------------------------------------------------- |
| **API Gateway**        | NestJS on Container Apps | Auth, request validation, job enqueue, SSE streaming      |
| **Job Queue**          | BullMQ on Azure Redis    | Durable job storage, retry logic, back-pressure           |
| **Worker Pool**        | NestJS on Container Apps | Orchestrator agent loop, sub-agent dispatch               |
| **Session Store**      | Azure Cache for Redis    | Conversation history per team, 24h TTL, 40-message window |
| **AI Backend**         | Azure OpenAI (GPT-4o)    | Orchestrator reasoning + sub-agent analysis               |
| **Secret Store**       | Azure Key Vault          | API keys, JWT secrets                                     |
| **Container Registry** | ACR                      | Docker image storage                                      |
| **Auth**               | Entra ID + JWT           | Team identity, RBAC                                       |
| **Observability**      | App Insights + OTel      | Logs, metrics, distributed tracing                        |

## Data Flow

### Session Lifecycle

```
1. User sends message → API enqueues job with {teamId, sessionId, message}
2. Worker picks up job → loads history from Redis (agent:session:{teamId}:{sessionId})
3. Orchestrator appends user message to history → calls Azure OpenAI
4. If Azure OpenAI returns tool_calls → dispatch sub-agents in parallel
5. Sub-agent results become tool messages → appended to history → loop
6. When orchestrator produces final text → push SSE "final" event
7. Full conversation history saved to Redis (trimmed to 40 messages, 24h TTL)
```

### Message Flow Through the Agentic Loop

```
Orchestrator (GPT-4o)
  │
  ├── "I need frontend and security review"
  │
  ├── tool_call: delegate_to_agent(agent="frontend", task="Review the component...")
  ├── tool_call: delegate_to_agent(agent="security", task="Check OWASP top 10...")
  │                         │
  │                         ├── Frontend Agent (GPT-4o) ──▶ analysis
  │                         └── Security Agent (GPT-4o) ──▶ findings
  │                                      │
  │◀───── tool results ─────────────────┘
  │
  └── Synthesised final response incorporating both agent reviews
```

## Security Boundaries

```
Internet ──▶ [ API Gateway ] ──▶ [ Internal Network ]
              public ingress           │
              JWT required             ├── Worker Pool (no ingress)
              CORS policy              ├── Redis (TLS 1.2, no non-SSL)
                                       └── Key Vault (managed identity)
```

- **API Gateway** is the only public-facing component
- **Workers** have zero external surface — internal network only
- **Redis** enforces TLS 1.2, non-SSL port disabled
- **Secrets** stored in Key Vault, never in environment variables
- **JWT** tokens carry `teamId` and `email` for audit logging

# Orchestrator Deep Dive

> How the agentic loop works — from user message to synthesised response.

## The Agentic Pattern

The orchestrator implements a **tool-use loop** — the same pattern used by AI coding assistants, autonomous agents, and multi-step reasoning systems. Instead of generating a single response, the LLM iteratively decides what specialist input it needs, gathers that input, and synthesises a final answer.

```
User message
    │
    ▼
┌─────────────────────────────────────────┐
│  Orchestrator (Azure OpenAI GPT-4o)     │
│                                         │
│  System: "You are an Architect and      │
│  Orchestrator. Decompose tasks and      │
│  delegate to the right specialist       │
│  agents."                               │
│                                         │
│  Tool: delegate_to_agent(agent, task)   │
└────────────────┬────────────────────────┘
                 │
          ┌──────┴──────┐
          │ tool_calls? │
          └──────┬──────┘
           yes   │   no
     ┌───────────┤   └──▶ Return final text
     ▼           │
  Dispatch       │
  sub-agents     │
  in parallel    │
     │           │
     ▼           │
  Collect tool   │
  results        │
     │           │
     └───────────┘ (loop back)
```

## Orchestrator Service Walkthrough

### Step 1: Load Session History

```typescript
const history = await this.loadHistory(key);
history.push({ role: "user", content: userMessage });
```

Every orchestration starts by loading the team's conversation from Redis. This gives the LLM full context of previous exchanges. The key format `agent:session:{teamId}:{sessionId}` ensures complete tenant isolation.

### Step 2: Define the Tool

The orchestrator exposes a single tool to the LLM:

```typescript
{
  type: "function",
  function: {
    name: "delegate_to_agent",
    parameters: {
      properties: {
        agent: { type: "string", enum: ["frontend", "backend", "security", "database", "devsecops"] },
        task:  { type: "string", description: "The specific question for this agent." }
      },
      required: ["agent", "task"]
    }
  }
}
```

The LLM decides **which agents to call** and **what to ask them** based on the user's message. It doesn't always call every agent — the system prompt explicitly instructs it to only invoke relevant specialists.

### Step 3: The Agentic Loop

```
for (let i = 0; i < MAX_ITERATIONS; i++) {
    1. Call Azure OpenAI with history + tools
    2. If no tool_calls or stop → extract final text, break
    3. If tool_calls → dispatch sub-agents in parallel
    4. Append tool results to history
    5. Loop (model sees results + decides next action)
}
```

**Safety cap:** The loop runs at most **10 iterations** to prevent infinite delegation chains. In practice, most requests complete in 1–3 iterations.

### Step 4: Parallel Sub-Agent Dispatch

When the orchestrator emits multiple `tool_calls`, all sub-agents run simultaneously:

```typescript
const toolResults = await Promise.all(
  message.tool_calls.map(async (call) => {
    const { agent, task } = JSON.parse(call.function.arguments);
    const result = await this.runSubAgent(agent, task);
    return { role: "tool", tool_call_id: call.id, content: result };
  }),
);
```

This is critical for performance. If the orchestrator asks for frontend, security, and database reviews simultaneously, all three API calls happen in parallel rather than sequentially. Total latency = slowest sub-agent, not sum of all.

### Step 5: Sub-Agent Execution

Each sub-agent is a **single-turn** call to Azure OpenAI with a specialist system prompt:

```typescript
private async runSubAgent(name: string, task: string): Promise<string> {
  const response = await this.client.chat.completions.create({
    model: DEPLOYMENT,
    max_tokens: 1024,
    messages: [
      { role: "system", content: AGENTS[name] },  // specialist prompt
      { role: "user", content: task }              // task from orchestrator
    ],
  });
  return response.choices[0].message.content ?? "";
}
```

Sub-agents are **stateless** — they don't see conversation history. The orchestrator provides them with a focused task extracted from the broader context.

### Step 6: Synthesis & Persistence

After all sub-agent results are collected, the loop continues. The orchestrator sees the specialist analyses and produces a synthesised final response that combines insights from all agents.

The full conversation (including tool calls and results) is then saved to Redis:

```typescript
// Trim to 40 messages to prevent context explosion
const trimmed = history.slice(-40);
await this.redis.setex(key, SESSION_TTL, JSON.stringify(trimmed));
```

## Agent Registry

Agents are defined as a simple `Record<string, string>` mapping agent names to system prompts:

| Agent       | Specialty                    | Focus Areas                                    |
| ----------- | ---------------------------- | ---------------------------------------------- |
| `frontend`  | Next.js, React               | UI/UX, components, accessibility, performance  |
| `backend`   | NestJS, PostgreSQL           | API design, services, data models, patterns    |
| `security`  | Web application security     | OWASP top 10, auth, secrets, GDPR              |
| `database`  | PostgreSQL, Redis            | Schema, migrations, queries, indexing, caching |
| `devsecops` | Kubernetes, Terraform, Azure | Infra config, CI/CD, containers, deployment    |

### Adding a New Agent

Adding an agent is a two-line change:

```typescript
const AGENTS: Record<string, string> = {
  // ...existing agents

  testing: `You are a senior QA engineer specialising in testing strategy.
Review test coverage, testing patterns, and quality assurance. Be concise.`,
};
```

That's it. The tool schema is auto-generated from `Object.keys(AGENTS)`, the routing is automatic, and the orchestrator's system prompt dynamically includes the new agent name.

## SSE Progress Events

The orchestrator reports progress via a callback that flows through the job processor to the SSE controller:

```
Orchestrator                    Job Processor               SSE Controller
    │                               │                           │
    │── onProgress(agent_start) ──▶│── pushEvent() ──────────▶│──▶ Client
    │── onProgress(agent_done) ───▶│── pushEvent() ──────────▶│──▶ Client
    │── onProgress(final) ────────▶│── pushEvent() ──────────▶│──▶ Client
    │                               │                           │   (stream closes)
```

This gives the client real-time visibility into which agents are working and what they produced, before the final synthesised answer arrives.

## Conversation History Format

History stored in Redis follows the OpenAI chat completions format:

```json
[
  { "role": "user", "content": "Review our auth flow" },
  {
    "role": "assistant",
    "content": null,
    "tool_calls": [
      {
        "id": "call_abc",
        "function": {
          "name": "delegate_to_agent",
          "arguments": "{\"agent\":\"security\",\"task\":\"...\"}"
        }
      }
    ]
  },
  {
    "role": "tool",
    "tool_call_id": "call_abc",
    "content": "## Security Review\n..."
  },
  { "role": "assistant", "content": "Based on the security review..." }
]
```

This format preserves the full reasoning chain including which agents were consulted and what they said, enabling the orchestrator to reference previous analyses in follow-up questions.

## Performance Characteristics

| Metric                        | Typical Value | Notes                           |
| ----------------------------- | ------------- | ------------------------------- |
| Time to `jobId` response      | < 50ms        | Enqueue is nearly instant       |
| Time to first SSE event       | 2–5s          | Depends on Azure OpenAI latency |
| Sub-agent latency             | 1–3s each     | Run in parallel                 |
| Total orchestration (simple)  | 3–8s          | 1 loop iteration                |
| Total orchestration (complex) | 8–20s         | 2–3 loop iterations             |
| Redis session read/write      | < 5ms         | Local to Azure region           |

// Stateless service — all state lives in Redis keyed by teamId + sessionId

import { Injectable, Logger } from "@nestjs/common";
import { AzureOpenAI } from "openai";
import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from "@azure/identity";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import { InjectRedis } from "@nestjs-modules/ioredis";
import Redis from "ioredis";

const DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT || "gpt-4o";
const API_VERSION = "2024-12-01-preview";
const SESSION_TTL = 60 * 60 * 24; // 24h

// ─── Agent registry ──────────────────────────────────────────────────────────
// Drop new agents here — nothing else needs to change
interface AgentDef {
  system: string;
  name: string;
  email: string;
}

const AGENTS: Record<string, AgentDef> = {
  frontend: {
    system: `You are a senior Frontend engineer specialising in Next.js and React.
Review UI/UX, component design, accessibility, and performance. Be concise.`,
    name: "Agent Team (frontend)",
    email: "agent-team+frontend@users.noreply.github.com",
  },

  backend: {
    system: `You are a senior Backend engineer specialising in NestJS and PostgreSQL.
Review API design, service logic, data models, and inter-service patterns. Be concise.`,
    name: "Agent Team (backend)",
    email: "agent-team+backend@users.noreply.github.com",
  },

  security: {
    system: `You are a Security engineer specialising in web application security.
Review for OWASP top 10, auth flaws, secrets, GDPR. Flag issues as: low | medium | high | critical.`,
    name: "Agent Team (security)",
    email: "agent-team+security@users.noreply.github.com",
  },

  database: {
    system: `You are a senior Database engineer specialising in PostgreSQL and Redis.
Review schema design, migrations, query efficiency, indexing, and caching strategy. Be concise.`,
    name: "Agent Team (database)",
    email: "agent-team+database@users.noreply.github.com",
  },

  devsecops: {
    system: `You are a DevSecOps engineer specialising in Kubernetes, Terraform, and Azure.
Review infra config, CI/CD pipelines, container security, and deployment strategy. Be concise.`,
    name: "Agent Team (devsecops)",
    email: "agent-team+devsecops@users.noreply.github.com",
  },
};

const ORCHESTRATOR_SYSTEM = `You are an autonomous Orchestrator for a software engineering agent team.
You MUST act immediately — never ask the user for clarification or more information.
If a request is vague, make reasonable assumptions and proceed.

Process (you MUST follow this every time):
1. PLAN — Briefly state which agents you are engaging and why (in your message content).
2. DELEGATE — Immediately call delegate_to_agent for each relevant specialist. Be specific in the task description you give each agent.
3. DISCUSS — If agents return conflicting answers, start a follow-up round referencing the conflict. Agents build on each other's work.
4. SYNTHESISE — Produce a clear, actionable final response that integrates all agent contributions.

CRITICAL RULES:
- ALWAYS delegate to at least one agent on the FIRST response. You are an orchestrator, not a chatbot.
- NEVER respond with just text on the first turn — you MUST call delegate_to_agent.
- After agents respond, use write_file to IMPLEMENT the changes directly — do NOT just describe what to change.
- When writing files, write the COMPLETE file content — not partial snippets.
- If a file already exists in the context, include all existing content with your modifications applied.
- If the user asks a general question, pick the most relevant agents and give them concrete tasks derived from the codebase context.
- Not every question needs all agents — choose wisely, but always choose at least one.
- Include your planning reasoning in the message content alongside the tool calls.
- Always synthesise — never relay raw agent output unchanged.

Available agents: ${Object.keys(AGENTS).join(", ")}.
Each agent is a senior specialist. Trust their expertise but verify consistency across responses.`;

// ─── Types ───────────────────────────────────────────────────────────────────
export interface RepoContext {
  repo: string;
  branch?: string;
  files: { path: string; content: string }[];
  diff?: string;
  repoInstructions?: { source: string; content: string }[];
}

export interface CoAuthor {
  agent: string;
  name: string;
  email: string;
  trailer: string; // "Co-authored-by: Name <email>"
}

export interface FileChange {
  path: string;
  content: string;
  agent: string;
}

export interface AgentRunResult {
  content: string;
  coAuthors: CoAuthor[];
  fileChanges: FileChange[];
}

export interface AgentRunOptions {
  teamId: string;
  sessionId: string;
  userMessage: string;
  repoContext?: RepoContext;
  onProgress?: (event: ProgressEvent) => void;
}

export interface ProgressEvent {
  type: "planning" | "agent_start" | "agent_done" | "file_written" | "final";
  agent?: string;
  task?: string;
  content?: string;
  agents?: string[];
  coAuthors?: CoAuthor[];
  fileChange?: FileChange;
}

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly client: AzureOpenAI;

  constructor(@InjectRedis() private readonly redis: Redis) {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT!;

    if (process.env.AZURE_OPENAI_API_KEY) {
      // Local dev — use API key
      this.client = new AzureOpenAI({
        endpoint,
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        apiVersion: API_VERSION,
      });
    } else {
      // Azure — use managed identity (no key needed)
      const credential = new DefaultAzureCredential();
      const azureADTokenProvider = getBearerTokenProvider(
        credential,
        "https://cognitiveservices.azure.com/.default",
      );
      this.client = new AzureOpenAI({
        endpoint,
        azureADTokenProvider,
        apiVersion: API_VERSION,
      });
    }
  }

  // ─── Public entry point ─────────────────────────────────────────────────────
  async run(opts: AgentRunOptions): Promise<AgentRunResult> {
    const { teamId, sessionId, userMessage, repoContext, onProgress } = opts;
    const key = this.sessionKey(teamId, sessionId);

    // Load conversation history for this team session
    const history = await this.loadHistory(key);

    // Build message with repo context if provided
    const enrichedMessage = repoContext
      ? this.buildContextMessage(userMessage, repoContext)
      : userMessage;

    history.push({ role: "user", content: enrichedMessage });

    const tools: ChatCompletionTool[] = [
      {
        type: "function",
        function: {
          name: "delegate_to_agent",
          description:
            "Send a task to a specialist agent and get their analysis.",
          parameters: {
            type: "object",
            properties: {
              agent: {
                type: "string",
                enum: Object.keys(AGENTS),
                description: "Which specialist agent to call",
              },
              task: {
                type: "string",
                description: "The specific question for this agent.",
              },
            },
            required: ["agent", "task"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "write_file",
          description:
            "Create or overwrite a file in the repository. Use this to implement changes directly — do not just suggest changes, write them.",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "Relative file path from the repo root, e.g. src/styles/globals.css",
              },
              content: {
                type: "string",
                description: "The complete file content to write.",
              },
            },
            required: ["path", "content"],
          },
        },
      },
    ];

    // Agentic loop — track which agents contributed and file changes
    let finalText = "";
    const contributingAgents = new Set<string>();
    const fileChanges: FileChange[] = [];
    const MAX_ITERATIONS = 10;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await this.client.chat.completions.create({
        model: DEPLOYMENT,
        max_tokens: 4096,
        messages: [
          { role: "system", content: ORCHESTRATOR_SYSTEM },
          ...history,
        ],
        tools,
        tool_choice: i === 0 ? "required" : "auto",
      });

      const choice = response.choices[0];
      const message = choice.message;

      // No tool calls → final answer
      if (!message.tool_calls?.length || choice.finish_reason === "stop") {
        finalText = message.content ?? "";
        history.push({ role: "assistant", content: finalText });

        const coAuthors = this.buildCoAuthors(contributingAgents);
        onProgress?.({ type: "final", content: finalText, coAuthors });
        break;
      }

      // Push assistant message with tool_calls into history
      history.push(message);

      // Separate delegation calls from file write calls
      const delegateCalls = message.tool_calls.filter(
        (c) => c.function.name === "delegate_to_agent",
      );
      const writeCalls = message.tool_calls.filter(
        (c) => c.function.name === "write_file",
      );

      // Handle file writes immediately
      const writeResults: ChatCompletionToolMessageParam[] = writeCalls.map(
        (call) => {
          const { path, content } = JSON.parse(call.function.arguments) as {
            path: string;
            content: string;
          };
          const lastAgent = [...contributingAgents].pop() ?? "orchestrator";
          const change: FileChange = { path, content, agent: lastAgent };
          fileChanges.push(change);
          onProgress?.({ type: "file_written", fileChange: change });
          return {
            role: "tool" as const,
            tool_call_id: call.id,
            content: `File written: ${path}`,
          };
        },
      );

      // Handle delegations
      if (delegateCalls.length) {
        const delegations = delegateCalls.map((call) => ({
          ...(JSON.parse(call.function.arguments) as {
            agent: string;
            task: string;
          }),
          callId: call.id,
        }));

        onProgress?.({
          type: "planning",
          agents: delegations.map((d) => d.agent),
          content: message.content ?? undefined,
        });

        const delegateResults: ChatCompletionToolMessageParam[] =
          await Promise.all(
            delegations.map(async ({ agent, task, callId }) => {
              onProgress?.({ type: "agent_start", agent, task });
              contributingAgents.add(agent);

              const result = await this.runSubAgent(
                agent,
                task,
                repoContext?.repoInstructions,
              );
              onProgress?.({ type: "agent_done", agent, content: result });

              return {
                role: "tool" as const,
                tool_call_id: callId,
                content: result,
              };
            }),
          );

        history.push(...delegateResults);
      }

      if (writeResults.length) {
        history.push(...writeResults);
      }
    }

    // Persist updated history back to Redis with TTL
    await this.saveHistory(key, history);

    const coAuthors = this.buildCoAuthors(contributingAgents);
    return { content: finalText, coAuthors, fileChanges };
  }

  // ─── Sub-agent runner ───────────────────────────────────────────────────────
  private async runSubAgent(
    name: string,
    task: string,
    repoInstructions?: { source: string; content: string }[],
  ): Promise<string> {
    const agentDef = AGENTS[name];
    if (!agentDef) return `Unknown agent: ${name}`;

    let systemPrompt = agentDef.system;

    if (repoInstructions?.length) {
      const instrBlock = repoInstructions
        .map((i) => `### ${i.source}\n${i.content}`)
        .join("\n\n");
      systemPrompt += `\n\n## Repository Instructions\nThe following instructions come from the repository being reviewed. You MUST follow them:\n\n${instrBlock}`;
    }

    const response = await this.client.chat.completions.create({
      model: DEPLOYMENT,
      max_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: task },
      ],
    });

    return response.choices[0].message.content ?? "";
  }

  // ─── Co-author builder ────────────────────────────────────────────────────
  private buildCoAuthors(agentNames: Set<string>): CoAuthor[] {
    return [...agentNames]
      .filter((name) => AGENTS[name])
      .map((name) => {
        const def = AGENTS[name];
        return {
          agent: name,
          name: def.name,
          email: def.email,
          trailer: `Co-authored-by: ${def.name} <${def.email}>`,
        };
      });
  }

  // ─── Context builder ─────────────────────────────────────────────────────────
  private buildContextMessage(userMessage: string, ctx: RepoContext): string {
    const parts: string[] = [];

    parts.push(`## Repository: ${ctx.repo}`);
    if (ctx.branch) parts.push(`Branch: ${ctx.branch}`);
    parts.push("");

    if (ctx.diff) {
      parts.push("## Diff");
      parts.push("```diff");
      parts.push(ctx.diff);
      parts.push("```");
      parts.push("");
    }

    if (ctx.files.length) {
      parts.push("## Files");
      for (const file of ctx.files) {
        const ext = file.path.split(".").pop() || "";
        parts.push(`### ${file.path}`);
        parts.push(`\`\`\`${ext}`);
        parts.push(file.content);
        parts.push("```");
        parts.push("");
      }
    }

    if (ctx.repoInstructions?.length) {
      parts.push("## Repository Instructions");
      parts.push(
        "The following instructions come from the repository. All agents MUST follow them:",
      );
      parts.push("");
      for (const instr of ctx.repoInstructions) {
        parts.push(`### ${instr.source}`);
        parts.push(instr.content);
        parts.push("");
      }
    }

    parts.push("## Task");
    parts.push(userMessage);

    return parts.join("\n");
  }

  // ─── Redis helpers ──────────────────────────────────────────────────────────
  private sessionKey(teamId: string, sessionId: string) {
    return `agent:session:${teamId}:${sessionId}`;
  }

  private async loadHistory(
    key: string,
  ): Promise<ChatCompletionMessageParam[]> {
    const raw = await this.redis.get(key);
    return raw ? JSON.parse(raw) : [];
  }

  private async saveHistory(
    key: string,
    history: ChatCompletionMessageParam[],
  ) {
    const trimmed = history.slice(-40);
    await this.redis.setex(key, SESSION_TTL, JSON.stringify(trimmed));
  }

  async clearSession(teamId: string, sessionId: string) {
    await this.redis.del(this.sessionKey(teamId, sessionId));
  }
}

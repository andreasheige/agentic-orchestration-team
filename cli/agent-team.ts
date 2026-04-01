#!/usr/bin/env tsx
// Run the agent team against any local repo
//
// Usage:
//   agent-team review src/auth/          Review specific files/folders
//   agent-team review --diff             Review uncommitted changes
//   agent-team review --pr               Review current branch vs main
//   agent-team ask "How should we..."    Ask a question about the codebase
//
// Environment:
//   AGENT_TEAM_URL    API base URL (default: http://localhost:3000)
//   AGENT_TEAM_TOKEN  JWT bearer token

import { execSync } from "child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  statSync,
  readdirSync,
  existsSync,
} from "fs";
import { join, relative, extname, resolve, dirname } from "path";
import { createInterface } from "readline";

// ─── Load .env automatically ─────────────────────────────────────────────────
function loadEnv() {
  // Walk up from cwd to find .env (handles running from subdirs)
  let dir = process.cwd();
  while (dir !== "/") {
    const envPath = join(dir, ".env");
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, "utf-8").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
      break;
    }
    dir = resolve(dir, "..");
  }
}
loadEnv();

// ─── Config ──────────────────────────────────────────────────────────────────
const API_URL = process.env.AGENT_TEAM_URL || "http://localhost:3000";
const TOKEN = process.env.AGENT_TEAM_TOKEN;

const MAX_FILE_SIZE = 50_000; // 50KB per file
const MAX_FILES = 30;

// Track co-authors from the last run for use in commit
let lastCoAuthors: {
  agent: string;
  name: string;
  email: string;
  trailer: string;
}[] = [];
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
  ".venv",
]);
const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".rb",
  ".yaml",
  ".yml",
  ".toml",
  ".md",
  ".sql",
  ".tf",
  ".hcl",
  ".sh",
  ".css",
  ".scss",
  ".html",
  ".vue",
  ".svelte",
  ".graphql",
  ".proto",
  ".env.example",
  ".gitignore",
  ".dockerignore",
  "Dockerfile",
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────
function git(cmd: string): string {
  return execSync(`git ${cmd}`, { encoding: "utf-8" }).trim();
}

function getRepoName(): string {
  try {
    const remote = git("remote get-url origin");
    // Extract "org/repo" from git URL
    const match = remote.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    return match?.[1] ?? remote;
  } catch {
    return process.cwd().split("/").pop() ?? "unknown";
  }
}

function getCurrentBranch(): string {
  try {
    return git("branch --show-current");
  } catch {
    return "unknown";
  }
}

function getDiff(mode: "uncommitted" | "pr"): string {
  if (mode === "uncommitted") {
    return git("diff HEAD");
  }
  // PR mode: diff current branch against main/master
  const base = (() => {
    try {
      git("rev-parse --verify main");
      return "main";
    } catch {
      return "master";
    }
  })();
  return git(`diff ${base}...HEAD`);
}

function collectFiles(
  paths: string[],
  rootDir: string,
): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];

  function walk(filePath: string) {
    if (files.length >= MAX_FILES) return;

    const stat = statSync(filePath);

    if (stat.isDirectory()) {
      const name = filePath.split("/").pop() ?? "";
      if (IGNORE_DIRS.has(name)) return;

      for (const child of readdirSync(filePath)) {
        walk(join(filePath, child));
      }
    } else if (stat.isFile() && stat.size <= MAX_FILE_SIZE) {
      const ext = extname(filePath);
      const basename = filePath.split("/").pop() ?? "";
      if (TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(basename)) {
        files.push({
          path: relative(rootDir, filePath),
          content: readFileSync(filePath, "utf-8"),
        });
      }
    }
  }

  for (const p of paths) {
    walk(join(rootDir, p));
  }

  return files;
}

// ─── Repo instruction detection ──────────────────────────────────────────────
const INSTRUCTION_FILES = [
  ".github/copilot-instructions.md",
  ".github/COPILOT_INSTRUCTIONS.md",
  "SOUL.md",
  "soul.md",
  ".cursorrules",
  "CLAUDE.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  ".ai-instructions.md",
];

function detectRepoInstructions(
  rootDir: string,
): { source: string; content: string }[] {
  const found: { source: string; content: string }[] = [];

  for (const relPath of INSTRUCTION_FILES) {
    try {
      const fullPath = join(rootDir, relPath);
      const stat = statSync(fullPath);
      if (stat.isFile() && stat.size <= MAX_FILE_SIZE) {
        found.push({
          source: relPath,
          content: readFileSync(fullPath, "utf-8"),
        });
      }
    } catch {
      // File doesn't exist — skip
    }
  }

  return found;
}

// ─── API calls ───────────────────────────────────────────────────────────────
async function submitTask(
  message: string,
  context: {
    repo: string;
    branch?: string;
    files: { path: string; content: string }[];
    diff?: string;
    repoInstructions?: { source: string; content: string }[];
  },
): Promise<string> {
  const res = await fetch(`${API_URL}/agent/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      message,
      sessionId: `cli:${context.repo}:${Date.now()}`,
      context: {
        repo: context.repo,
        branch: context.branch,
        files: context.files,
        diff: context.diff,
        repoInstructions: context.repoInstructions,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { jobId: string };
  return data.jobId;
}

function displayEvent(event: any) {
  switch (event.type) {
    case "planning":
      console.log(`\n🧠 Orchestrator:`);
      if (event.content) {
        for (const line of event.content.split("\n")) {
          console.log(`   ${line}`);
        }
      }
      if (event.agents?.length) {
        console.log(
          `   Engaging: ${event.agents.map((a: string) => `[${a}]`).join(" ")}`,
        );
      }
      console.log();
      break;

    case "agent_start":
      console.log(`   🔵 ${event.agent} starting...`);
      if (event.task) {
        const preview =
          event.task.length > 150 ? event.task.slice(0, 150) + "…" : event.task;
        console.log(`      Task: "${preview}"`);
      }
      break;

    case "agent_done":
      console.log(`\n   🟢 ${event.agent}:`);
      console.log(`   ${"─".repeat(50)}`);
      for (const line of (event.content ?? "").split("\n")) {
        console.log(`   ${line}`);
      }
      console.log(`   ${"─".repeat(50)}`);
      break;

    case "file_written":
      if (event.fileChange) {
        const fc = event.fileChange;
        const fullPath = join(process.cwd(), fc.path);
        const dir = dirname(fullPath);
        mkdirSync(dir, { recursive: true });
        writeFileSync(fullPath, fc.content, "utf-8");
        console.log(`\n   ✏️  Wrote: ${fc.path} (by ${fc.agent})`);
      }
      break;

    case "final":
      console.log(`\n${"═".repeat(60)}`);
      console.log(`📋 Orchestrator — Final Response`);
      console.log(`${"═".repeat(60)}`);
      console.log(event.content ?? "(no content)");
      console.log(`${"═".repeat(60)}`);
      break;
  }
}

async function streamResults(jobId: string): Promise<void> {
  const pollInterval = 800; // Fast polling to catch events in real-time
  const maxWait = 5 * 60 * 1000;
  const start = Date.now();
  let cursor = 0;
  let hasEvents = false;
  let sawFinalEvent = false;

  // Animated spinner
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let frame = 0;
  const spinner = setInterval(() => {
    if (!hasEvents) {
      process.stdout.write(
        `\r  ${frames[frame++ % frames.length]} Orchestrator is thinking...`,
      );
    }
  }, 80);

  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const res = await fetch(
      `${API_URL}/agent/result/${jobId}?after=${cursor}`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    );

    if (!res.ok) {
      clearInterval(spinner);
      throw new Error(`Poll error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as any;

    // Display new progress events
    if (data.events?.length) {
      if (!hasEvents) {
        clearInterval(spinner);
        // Clear the spinner line and move down
        process.stdout.write("\r" + " ".repeat(50) + "\r\n");
      }
      hasEvents = true;
      for (const event of data.events) {
        displayEvent(event);
        if (event.type === "final") sawFinalEvent = true;
      }
    }
    if (data.cursor !== undefined) {
      cursor = data.cursor;
    }

    if (data.status === "completed") {
      clearInterval(spinner);
      if (!hasEvents) {
        process.stdout.write("\r" + " ".repeat(50) + "\r\n");
      }

      // Apply file changes from the result (fallback if events were missed)
      if (data.result?.fileChanges?.length) {
        for (const fc of data.result.fileChanges) {
          const fullPath = join(process.cwd(), fc.path);
          const dir = dirname(fullPath);
          mkdirSync(dir, { recursive: true });
          writeFileSync(fullPath, fc.content, "utf-8");
          // Only show "Wrote" if we didn't already see it via events
          if (!hasEvents) {
            console.log(`   ✏️  Wrote: ${fc.path} (by ${fc.agent})`);
          }
        }
      }

      // Show result only if we didn't get a "final" event (which already displayed it)
      if (!sawFinalEvent && data.result?.content) {
        console.log(hasEvents ? "" : "\n");
        console.log(`\n${"═".repeat(60)}`);
        console.log(`📋 Orchestrator — Final Response`);
        console.log(`${"═".repeat(60)}`);
        console.log(data.result.content);
        console.log(`${"═".repeat(60)}`);
      }

      // Summary of written files
      if (data.result?.fileChanges?.length) {
        console.log(`\n📝 Files modified (${data.result.fileChanges.length}):`);
        for (const fc of data.result.fileChanges) {
          console.log(`   ✅ ${fc.path}`);
        }
      }

      if (data.result?.coAuthors?.length) {
        lastCoAuthors = data.result.coAuthors;
        console.log(`\n🤝 Contributing agents:`);
        for (const ca of data.result.coAuthors) {
          console.log(`   ${ca.trailer}`);
        }
      }
      return;
    }

    if (data.status === "failed") {
      clearInterval(spinner);
      throw new Error(`Job failed: ${data.error}`);
    }

    if (data.status === "not_found") {
      clearInterval(spinner);
      throw new Error("Job not found");
    }
  }

  clearInterval(spinner);
  throw new Error("Job timed out after 5 minutes");
}

// ─── Commands ────────────────────────────────────────────────────────────────
async function cmdReview(args: string[]) {
  const rootDir = process.cwd();
  const repo = getRepoName();
  const branch = getCurrentBranch();

  let diff: string | undefined;
  let files: { path: string; content: string }[] = [];
  let message =
    "Review this code. Identify issues, improvements, and security concerns.";

  // Parse flags
  const isDiff = args.includes("--diff");
  const isPr = args.includes("--pr");
  const paths = args.filter((a) => !a.startsWith("--"));

  if (isDiff) {
    diff = getDiff("uncommitted");
    message =
      "Review these uncommitted changes. Focus on correctness, security, and best practices.";
  } else if (isPr) {
    diff = getDiff("pr");
    message =
      "Review this pull request diff. Focus on correctness, security, breaking changes, and best practices.";
  }

  if (paths.length > 0) {
    files = collectFiles(paths, rootDir);
    console.log(`📁 Collected ${files.length} files from: ${paths.join(", ")}`);
  }

  if (!files.length && !diff) {
    console.error(
      "Nothing to review. Specify files/folders, or use --diff / --pr",
    );
    process.exit(1);
  }

  // Detect repo instruction files
  const repoInstructions = detectRepoInstructions(rootDir);
  if (repoInstructions.length) {
    console.log(`\n📋 Repo instructions detected:`);
    for (const instr of repoInstructions) {
      const lines = instr.content.split("\n").length;
      console.log(`   ✔ ${instr.source} (${lines} lines)`);
    }
    console.log(`   Agents will follow these instructions.\n`);
  }

  console.log(`📦 Repo: ${repo} (${branch})`);
  if (diff) console.log(`📝 Diff: ${diff.split("\n").length} lines`);

  const jobId = await submitTask(message, {
    repo,
    branch,
    files,
    diff,
    repoInstructions,
  });
  console.log(`🚀 Job submitted: ${jobId}`);

  await streamResults(jobId);
}

async function cmdAsk(args: string[]) {
  const question = args.join(" ");
  if (!question) {
    console.error('Usage: agent-team ask "Your question about the codebase"');
    process.exit(1);
  }

  const rootDir = process.cwd();
  const repo = getRepoName();
  const branch = getCurrentBranch();

  // Collect files from common source directories
  const sourceDirs = ["src", "lib", "app", "packages"].filter((d) => {
    try {
      return statSync(join(rootDir, d)).isDirectory();
    } catch {
      return false;
    }
  });

  const files = sourceDirs.length
    ? collectFiles(sourceDirs, rootDir)
    : collectFiles(["."], rootDir);

  // Detect repo instruction files
  const repoInstructions = detectRepoInstructions(rootDir);
  if (repoInstructions.length) {
    console.log(`\n📋 Repo instructions detected:`);
    for (const instr of repoInstructions) {
      const lines = instr.content.split("\n").length;
      console.log(`   ✔ ${instr.source} (${lines} lines)`);
    }
    console.log(`   Agents will follow these instructions.\n`);
  }

  console.log(`📦 Repo: ${repo} (${branch})`);
  console.log(`📁 Collected ${files.length} files for context`);

  const jobId = await submitTask(question, {
    repo,
    branch,
    files,
    repoInstructions,
  });
  console.log(`🚀 Job submitted: ${jobId}`);

  await streamResults(jobId);
}

// ─── Commit helper ───────────────────────────────────────────────────────────
async function cmdCommit(args: string[]) {
  const message = args.join(" ");
  if (!message) {
    console.error('Usage: agent-team commit "Your commit message"');
    process.exit(1);
  }

  // Read co-authors from env or last run
  const coAuthorsEnv = process.env.AGENT_TEAM_COAUTHORS;
  let trailers: string[] = [];

  if (coAuthorsEnv) {
    // From saved file: one trailer per line
    trailers = coAuthorsEnv.split("\n").filter(Boolean);
  } else if (lastCoAuthors.length) {
    trailers = lastCoAuthors.map((c) => c.trailer);
  } else {
    // Default: attribute to the orchestrator
    trailers = [
      "Co-authored-by: Agent Team (orchestrator) <agent-team+orchestrator@users.noreply.github.com>",
    ];
  }

  const fullMessage = [message, "", ...trailers].join("\n");

  console.log(`\n📝 Commit message:\n`);
  console.log(fullMessage);
  console.log();

  try {
    execSync(`git commit -m ${JSON.stringify(fullMessage)}`, {
      stdio: "inherit",
    });
  } catch {
    console.error(
      "Git commit failed. Make sure you have staged changes (git add).",
    );
    process.exit(1);
  }
}

// ─── Interactive chat session ────────────────────────────────────────────────
async function cmdChat() {
  const rootDir = process.cwd();
  const repo = getRepoName();
  const branch = getCurrentBranch();
  const sessionId = `chat:${repo}:${Date.now()}`;

  // Collect context once at startup
  const sourceDirs = ["src", "lib", "app", "packages"].filter((d) => {
    try {
      return statSync(join(rootDir, d)).isDirectory();
    } catch {
      return false;
    }
  });
  const files = sourceDirs.length
    ? collectFiles(sourceDirs, rootDir)
    : collectFiles(["."], rootDir);

  // Detect repo instruction files
  const repoInstructions = detectRepoInstructions(rootDir);

  console.log(`\n${"─".repeat(60)}`);
  console.log(`  Agent Team — Interactive Session`);
  console.log(`  📦 ${repo} (${branch}) · ${files.length} files loaded`);
  if (repoInstructions.length) {
    console.log(`  📋 Repo instructions loaded:`);
    for (const instr of repoInstructions) {
      console.log(`     ✔ ${instr.source}`);
    }
  }
  console.log(`  Type your message, or a command:`);
  console.log(`    /review <paths>   Review files`);
  console.log(`    /review --diff    Review uncommitted changes`);
  console.log(`    /clear            Clear session history`);
  console.log(`    /quit             Exit`);
  console.log(`${"─".repeat(60)}\n`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "you > ",
  });

  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Handle slash commands
    if (input === "/quit" || input === "/exit") {
      console.log("👋 Bye!");
      process.exit(0);
    }

    if (input === "/clear") {
      try {
        await fetch(`${API_URL}/agent/session/${sessionId}/clear`, {
          method: "POST",
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        console.log("🧹 Session cleared\n");
      } catch {
        console.log("⚠️  Could not clear session\n");
      }
      rl.prompt();
      return;
    }

    if (input.startsWith("/review")) {
      const args = input.slice(7).trim().split(/\s+/).filter(Boolean);
      try {
        await cmdReview(args.length ? args : ["--diff"]);
      } catch (err: any) {
        console.error(`❌ ${err.message}`);
      }
      console.log();
      rl.prompt();
      return;
    }

    // Regular message — send to agents
    try {
      const res = await fetch(`${API_URL}/agent/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
        },
        body: JSON.stringify({
          message: input,
          sessionId,
          context: { repo, branch, files, repoInstructions },
        }),
      });

      if (!res.ok) {
        console.error(`❌ API error ${res.status}: ${await res.text()}\n`);
        rl.prompt();
        return;
      }

      const data = (await res.json()) as { jobId: string };
      await streamResults(data.jobId);
    } catch (err: any) {
      console.error(`❌ ${err.message}`);
    }

    console.log();
    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\n👋 Bye!");
    process.exit(0);
  });
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!TOKEN) {
    console.error("Missing AGENT_TEAM_TOKEN. Set it to your JWT bearer token.");
    process.exit(1);
  }

  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "review":
      await cmdReview(args);
      break;
    case "ask":
      await cmdAsk(args);
      break;
    case "commit":
      await cmdCommit(args);
      break;
    case "chat":
    case undefined:
      await cmdChat();
      break;
    default:
      console.log(`
agent-team — Run your AI agent team against any codebase

Commands:
  (default)              Start interactive chat session
  chat                   Start interactive chat session
  review <paths...>      Review specific files or folders
  review --diff          Review uncommitted changes
  review --pr            Review current branch vs main
  ask "<question>"       Ask a question about the codebase
  commit "<message>"     Git commit with Co-authored-by trailers

Environment:
  AGENT_TEAM_URL         API base URL (default: http://localhost:3000)
  AGENT_TEAM_TOKEN       JWT bearer token (required)
  AGENT_TEAM_COAUTHORS   Override co-author trailers (one per line)

Examples:
  agent-team review src/auth/ src/api/
  agent-team review --pr
  agent-team ask "How should we restructure the database layer?"
  agent-team commit "refactor: extract payment service"
      `);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});

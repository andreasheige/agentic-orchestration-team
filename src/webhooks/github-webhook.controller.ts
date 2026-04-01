// Receives GitHub webhook events and feeds them to the agent team

import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  Logger,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import { Queue } from "bull";
import { createHmac, timingSafeEqual } from "crypto";
import { ConfigService } from "@nestjs/config";
import { GitHubService } from "../github/github.service";

interface PullRequestEvent {
  action: string;
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    diff_url: string;
    head: { ref: string; sha: string };
    base: { ref: string };
    user: { login: string };
  };
  repository: {
    full_name: string;
    default_branch: string;
  };
}

@Controller("webhooks/github")
export class GitHubWebhookController {
  private readonly logger = new Logger(GitHubWebhookController.name);
  private readonly webhookSecret: string;
  private readonly teamId: string;

  constructor(
    @InjectQueue("agent-jobs") private queue: Queue,
    private readonly github: GitHubService,
    config: ConfigService,
  ) {
    this.webhookSecret = config.get<string>("GITHUB_WEBHOOK_SECRET", "");
    this.teamId = config.get<string>("GITHUB_WEBHOOK_TEAM_ID", "github-ci");
  }

  @Post()
  @HttpCode(200)
  async handleWebhook(
    @Headers("x-github-event") event: string,
    @Headers("x-hub-signature-256") signature: string,
    @Body() body: PullRequestEvent,
    @Body() rawBody: any,
  ) {
    // Verify webhook signature if secret is configured
    if (this.webhookSecret) {
      const expected =
        "sha256=" +
        createHmac("sha256", this.webhookSecret)
          .update(JSON.stringify(rawBody))
          .digest("hex");

      const sig = Buffer.from(signature || "");
      const exp = Buffer.from(expected);
      if (sig.length !== exp.length || !timingSafeEqual(sig, exp)) {
        this.logger.warn("Invalid webhook signature");
        return { ignored: true, reason: "invalid signature" };
      }
    }

    // Only handle PR opened/synchronize events
    if (event !== "pull_request") {
      return { ignored: true, reason: `event type: ${event}` };
    }

    if (!["opened", "synchronize"].includes(body.action)) {
      return { ignored: true, reason: `action: ${body.action}` };
    }

    const pr = body.pull_request;
    const repo = body.repository.full_name;

    this.logger.log(
      `PR #${pr.number} ${body.action} on ${repo}: "${pr.title}"`,
    );

    // Fetch the diff using authenticated GitHub service
    const diff = await this.github.fetchPrDiff(repo, pr.number);

    // Attempt to fetch repo instruction files
    const INSTRUCTION_FILE_PATHS = [
      ".github/copilot-instructions.md",
      "SOUL.md",
      "CLAUDE.md",
      "AGENTS.md",
      "CONTRIBUTING.md",
      ".cursorrules",
      ".ai-instructions.md",
    ];
    const repoInstructions: { source: string; content: string }[] = [];
    await Promise.all(
      INSTRUCTION_FILE_PATHS.map(async (filePath) => {
        const content = await this.github.fetchFileContent(
          repo,
          filePath,
          pr.head.ref,
        );
        if (content) {
          repoInstructions.push({ source: filePath, content });
        }
      }),
    );
    if (repoInstructions.length) {
      this.logger.log(
        `📋 Repo instructions detected for ${repo}: ${repoInstructions.map((i) => i.source).join(", ")}`,
      );
    }

    const message = [
      `Review this pull request.`,
      ``,
      `**PR #${pr.number}:** ${pr.title}`,
      `**Author:** ${pr.user.login}`,
      `**Branch:** ${pr.head.ref} → ${pr.base.ref}`,
      pr.body ? `\n**Description:**\n${pr.body}` : "",
      ``,
      `Focus on: correctness, security vulnerabilities, breaking changes, performance, and best practices.`,
    ].join("\n");

    const jobId = `${this.teamId}:pr-${pr.number}:${Date.now()}`;

    await this.queue.add(
      "orchestrate",
      {
        teamId: this.teamId,
        sessionId: `pr:${repo}:${pr.number}`,
        userMessage: message,
        repoContext: {
          repo,
          branch: pr.head.ref,
          files: [],
          diff,
          repoInstructions,
        },
        jobId,
        // Tell the processor to post the review comment back on the PR
        postReviewTo: { repo, prNumber: pr.number },
      },
      {
        jobId,
        attempts: 2,
        backoff: { type: "exponential", delay: 2000 },
      },
    );

    this.logger.log(`Enqueued review job ${jobId} for PR #${pr.number}`);

    return {
      accepted: true,
      jobId,
      pr: pr.number,
      repo,
    };
  }
}

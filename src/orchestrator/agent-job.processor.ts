// BullMQ processor — picks jobs from the queue and runs the orchestrator

import { Process, Processor } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import { Job } from "bull";
import {
  OrchestratorService,
  ProgressEvent,
  RepoContext,
  AgentRunResult,
} from "./orchestrator.service";
import { AgentController } from "./agent.controller";
import { GitHubService } from "../github/github.service";

interface AgentJobData {
  teamId: string;
  sessionId: string;
  userMessage: string;
  repoContext?: RepoContext;
  jobId: string;
  // Set by webhook: post review comment back to PR
  postReviewTo?: { repo: string; prNumber: number };
}

@Processor("agent-jobs")
export class AgentJobProcessor {
  private readonly logger = new Logger(AgentJobProcessor.name);

  constructor(
    private readonly orchestrator: OrchestratorService,
    private readonly agentController: AgentController,
    private readonly github: GitHubService,
  ) {}

  @Process("orchestrate")
  async handleOrchestrate(job: Job<AgentJobData>) {
    const { teamId, sessionId, userMessage, repoContext, jobId, postReviewTo } =
      job.data;
    this.logger.log(`Processing job ${jobId} for team ${teamId}`);

    try {
      const result: AgentRunResult = await this.orchestrator.run({
        teamId,
        sessionId,
        userMessage,
        repoContext,
        onProgress: (event: ProgressEvent) => {
          this.agentController.pushEvent(jobId, event);
        },
      });

      // Post review comment back to GitHub PR if requested
      if (postReviewTo && result.content) {
        const { repo, prNumber } = postReviewTo;
        const coAuthorBlock = result.coAuthors.length
          ? `\n\n---\n**Contributing agents:** ${result.coAuthors.map((c) => c.agent).join(", ")}`
          : "";
        await this.github.submitPrReview(
          repo,
          prNumber,
          result.content + coAuthorBlock,
        );
      }

      this.logger.log(`Job ${jobId} completed`);
      return result;
    } catch (error) {
      this.logger.error(`Job ${jobId} failed: ${error}`);

      // Push error to SSE stream so the client knows
      this.agentController.pushEvent(jobId, {
        type: "final",
        content:
          "An error occurred while processing your request. Please try again.",
      });

      throw error;
    }
  }
}

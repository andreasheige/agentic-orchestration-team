// Accepts requests from any team, enqueues a job, streams progress via SSE

import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Sse,
  UseGuards,
  Request,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import { Queue } from "bull";
import { Observable, ReplaySubject } from "rxjs";
import { map } from "rxjs/operators";
import { JwtAuthGuard } from "../auth/jwt.guard";
import { OrchestratorService } from "./orchestrator.service";

interface SseEvent {
  type: string;
  agent?: string;
  task?: string;
  content?: string;
  agents?: string[];
  coAuthors?: any[];
  fileChange?: { path: string; content: string; agent: string };
}

export interface RepoContext {
  repo: string;
  branch?: string;
  files: { path: string; content: string }[];
  diff?: string; // unified diff for PR reviews
  repoInstructions?: { source: string; content: string }[];
}

@Controller("agent")
@UseGuards(JwtAuthGuard)
export class AgentController {
  // Active SSE streams, keyed by jobId
  private streams = new Map<string, ReplaySubject<MessageEvent>>();
  // Progress events for polling clients
  private progressEvents = new Map<string, SseEvent[]>();

  constructor(
    @InjectQueue("agent-jobs") private queue: Queue,
    private readonly orchestrator: OrchestratorService,
  ) {}

  // POST /agent/run — enqueues work, returns jobId immediately
  @Post("run")
  async run(
    @Body()
    body: {
      message: string;
      sessionId: string;
      context?: RepoContext;
    },
    @Request() req: any,
  ) {
    const teamId = req.user.teamId;
    const jobId = `${teamId}:${Date.now()}`;

    // Create the SSE subject before enqueuing so no events are lost
    const subject = new ReplaySubject<MessageEvent>();
    this.streams.set(jobId, subject);

    // Auto-cleanup after 5 min if nobody connects
    setTimeout(
      () => {
        if (this.streams.has(jobId)) {
          this.streams.get(jobId)?.complete();
          this.streams.delete(jobId);
        }
        this.progressEvents.delete(jobId);
      },
      5 * 60 * 1000,
    );

    await this.queue.add(
      "orchestrate",
      {
        teamId,
        sessionId: body.sessionId,
        userMessage: body.message,
        repoContext: body.context,
        jobId,
      },
      {
        jobId,
        attempts: 2,
        backoff: { type: "exponential", delay: 2000 },
      },
    );

    return { jobId };
  }

  // GET /agent/stream/:jobId — SSE endpoint the client subscribes to
  @Sse("stream/:jobId")
  stream(@Param("jobId") jobId: string): Observable<MessageEvent> {
    // Subject already created in run() — reuse it, or create one for late arrivals
    let subject = this.streams.get(jobId);
    if (!subject) {
      subject = new ReplaySubject<MessageEvent>();
      this.streams.set(jobId, subject);
    }

    return subject.asObservable().pipe(map((event) => event));
  }

  // Called by the worker processor to push SSE events
  pushEvent(jobId: string, event: SseEvent) {
    // Store event for polling clients
    if (!this.progressEvents.has(jobId)) {
      this.progressEvents.set(jobId, []);
    }
    this.progressEvents.get(jobId)!.push(event);

    // Push to SSE stream
    const subject = this.streams.get(jobId);
    if (subject) {
      subject.next({ data: JSON.stringify(event) } as MessageEvent);

      if (event.type === "final") {
        subject.complete();
        setTimeout(() => this.streams.delete(jobId), 60_000);
      }
    }

    // Cleanup progress events after 2 min
    if (event.type === "final") {
      setTimeout(() => this.progressEvents.delete(jobId), 120_000);
    }
  }

  // GET /agent/result/:jobId — poll for job result (used by CLI)
  @Get("result/:jobId")
  async getResult(
    @Param("jobId") jobId: string,
    @Query("after") after?: string,
  ) {
    const events = this.progressEvents.get(jobId) ?? [];
    const afterIdx = after ? parseInt(after, 10) : 0;
    const newEvents = events.slice(afterIdx);
    const cursor = events.length;

    const job = await this.queue.getJob(jobId);
    if (!job) {
      return { status: "not_found", events: newEvents, cursor };
    }
    const state = await job.getState();
    if (state === "completed") {
      return {
        status: "completed",
        result: job.returnvalue,
        events: newEvents,
        cursor,
      };
    }
    if (state === "failed") {
      return {
        status: "failed",
        error: job.failedReason,
        events: newEvents,
        cursor,
      };
    }
    return { status: state, events: newEvents, cursor };
  }

  // POST /agent/session/:sessionId/clear — clear a team's conversation
  @Post("session/:sessionId/clear")
  async clearSession(
    @Param("sessionId") sessionId: string,
    @Request() req: any,
  ) {
    await this.orchestrator.clearSession(req.user.teamId, sessionId);
    return { cleared: true, sessionId };
  }
}

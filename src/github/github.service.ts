// Centralised GitHub API client — authenticated with GITHUB_TOKEN

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

const GITHUB_API = "https://api.github.com";

export interface GitHubUser {
  login: string;
  id: number;
  name: string | null;
  email: string | null;
}

@Injectable()
export class GitHubService {
  private readonly logger = new Logger(GitHubService.name);
  private readonly token: string;

  constructor(config: ConfigService) {
    this.token = config.get<string>("GITHUB_TOKEN", "");
    if (!this.token) {
      this.logger.warn(
        "GITHUB_TOKEN not set — GitHub API calls will be unauthenticated (lower rate limits, no write access)",
      );
    }
  }

  // ─── Auth helpers ──────────────────────────────────────────────────────────
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...extra,
    };
    if (this.token) {
      h.Authorization = `Bearer ${this.token}`;
    }
    return h;
  }

  get isAuthenticated(): boolean {
    return !!this.token;
  }

  // ─── User info ─────────────────────────────────────────────────────────────
  async getAuthenticatedUser(): Promise<GitHubUser | null> {
    if (!this.token) return null;
    const res = await fetch(`${GITHUB_API}/user`, {
      headers: this.headers(),
    });
    if (!res.ok) return null;
    return (await res.json()) as GitHubUser;
  }

  // ─── Pull request diff ────────────────────────────────────────────────────
  async fetchPrDiff(repo: string, prNumber: number): Promise<string> {
    const url = `${GITHUB_API}/repos/${repo}/pulls/${prNumber}`;
    const res = await fetch(url, {
      headers: this.headers({ Accept: "application/vnd.github.v3.diff" }),
    });

    if (!res.ok) {
      this.logger.warn(
        `Failed to fetch diff for ${repo}#${prNumber}: ${res.status}`,
      );
      return "";
    }

    let diff = await res.text();

    // Truncate very large diffs
    if (diff.length > 100_000) {
      diff = diff.slice(0, 100_000) + "\n\n... [diff truncated at 100KB]";
    }
    return diff;
  }

  // ─── PR review comment (summary comment on PR) ────────────────────────────
  async postPrComment(
    repo: string,
    prNumber: number,
    body: string,
  ): Promise<boolean> {
    if (!this.token) {
      this.logger.warn("Cannot post PR comment — GITHUB_TOKEN not set");
      return false;
    }

    const url = `${GITHUB_API}/repos/${repo}/issues/${prNumber}/comments`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ body }),
    });

    if (!res.ok) {
      this.logger.warn(
        `Failed to post comment on ${repo}#${prNumber}: ${res.status} ${await res.text()}`,
      );
      return false;
    }

    this.logger.log(`Posted review comment on ${repo}#${prNumber}`);
    return true;
  }

  // ─── PR review (formal approve/comment/request-changes) ───────────────────
  async submitPrReview(
    repo: string,
    prNumber: number,
    body: string,
    event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES" = "COMMENT",
  ): Promise<boolean> {
    if (!this.token) {
      this.logger.warn("Cannot submit PR review — GITHUB_TOKEN not set");
      return false;
    }

    const url = `${GITHUB_API}/repos/${repo}/pulls/${prNumber}/reviews`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ body, event }),
    });

    if (!res.ok) {
      this.logger.warn(
        `Failed to submit review on ${repo}#${prNumber}: ${res.status}`,
      );
      return false;
    }

    this.logger.log(`Submitted ${event} review on ${repo}#${prNumber}`);
    return true;
  }

  // ─── Fetch file content from a repo ────────────────────────────────────────
  async fetchFileContent(
    repo: string,
    path: string,
    ref?: string,
  ): Promise<string | null> {
    const url = new URL(`${GITHUB_API}/repos/${repo}/contents/${path}`);
    if (ref) url.searchParams.set("ref", ref);

    const res = await fetch(url.toString(), {
      headers: this.headers(),
    });

    if (!res.ok) return null;

    const data = (await res.json()) as { content?: string; encoding?: string };
    if (data.encoding === "base64" && data.content) {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    return null;
  }
}

# Repo Workflows — Using Agent Team Across Projects

This guide explains how to point the agent team at any repository (backend, frontend, tools, libs) and feed it tasks.

---

## Integration Methods

| Method             | Best For                                     | Trigger          |
| ------------------ | -------------------------------------------- | ---------------- |
| **CLI**            | Ad-hoc reviews, questions from your terminal | Manual           |
| **GitHub Webhook** | Automatic PR reviews                         | PR opened / push |
| **API Direct**     | CI pipelines, scripts, other services        | Programmatic     |

---

## 1. CLI Tool

The CLI lives in `cli/agent-team.ts`. Run it from **any** repo.

### Setup

```bash
# Set once in your shell profile
export AGENT_TEAM_URL=https://your-agent-team.azurecontainerapps.io
export AGENT_TEAM_TOKEN=<your-jwt>
```

### Commands

#### Review files

```bash
# Review specific paths
npx ts-node /path/to/agent-team-app/cli/agent-team.ts review src/auth/ src/middleware/

# Review git diff (uncommitted changes)
npx ts-node /path/to/agent-team-app/cli/agent-team.ts review --diff

# Review PR diff (current branch vs main)
npx ts-node /path/to/agent-team-app/cli/agent-team.ts review --pr
```

#### Ask a question about the codebase

```bash
npx ts-node /path/to/agent-team-app/cli/agent-team.ts ask "Should we migrate the auth module to use OAuth2?"
```

### Alias (recommended)

Add to `~/.zshrc` or `~/.bashrc`:

```bash
alias agent-team="npx ts-node /path/to/agent-team-app/cli/agent-team.ts"
```

Then:

```bash
cd ~/repos/backend-api
agent-team review src/controllers/
agent-team ask "How can we improve error handling in the payment module?"

cd ~/repos/frontend-app
agent-team review --pr
```

---

## 2. GitHub Webhook (Automatic PR Reviews)

The webhook controller listens at `POST /webhooks/github` and automatically reviews PRs when they are opened or updated.

### Setup

1. **Add a webhook** on your GitHub repo (or organization):
   - **Payload URL:** `https://your-agent-team.azurecontainerapps.io/webhooks/github`
   - **Content type:** `application/json`
   - **Secret:** A random string (set as `GITHUB_WEBHOOK_SECRET` in your `.env`)
   - **Events:** Select **Pull requests**

2. **Configure environment variables:**

   ```env
   GITHUB_WEBHOOK_SECRET=your-random-secret
   GITHUB_WEBHOOK_TEAM_ID=github-ci  # teamId used for webhook jobs
   ```

3. **That's it.** Every PR opened or pushed to will be automatically reviewed by the agent team.

### What happens on a PR event

1. GitHub sends the PR event to `/webhooks/github`
2. The controller verifies the webhook signature
3. Fetches the PR diff from GitHub
4. Enqueues a review job with the diff as `RepoContext`
5. The orchestrator delegates to the relevant agents (security, backend, frontend, etc.)
6. Results are stored in the session `pr:<repo>:<number>`

### Retrieving results

Stream the results via SSE:

```bash
curl -N -H "Authorization: Bearer $TOKEN" \
  "$AGENT_TEAM_URL/agent/stream/<jobId>"
```

The `jobId` is returned in the webhook response.

---

## 3. Direct API Calls

Send code context directly to the API from any script or CI pipeline.

### Request format

```bash
curl -X POST "$AGENT_TEAM_URL/agent/run" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Review this code for security issues",
    "sessionId": "ci-review-123",
    "context": {
      "repo": "myorg/backend-api",
      "branch": "feature/payments",
      "diff": "diff --git a/src/pay.ts ...",
      "files": [
        { "path": "src/pay.ts", "content": "..." },
        { "path": "src/validate.ts", "content": "..." }
      ]
    }
  }'
```

### RepoContext schema

```typescript
interface RepoContext {
  repo: string; // e.g. "myorg/backend-api"
  branch?: string; // e.g. "feature/payments"
  files: Array<{
    // source files for context
    path: string;
    content: string;
  }>;
  diff?: string; // unified diff (git diff output)
}
```

### CI Pipeline example (GitHub Actions)

```yaml
name: Agent Team Review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Get diff
        id: diff
        run: |
          DIFF=$(git diff origin/main...HEAD)
          echo "diff<<EOF" >> $GITHUB_OUTPUT
          echo "$DIFF" >> $GITHUB_OUTPUT
          echo "EOF" >> $GITHUB_OUTPUT

      - name: Submit for review
        run: |
          curl -s -X POST "${{ secrets.AGENT_TEAM_URL }}/agent/run" \
            -H "Authorization: Bearer ${{ secrets.AGENT_TEAM_TOKEN }}" \
            -H "Content-Type: application/json" \
            -d "$(jq -n \
              --arg msg "Review this PR for correctness, security, and best practices." \
              --arg repo "${{ github.repository }}" \
              --arg branch "${{ github.head_ref }}" \
              --arg diff "${{ steps.diff.outputs.diff }}" \
              '{message: $msg, sessionId: "pr-\($repo)-\($branch)", context: {repo: $repo, branch: $branch, diff: $diff, files: []}}'
            )"
```

---

## Repo-Specific Tips

### Backend repos

```bash
# Review API routes and middleware
agent-team review src/controllers/ src/middleware/ src/auth/

# Ask about architecture
agent-team ask "Is our service layer properly decoupled from the data layer?"
```

### Frontend repos

```bash
# Review components
agent-team review src/components/ src/hooks/

# Review state management
agent-team review src/store/ src/context/
```

### Shared libraries

```bash
# Review public API surface
agent-team review src/index.ts src/types/

# Ask about breaking changes
agent-team ask "Will these changes break downstream consumers?"
```

### Infrastructure / DevOps

```bash
# Review Terraform changes
agent-team review infra/

# Review Dockerfiles and CI
agent-team review Dockerfile .github/workflows/
```

---

## Multi-Repo Setup

For organizations with many repos, the recommended setup is:

1. **GitHub webhook at the org level** — covers all repos automatically
2. **CLI on dev machines** — for ad-hoc reviews and questions
3. **GitHub Actions** — for repos that need custom review logic

All three methods share the same agent team instance and the same specialist agents (frontend, backend, security, database, devsecops) analyze the code based on its content, regardless of which repo it comes from.

# API Reference

> All endpoints are served from the API Gateway at `https://<your-domain>` (port 3000 locally).

## Authentication

Every request must include a JWT Bearer token:

```
Authorization: Bearer <jwt>
```

### JWT Payload Schema

```json
{
  "sub": "user-123", // userId
  "teamId": "team-abc", // tenant isolation key
  "email": "dev@example.com", // audit trail
  "iat": 1711324800,
  "exp": 1711353600 // 8h default expiry
}
```

The `teamId` claim is **mandatory** — it determines which Redis session namespace the request operates within. Requests without a valid JWT receive `401 Unauthorized`.

---

## Endpoints

### `POST /agent/run`

Submit a task to the orchestrator. The request is enqueued immediately and a `jobId` is returned — the actual processing happens asynchronously in the worker pool.

**Request:**

```bash
curl -X POST https://api.example.com/agent/run \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Review the authentication flow in our Next.js app",
    "sessionId": "session-001"
  }'
```

**Request Body:**

| Field       | Type     | Required | Description                                |
| ----------- | -------- | -------- | ------------------------------------------ |
| `message`   | `string` | Yes      | The user's task or question                |
| `sessionId` | `string` | Yes      | Groups messages into a conversation thread |

**Response:** `200 OK`

```json
{
  "jobId": "team-abc:1711324800000"
}
```

**Behavior:**

- Creates a Bull job with 2 retry attempts and exponential backoff (2s base)
- `jobId` is `{teamId}:{timestamp}` — unique and traceable
- Subscribe to `/agent/stream/:jobId` to receive progress events

---

### `GET /agent/stream/:jobId` (SSE)

Server-Sent Events endpoint for real-time progress updates. Connect after receiving a `jobId` from `/agent/run`.

**Request:**

```bash
curl -N https://api.example.com/agent/stream/team-abc:1711324800000 \
  -H "Accept: text/event-stream"
```

**Event Types:**

#### `agent_start`

Emitted when the orchestrator delegates to a sub-agent.

```
data: {"type":"agent_start","agent":"frontend"}
```

#### `agent_done`

Emitted when a sub-agent completes its analysis.

```
data: {"type":"agent_done","agent":"frontend","content":"## Frontend Review\n\nThe component structure looks..."}
```

#### `final`

Emitted when the orchestrator produces its synthesised response. **This is always the last event** — the stream closes after it.

```
data: {"type":"final","content":"## Summary\n\nBased on the frontend and security reviews..."}
```

**Timeouts & Cleanup:**

- Streams auto-close after **5 minutes** if no final event arrives
- Streams are cleaned up from the server-side map on client disconnect

**Client Example (JavaScript):**

```javascript
const eventSource = new EventSource(
  `https://api.example.com/agent/stream/${jobId}`,
);

eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);

  switch (data.type) {
    case "agent_start":
      console.log(`🔄 ${data.agent} agent working...`);
      break;
    case "agent_done":
      console.log(`✅ ${data.agent}: ${data.content}`);
      break;
    case "final":
      console.log(`📋 Final: ${data.content}`);
      eventSource.close();
      break;
  }
};
```

---

### `POST /agent/session/:sessionId/clear`

Clear the conversation history for the authenticated team's session.

**Request:**

```bash
curl -X POST https://api.example.com/agent/session/session-001/clear \
  -H "Authorization: Bearer $JWT"
```

**Response:** `200 OK`

```json
{
  "cleared": true,
  "sessionId": "session-001"
}
```

**Behavior:**

- Deletes the Redis key `agent:session:{teamId}:{sessionId}`
- The next message to this `sessionId` starts a fresh conversation
- Only clears the authenticated team's session (isolation enforced by JWT)

---

## Error Responses

| Status                      | Meaning                                          |
| --------------------------- | ------------------------------------------------ |
| `401 Unauthorized`          | Missing or invalid JWT                           |
| `400 Bad Request`           | Missing required fields (`message`, `sessionId`) |
| `500 Internal Server Error` | Unexpected server error                          |

If a job fails during processing, the SSE stream will emit a `final` event with an error message:

```
data: {"type":"final","content":"An error occurred while processing your request. Please try again."}
```

Failed jobs are retried up to **2 times** with exponential backoff (2s → 4s) before the error event is pushed.

---

## Rate Limits & Quotas

| Dimension                | Limit         | Notes                                       |
| ------------------------ | ------------- | ------------------------------------------- |
| Concurrent jobs per team | 1             | One active orchestration per team at a time |
| Max session history      | 40 messages   | Older messages trimmed automatically        |
| Session TTL              | 24 hours      | Redis expiry — start fresh after 24h        |
| SSE stream timeout       | 5 minutes     | Server closes idle streams                  |
| Job retries              | 2 attempts    | Exponential backoff: 2s, 4s                 |
| Max orchestration loops  | 10 iterations | Safety cap on the agentic loop              |

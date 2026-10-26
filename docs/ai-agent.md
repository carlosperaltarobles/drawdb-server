# AI Diagram Agent — Backend Operations Guide

## 1. Overview

The drawDB backend provides an authenticated AI assistant under `/api/projects/:id/ai` that connects to a configured LiteLLM proxy (`GET /v1/models` and `POST /v1/chat/completions`).
- **Private conversations**: Conversations, messages, generations, and unconfirmed proposals are private to their owner (`userId` + `projectId`).
- **Role enforcement**: Project `viewer` members can converse and analyze schemas using read-only context tools. Only `editor` and `admin` members can generate, preview, discard, or apply diagram modification proposals.
- **Atomic collaboration**: Confirmed proposals are validated against the full current diagram in `RoomManager`, serialized via `ProjectQueue` with manual edits, restorations, and deferred saves, persisted in a single PostgreSQL transaction alongside a `pre_ai_apply` recovery snapshot, and broadcast to all connected Socket.IO collaborators.

## 2. Environment Configuration

Configure the following variables in the backend environment (never in frontend bundles or versioned files):

| Variable | Default | Description |
| --- | --- | --- |
| `AI_ENABLED` | `false` | Master switch (`true` or `1` to enable). Requires `LITELLM_BASE_URL` and `LITELLM_API_KEY`. When disabled, `/api/projects/:id/ai/*` answers `503 { "error": "ai_disabled" }` to authorized project members. |
| `LITELLM_BASE_URL` | `""` | Base URL of the LiteLLM proxy (with or without trailing `/v1`; normalized to a single `/v1`). |
| `LITELLM_API_KEY` | `""` | Server-side credential for LiteLLM. Never exposed in responses, logs, or SSE events. |
| `LITELLM_MODEL` | `null` | Optional default model alias when a new conversation does not specify one. Does not restrict the catalog or force a silent fallback. |
| `AI_ALLOWED_MODELS` | `null` | Optional comma-separated allowlist of model aliases permitted by policy. |
| `AI_MODEL_CAPABILITIES` | `{}` | JSON map of verified per-alias capabilities: `{"gemini-4-argon":{"chat":true,"tools":true,"json":true,"stream":true,"contextWindow":128000,"maxOutputTokens":4096}}`. Unknown capabilities remain `null` (not authorized for proposals). |
| `AI_CATALOG_TTL_MS` | `60000` | Model catalog cache TTL per `(connection, policyScope)` in ms. |
| `AI_CATALOG_REFRESH_MIN_MS` | `10000` | Minimum interval per user for explicit `?refresh=1` catalog revalidation. |
| `AI_GENERATION_TIMEOUT_MS` | `60000` | Maximum duration per generation (60 seconds). |
| `AI_MAX_ROUNDS` | `12` | Maximum tool/repair rounds per generation. |
| `AI_MAX_PROPOSAL_OPS` | `500` | Maximum operations per single proposal revision. |
| `AI_MAX_CONTEXT_BYTES` | `204800` | Maximum schema context bytes per provider call (200 KiB). |
| `AI_MAX_MESSAGE_CHARS` | `8000` | Maximum characters per user message. |
| `AI_MAX_RECENT_MESSAGES` | `20` | Maximum recent canonical messages included in prompt context. |
| `AI_MAX_ACTIVE_PER_USER` | `1` | Maximum concurrent active generations per user. |
| `AI_MAX_ACTIVE_GLOBAL` | `4` | Maximum concurrent active generations across the server instance. |
| `AI_RATE_LIMIT_USER_PER_MIN` | `10` | Maximum generation requests per minute per user. |
| `AI_RATE_LIMIT_PROJECT_PER_MIN` | `30` | Maximum generation requests per minute per project. |

## 3. Verifying Model Capabilities vs. Text Connectivity

A simple text response (`CONEXION_OK`) only proves basic chat connectivity; it does **not** prove support for structured tool calls or JSON schema proposals. Before enabling proposal generation for a model alias in `AI_MODEL_CAPABILITIES`, run the manual capability probe script using environment variables (never pass API keys on the command line):

```bash
LITELLM_BASE_URL="https://your-litellm-proxy" \
LITELLM_API_KEY="$LITELLM_API_KEY" \
npx ts-node scripts/ai-capabilities.ts gemini-4-argon
```

Only set `"tools": true` or `"json": true` in `AI_MODEL_CAPABILITIES` for aliases that pass the corresponding synthetic probe. Models with `chat: true` and `tools: null, json: null` remain available in the selector for schema analysis and Q&A while clearly indicating that diagram modification proposals are unavailable.

## 4. Collaboration Topology & Single-Instance Requirement

`RoomManager` and `ProjectQueue` coordinate in-memory room state, version numbers, epochs, deferred saves, restorations, and atomic AI proposal confirmations within a single Node.js process. Keep the deployment configured as a **single collaboration instance** (matching the existing Socket.IO room architecture). Scaling horizontally to multiple backend replicas would require distributed room locking and cross-instance state coordination before enabling concurrent edits.

## 5. Migrations, Retention, and Rollback

- **Migration**: `prisma/migrations/20261026120000_ai_agent/migration.sql` adds the `pre_ai_apply` value to `SnapshotKind` and creates `ai_conversations`, `ai_messages`, `ai_proposals`, and `ai_generations`. Apply with `npm run migrate` (`prisma migrate deploy`).
- **Retention**:
  - Pending proposals expire after **24 hours** (`expires_at`).
  - Inactive conversations and non-applied proposals (`superseded`, `discarded`, `expired`) are pruned after **30 days** of inactivity (`startAiRetention`).
  - `pre_ai_apply` safety snapshots in `project_snapshots` are retained for **30 days** alongside `pre_restore` and `pre_bulk_delete`, without being throttled by the bulk-delete cooldown.
  - Deleting a private AI conversation deletes its private messages and proposals (`ON DELETE CASCADE`), but **preserves** all `project_snapshots` (`pre_ai_apply`) already created in the shared project history (`ON DELETE SET NULL`).
- **Emergency Disable / Rollback**:
  - Set `AI_ENABLED=false` and restart/redeploy the backend to immediately disable all AI endpoints (`503 ai_disabled`) without affecting normal diagram editing, Socket.IO collaboration, or version history.

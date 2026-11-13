# Shared History for Distributed opencode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give opencode sessions running on independent hosts access to one common, queryable history of all work, plus independent cross-host session forks, without modifying opencode.

**Architecture:** A TypeScript/Bun monorepo with three packages: `shared` (event contracts, HTTP client, seed helpers), `service` (central Bun HTTP API backed by PostgreSQL), `plugin` (a stock opencode v2 plugin per host that captures bus events to a local JSONL outbox, syncs asynchronously, and registers agent tools for search/transcript/fork).

**Tech Stack:** Bun 1.4.4, TypeScript, `postgres` (postgres.js), `hono`, `bun test`, PostgreSQL 16 (Docker for dev/test), opencode v2.2.7 plugin API (stock).

**Spec:** `docs/superpowers/specs/2026-11-12-shared-history-design.md` — read it first. The plan implements Option B as approved.

## Global Constraints

- **Never modify the opencode checkout** (`/Users/vasily/code/opencode`); it is a read-only API reference. All new code lives in this project.
- opencode target: **v2.2.7**, stock binary. Verified plugin API facts to rely on (from source recon):
  - Plugin module: `export default { id: "shared-history", setup(ctx) { ... } }`.
  - `ctx.event.subscribe({ types: [...] })` returns an Effect `Stream` of public events; unknown type strings are warned and ignored, never fatal.
  - `ctx.tool.transform((editor) => editor.add(tool))` registers tools; `Tool.Info` lives at `packages/schema/src/tool.ts`.
  - `ctx.session.create({ title?, metadata?, location? })` creates a session; **never pass `parentID`** (that creates a hidden subagent child).
  - `ctx.session.prompt` admits messages; the v2 contract supports `resume: false` = **admit-only, agent does not wake** (see `packages/opencode` root AGENTS.md "Session Core").
- Secrets: narrow guarantee only (owner decision). Content syncs unredacted; never read `auth.json` or opencode config. Treat central DB and outboxes as sensitive.
- Tool payload text truncated to **4096 bytes** at capture, before the outbox.
- Sync must be fully asynchronous: capture never blocks or fails an agent step.
- Allowed new runtime dependencies: `postgres`, `hono`. Everything else is Bun built-ins + dev tooling (`typescript`, `@types/bun`).
- Style: TypeScript, no semicolons, 120-column prettier; avoid `any`; validate unknown input once at boundaries (service ingest, outbox replay, env parsing).
- Every package runs tests from **its own directory** with `bun test`.
- Commit after every task; conventional commit messages (`feat:`, `test:`, `docs:`, `chore:`).

## Review Focus

Most likely failure modes, each pinned to the task whose tests own it:

1. **Service unreachable for hours** (offline/airgapped host) → records retained in outbox, no agent-visible errors, flush resumes on reconnect. → Task 7 test `sync - offline keeps records and recovers`.
2. **Duplicate/out-of-order delivery** (retries after ack lost) → ingest idempotent on `(host, event_id)`; transcript order stable. → Task 2 test `insertEvents - duplicate batch is a no-op`.
3. **User searches containing `%` or `_`** → literal match, not wildcard explosion. → Task 2 test `searchEvents - escapes LIKE metacharacters`.
4. **Crash mid-outbox-write leaves a torn last line** → replay skips the torn tail, no data loss of prior lines. → Task 6 test `readOutbox - tolerates truncated final line`.
5. **`history_seed` must not start agent work** → admit-only prompt (`resume: false`), new independent session id. → Task 8 test `seed - admits context without execution` + Task 10 manual e2e assertion.
6. **Unknown/new event types on future opencode versions** → allowlist mapper ignores them silently. → Task 5 test `mapEvent - unknown type returns undefined`.

---

### Task 1: Workspace scaffold + shared event contracts

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `bunfig.toml`, `.gitignore`, `prettier.config.json` (repo root)
- Create: `shared/package.json`, `shared/tsconfig.json`
- Create: `shared/src/event.ts`, `shared/src/event.test.ts`

**Interfaces:**
- Produces: `type HistoryEvent = { host: string; eventId: string; sessionId: string | null; project: string; ts: string /* ISO 8601 */; kind: HistoryEventKind; content: string; payload: Record<string, unknown> }`
- `type HistoryEventKind = "session.created" | "session.renamed" | "message" | "tool" | "execution"` (a string union owned here; stored as `kind` text in Postgres).
- `decodeHistoryEvent(input: unknown): HistoryEvent` — throws `Error` listing the first offending field; `decodeHistoryEventBatch(input: unknown): HistoryEvent[]`.
- Every field required except `sessionId`; `content` is the searchable plain-text projection of the record (may be `""`).
- Package name `@shared/contracts`? **No** — package name is `shared` (private monorepo), import via workspace `shared/event`.

- [ ] **Step 1: Scaffold the root + `shared` package.** Root `package.json`: `{ "name": "opencode-shared-history", "private": true, "workspaces": ["shared", "service", "plugin"] }`, `devDependencies: { "typescript": "^6", "@types/bun": "^1.4" }`. `.gitignore`: `node_modules/`, `dist/`, `*.local`. Bun 1.4.4 must be on PATH (owner's machine: `~/code/.bun/bin`).
- [ ] **Step 2: Write failing tests in `shared/src/event.test.ts`** — `decodeHistoryEvent accepts a valid record` (all fields round-trip), `rejects missing host`, `rejects non-ISO ts`, `batch rejects if any item invalid`.

```ts
import { test, expect } from "bun:test"
import { decodeHistoryEvent, decodeHistoryEventBatch } from "./event"

const valid = { host: "alpha", eventId: "e1", sessionId: "s1", project: "/p", ts: new Date(0).toISOString(), kind: "message", content: "hello", payload: {} }

test("accepts a valid record", () => expect(decodeHistoryEvent(valid).eventId).toBe("e1"))
test("rejects missing host", () => expect(() => decodeHistoryEvent({ ...valid, host: "" })).toThrow("host"))
test("rejects non-ISO ts", () => expect(() => decodeHistoryEvent({ ...valid, ts: "yesterday" })).toThrow("ts"))
test("batch rejects if any item invalid", () => expect(() => decodeHistoryEventBatch([valid, { ...valid, kind: "nope" }])).toThrow("kind"))
```

- [ ] **Step 3: Run `bun test` in `shared/`** — expect FAIL (module `./event` has no exports yet).
- [ ] **Step 4: Implement `shared/src/event.ts`** — hand-rolled type guards (no validation library), signatures above; `ts` validated with `Number.isNaN(Date.parse(ts))` plus a `T` check; `kind` checked against the union.
- [ ] **Step 5: Run `bun test` in `shared/`** — expect PASS (4 tests).
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: workspace scaffold and history event contracts"`.

### Task 2: Service — PostgreSQL schema and storage queries

**Files:**
- Create: `service/package.json` (deps: `postgres`; script `db:up`: `docker compose up -d db`)
- Create: `service/docker-compose.yml` (postgres:16-alpine, db/user/password `history`, host port **54329** to avoid clashing with any local PG, volume `pgdata`)
- Create: `service/src/migrations/001_init.sql`
- Create: `service/src/db.ts`, `service/src/db.test.ts`

**Interfaces:**
- Consumes: `HistoryEvent`, `decodeHistoryEventBatch` from `shared/event` (Task 1).
- Produces: `connect(databaseUrl?: string): Sql` — default `process.env.DATABASE_URL` else `postgres://history:history@localhost:54329/history`; applies `001_init.sql` idempotently (`CREATE TABLE IF NOT EXISTS`).
- `insertEvents(sql: Sql, events: HistoryEvent[]): Promise<{ inserted: number }>` — multi-row insert, `ON CONFLICT (host, event_id) DO NOTHING`.
- `searchEvents(sql, { query, host?, project?, since?, limit = 20 }): Promise<HistoryEvent[]>` — `content ILIKE '%' || escaped || '%'` where `escaped` replaces `\`, `%`, `_` with escaped variants and the query specifies `ESCAPE '\'`; `since` is an ISO timestamp lower bound on `ts`; order `ts DESC`, `limit` capped at 100.
- `type SessionSummary = { host: string; sessionId: string; project: string; firstSeen: string; lastSeen: string }`; `listSessions(sql): Promise<SessionSummary[]>` — aggregate grouped by host/session, ordered `lastSeen DESC`.
- `transcript(sql, host: string, sessionId: string): Promise<HistoryEvent[]>` — order `ts ASC, eventId ASC`, no content truncation.

- [ ] **Step 1: Write `001_init.sql`** — table `events(host text not null, event_id text not null, session_id text, project text not null, ts timestamptz not null, kind text not null, payload jsonb not null default '{}', content text not null default '', primary key(host, event_id))`; index `events_session_idx(session_id, ts)`, `events_project_idx(project, ts)`. Note in a comment: stored `session_id` is `(host, sessionId)`-scoped in practice, addressed by both columns.
- [ ] **Step 2: Write failing `db.test.ts`**, guarded setup: `const sql = connect()`; beforeAll inserts nothing but applies migration; afterAll `sql.end()`. Tests:
  - `insertEvents - duplicate batch is a no-op`: insert one fixture event, `inserted === 1`; insert identical event again → `inserted === 0`; `transcript` still returns 1 row.
  - `searchEvents - escapes LIKE metacharacters`: seed content `100% coverage` and `100x coverage`; query `100%` returns exactly the first.
  - `searchEvents - filters by host and project and caps limit`.
  - `transcript - orders by ts ascending`.
- [ ] **Step 3: `docker compose up -d db` (from `service/`) then `bun test`** — expect FAIL (no `db.ts` exports).
- [ ] **Step 4: Implement `db.ts` + wire `shared` workspace dep (`"shared": "workspace:*"`).**
- [ ] **Step 5: Re-run `bun test`** — expect PASS. **If Docker is unavailable, stop and report rather than silently skipping DB tests** (fallback: any local PG 16 with `DATABASE_URL` set).
- [ ] **Step 6: Commit** — `feat: postgres storage and history queries`.

### Task 3: Service — HTTP API + auth, and the shared HTTP client

**Files:**
- Create: `service/src/app.ts` (Hono app factory), `service/src/index.ts` (start), `service/src/app.test.ts`
- Create: `shared/src/client.ts`, tested from `service/src/app.test.ts` (real server, no fetch mocks)
- Modify: `service/package.json` (add `hono`, start script `bun run src/index.ts`)

**Interfaces:**
- Produces HTTP surface (spec-pinned): `POST /events` (batch array body), `GET /search?query&host&project&since&limit`, `GET /sessions`, `GET /sessions/:host/:sessionId/transcript`, `GET /health`.
- Auth: every route except `/health` requires `Authorization: Bearer ${HISTORY_TOKEN}`; missing server token at startup = throw `Error("HISTORY_TOKEN required")`.
- Errors: invalid body → 400 `{ error: string }`; wrong token → 401; transcript of unknown session → 200 `[]` (a session with zero events is not an error).
- Produces shared client: `createHistoryClient({ url, token }): { ingest(events: HistoryEvent[]): Promise<void>; search(params): Promise<HistoryEvent[]>; sessions(): Promise<SessionSummary[]>; transcript(host, sessionId): Promise<HistoryEvent[]> }`, using global `fetch`, 10 s timeout, throws `Error("history service <status>: <body>")` on non-2xx.

- [ ] **Step 1: Write failing tests** in `app.test.ts`: start app from `buildApp(sql, token)` on port 0 in beforeAll. Cases: `GET /health` 200 without token; `POST /events` 401 without token; 400 for malformed batch (`[{host:"x"}]`); full roundtrip — client `ingest` two events then `search({query:"needle"})` finds one, `transcript` returns both ordered; unknown-session transcript returns `[]`.
- [ ] **Step 2: Run tests** — FAIL.
- [ ] **Step 3: Implement `app.ts`** (Hono; zod-free — reuse `decodeHistoryEventBatch`, map thrown errors to 400), thin route handlers calling Task 2 functions; `index.ts` reads `PORT` (default **8797**), `DATABASE_URL`, `HISTORY_TOKEN`.
- [ ] **Step 4: Implement `shared/src/client.ts`** with the exact signatures above.
- [ ] **Step 5: `bun test`** in `service/` — all green including Task 2 tests.
- [ ] **Step 6: Commit** — `feat: history service http api and shared client`.

### Task 4: Human CLI (`oc-history`)

**Files:**
- Create: `service/src/cli.ts`, `service/src/cli.test.ts`
- Modify: `service/package.json` (`"bin": { "oc-history": "./src/cli.ts" }`)

**Interfaces:**
- Consumes: `createHistoryClient` (Task 3).
- Invocation: `bun run service/src/cli.ts <command> [args]`; env `HISTORY_URL` (required), `HISTORY_TOKEN`.
- Commands: `search <query> [--host H] [--project P] [--since ISO] [--limit N]`; `sessions`; `transcript <host> <sessionId>` (prints `[iso ts] kind: content` lines). `seed` is added in Task 8, not here.
- Output: plain aligned text lines, one result per line: `<ISO ts>  <host>  <sessionId>  <content snippet, single line, max 120 chars>`. Unknown command → usage text on stderr, exit 2. Unconfigured `HISTORY_URL` → clear error, exit 1.

- [ ] **Step 1: Failing tests** — call `runCli(argv: string[], env)` directly (export it from `cli.ts`); `usage exit 2 on unknown command`, `missing HISTORY_URL exits 1 with actionable message`, `search prints rows from a running service` (reuse the Task 3 test server boot helper — extract `startTestService()` into `service/src/testkit.ts`).
- [ ] **Step 2–5:** run/fail → implement parse + handlers → run/pass → commit `feat: oc-history command line client`.

### Task 5: Plugin — event mapper and capture allowlist

**Files:**
- Create: `plugin/package.json`, `plugin/tsconfig.json` (no runtime deps)
- Create: `plugin/src/mapper.ts`, `plugin/src/mapper.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (pure function + shared types).
- Produces: `mapEvent(input: { host: string; project: string; event: { type: string; [k: string]: unknown } }): HistoryEvent | undefined`.
- Allowlist (exact event strings, from v2.2.7 `packages/schema/src/session-event.ts`):
  - `session.created`, `session.renamed` → kind `session.created` / `session.renamed`, content = title if present.
  - `session.message.content.updated` and `session.text.ended` → kind `message`, content = the message text (field names verified in Step 2).
  - `session.tool.called`, `session.tool.success`, `session.tool.failed` → kind `tool`, content = `<tool name> <status> <truncated text>`.
  - `session.execution.started|succeeded|failed|interrupted` → kind `execution`, content = status line.
  - **Everything else returns `undefined`** (deltas, reasoning, usage, synthetic inbox traffic never recorded). **Amended after e2e (commit c06e987):** `session.inbox.enqueued` with `item.type === "user"` IS captured (kind "message", exact admitted prompt text) — assistant replay events alone silently dropped user prompts. Synthetic/compaction/move inbox traffic remains ignored.
- Content truncation helper `clip(text: string, max = 4096): string` appends `…[truncated]` when clipping. Tool payload text is clipped **at capture**, inside `mapEvent`.
- The mapper only reads ordinary string/object fields; payloads like Effect values, so verify actual field names from source in Step 2 — the fixtures must match reality, not invention.

- [ ] **Step 1: Verify payload field names** against `packages/schema/src/session-event.ts` and the projector (`packages/core/src/session/projector.ts`); write down which field carries text for `session.text.ended` and tool name/output for tool events in a header comment of `mapper.ts`.
- [ ] **Step 2: Write failing tests** — fixtures per allowlist group, plus `mapEvent - unknown type returns undefined` (`session.text.delta`), `mapEvent - clips tool output to 4096 bytes`, `mapEvent - session.created carries title`.
- [ ] **Step 3:** `bun test` in `plugin/` — FAIL. **Step 4:** implement mapper. **Step 5:** PASS.
- [ ] **Step 6: Commit** — `feat: map opencode session events to history records`.

### Task 6: Plugin — JSONL outbox

**Files:**
- Create: `plugin/src/outbox.ts`, `plugin/src/outbox.test.ts`

**Interfaces:**
- `outboxPath()` = `process.env.HISTORY_OUTBOX` else `~/.local/share/opencode-shared-history/outbox.jsonl`.
- `append(events: HistoryEvent[]): Promise<void>` — creates dirs, appends lines, single-writer safe (in-process queue).
- `readPending(): Promise<HistoryEvent[]>` — tolerant reader: malformed/torn final line is skipped with a `console.warn`, earlier valid lines returned; records validate via `decodeHistoryEventBatch`-per-line (skip individually invalid lines, warn).
- `ack(count: number): Promise<void>` — drops the first `count` records by writing the remainder to `outbox.jsonl.tmp` then renaming over the original.
- File growth bound: at 10 MB the oldest half is discarded and one `console.warn` line is logged (documented data-shed policy; the service already holds everything acked).

- [ ] **Step 1: Failing tests** (temp file per test via `HISTORY_OUTBOX`): `append/read roundtrip preserves order`; `readOutbox - tolerates truncated final line`; `ack removes exactly the acked prefix`; `replay skips individually invalid lines`.
- [ ] **Step 2–5:** fail → implement → pass → commit `feat: durable local outbox for history events`.

### Task 7: Plugin — async sync loop

**Files:**
- Create: `plugin/src/sync.ts`, `plugin/src/sync.test.ts`

**Interfaces:**
- `createSyncLoop({ client?: ReturnType<typeof createHistoryClient>; intervalMs = 2000; onError?: (e: unknown) => void }): { notify(): void; stop(): void }`.
- Behavior: `notify()` schedules an immediate flush (debounced); flush also runs every `intervalMs`; single-flight (overlapping triggers coalesce). Flush = `readPending()` → batches of **100** → `client.ingest(batch)` → `ack(n)` only after a successful response. On failure: `onError` (default `console.warn` once per failure streak) and exponential backoff capped at 60 s, interval otherwise unchanged. No `client` (HISTORY_URL unset) → loop is a no-op.
- Recovery: records stay in the outbox until acked, across process restarts.

- [ ] **Step 1: Failing integration test** `sync - offline keeps records and recovers`: boot real test service from `service/src/testkit.ts`, seed outbox with 3 events while client points at a dead port (`http://127.0.0.1:1`), call `notify()`, assert no throw and `readPending()` still has 3; repoint client to the live test service, `notify()`, await one flush, assert service `transcript` contains 3 and `readPending()` is empty. Plus `sync - no client means no-op`.
- [ ] **Step 2–5:** fail → implement → pass → commit `feat: asynchronous resilient history sync`.

### Task 8: Plugin wiring, agent tools, and fork seeding

**Files:**
- Create: `plugin/src/index.ts` (default export `{ id, setup }`), `plugin/src/tools.ts`
- Create: `shared/src/seed.ts`, `shared/src/seed.test.ts`
- Modify: `service/src/cli.ts` (add `seed <host> <sessionId>`)

**Interfaces:**
- `condenseTranscript(events: HistoryEvent[], budget = 16000): string` — chronological Markdown transcript: keeps `message`/`session.*` content in full; `tool` events become one-line summaries (`- tool <name>: ok|failed`), never full tool output; newest messages win if over budget; prepends `Forked from host <host>, session <id>. Original below.` header.
- `seedSession(ctx, client, { host, sessionId }): Promise<{ newSessionId: string }>` — `client.transcript(host, sessionId)` → `condenseTranscript` → `ctx.session.create({ title: `Fork of ${sessionId} on ${host}`, metadata: { forkedFrom: { host, sessionId } } })` → admit the condensed text as a user message via `ctx.session.prompt` with **`resume: false`** (verify the exact parameter name against `Session.prompt` in `packages/core/src/session.ts`; if named differently use the source's admit-only flag) → return id. **No `parentID`, no agent execution, no second prompt.**
- Tools registered via `ctx.tool.transform(editor => editor.add(...))`, names exactly `history_search`, `history_transcript`, `history_seed`, each description starting with one-line purpose. Handlers call the shared client; unconfigured service → return the literal text `history service not configured (set HISTORY_URL and HISTORY_TOKEN)` instead of throwing.
- `setup(ctx)`: builds client when env present, starts outbox + sync loop, subscribes `ctx.event.subscribe()` (no `types` filter — the mapper allowlists), writes mapped records via `append` + `notify()`, registers tools. Plugin load errors must never break opencode: top-level `setup` catches and `console.warn`s.
- CLI `seed <host> <sessionId>`: prints instructions + creates the session through the **local** opencode server HTTP API using the same `condenseTranscript`; local server address from `opencode service status` if available, else error text telling the user to start opencode first. If the direct local-server API proves awkward, fallback allowed: print the condensed transcript to a temp file plus the exact `opencode --session` instructions instead of creating the session — note the fallback in README.

- [ ] **Step 1: Failing unit tests** for `condenseTranscript` (`drops tool payloads`, `prepends fork header`, `respects budget by dropping oldest`).
- [ ] **Step 2: Failing integration tests** in `plugin/`: `seed - admits context without execution` — against real test service + a **stub `ctx.session`** recording calls (this stub is fine: it is an external host boundary, not opencode internals): assert create called without `parentID`, prompt called with `resume: false` and condensed content, returned id propagated. `tools - search returns formatted snippets`; `tools - unconfigured returns instructions text`.
- [ ] **Step 3:** run/fail. **Step 4:** implement `seed.ts`, `tools.ts`, `index.ts`, CLI `seed`. **Step 5:** run/pass.
- [ ] **Step 6:** commit `feat: history tools and independent session forking`.

### Task 9: Installation docs and host setup script

**Files:**
- Create: `README.md`, `plugin/install.sh`

**Interfaces:**
- `plugin/install.sh`: copies `plugin/` into `~/.config/opencode/plugins/shared-history/` (create dir if absent) — first verify against v2.2.7 source which directory local plugins load from and use that exact one; prints env exports to add (`HISTORY_URL`, `HISTORY_TOKEN`, optional `HISTORY_HOST`), and a reminder to restart opencode.
- README sections: overview diagram (3 hosts → 1 service), service setup (docker compose + `bun run start`), per-host install, agent tool examples, CLI examples, fork workflow incl. "files travel via git, narrative travels via this service", offline behavior, security note (content unredacted by design), troubleshooting (service unreachable, plugin not loaded).

- [ ] **Step 1:** install.sh must be idempotent (`bash install.sh` twice → same result) and shellcheck-clean if shellcheck is available (`command -v shellcheck` guard).
- [ ] **Step 2:** run the installer on this machine, confirm files land where v2.2.7 actually discovers them.
- [ ] **Step 3:** commit `docs: installation and operations guide`.

### Task 10: Manual end-to-end smoke (two fake hosts on one machine)

**Files:** none — checklist recorded in `README.md` under "E2E smoke".

- [x] **Step 1 — PASS:** Start service (docker PG + `HISTORY_TOKEN=dev PORT=8797 bun run start` in `service/`).
- [x] **Step 2 — PASS:** Two isolated opencode "hosts" on this machine using separate homes, e.g. `HOME=/tmp/osh-a opencode run --standalone --prompt "Host alpha: remember decision X"` and `HOME=/tmp/osh-b ...` with `HISTORY_HOST=alpha|beta`, `HISTORY_URL=http://localhost:8797`, `HISTORY_TOKEN=dev`, plugin preinstalled into those config homes via `plugin/install.sh`.
- [x] **Step 3 — PASS:** After ~5 s, `oc-history sessions` shows host `alpha`; from host B, agent `history_search "decision X"` finds it. Expected: snippet carries `host=alpha`.
- [x] **Step 4 — PASS:** Fork: on B, CLI `oc-history seed alpha <sessionId>`; verify the new session through opencode CLI/API under HOME B. New id ≠ original, condensed history is present as the admitted user message, **no agent turn fires**, original session on A unchanged.
- [x] **Step 5 — PASS:** Final fixed-mapper replay recovered automatically at 24 seconds within the 90-second bound; search `99302` returned the admitted user prompt and alpha outbox pending count was zero.
- [x] **Step 6 — PASS:** Stopped after assertion 5 and filed exact bug evidence in `.superpowers/sdd/2026-11-12-shared-history/task-10-report.md`; committed checklist results in README and these checkboxes.

---

## Self-Review Notes

- Spec coverage: capture (T5), buffering (T6), async sync (T7), API+auth+idempotency (T2–T3), CLI (T4+T8), agent tools (T8), fork/seed with no execution (T8), offline and narrow-secrets constraints (T7 + global), docs/install/e2e (T9–T10). Web UI excluded per spec non-goals.
- Type consistency: `HistoryEvent`, `createHistoryClient`, `createSyncLoop`, `condenseTranscript`, `seedSession`, `runCli`, `startTestService` are the exact names tasks consume/produce.
- Event-name strings are copied verbatim from v2.2.7 `session-event.ts`; API route strings and env names are identical across tasks.

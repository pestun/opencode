# Design: Shared history for distributed opencode sessions

Date: 2026-11-12
Status: approved (owner approval 2026-11-12, after builder check)
Project home: `/Users/vasily/code/opencode-shared-history` (new project, not a fork of opencode)

## Intent and why

The owner develops **distributed client-server applications**, and uses opencode
sessions on multiple hosts at once. Each session must work with the files and
processes **of the host it runs on** (that is the point: running and debugging
components on each host of the distributed system). Today each host has its own
opencode server and its own SQLite database, so the history of work is trapped
per host. The owner wants every session, on every host, to have access to the
**common history** of work across all hosts.

opencode's central-server arrangement (one server, N thin clients) was
considered and explicitly rejected: it forces all execution onto one host,
which defeats host-local development.

## Goals

- Capture the history (sessions, user/assistant messages, tool activity) of
  every opencode host into one central, queryable store.
- Let an **agent** on any host pull relevant cross-host history into its
  context (search + transcript fetch) while it works.
- Let the **human** query the same store from any host (CLI on top of the API).
- Support cross-host continuation by **seeding a new local session** with
  another host's transcript.
- Stock, unmodified opencode on every host; upstream upgrades keep working.

## Non-goals

- Native resume-anywhere in the TUI (`--continue` landing inside another
  host's session as if it were local).
- Multiple hosts executing the same session (no distributed execution,
  fencing, or locking of sessions).
- Sharing files, workspaces, credentials, or opencode configuration.
- Modifying or forking opencode itself.
- Web UI (v1 is API + CLI + agent tools only; a UI can come later).
- opencode V1 support (owner now runs v2.2.7 built from source; V1 may be
  added later if other hosts need it).

## Anti-goals

- Breaking a working session when the central service is unreachable
  (offline, VPN down, airgapped). Sync must be asynchronous and buffered.
- Secret scope is deliberately **narrow** (owner decision, 2026-11-12):
  opencode's credential store (`auth.json`) and opencode configuration are
  never captured. Message and tool content is synced **as-is** apart from
  truncation; it **may contain secrets** printed by tools (e.g. an agent
  running `env`). The owner accepts this because the central store is
  private/trusted. No redaction pass in v1; treat the central DB and local
  outboxes as sensitive accordingly.
- Adding latency to the agent hot path.

## Constraints

- v2 plugin API only: plugins are TypeScript/JavaScript modules loaded by
  the stock opencode build (v2.2.7 confirmed available locally at
  `/Users/vasily/code/opencode` for reference). Known-relevant surface:
  `Plugin.Context["event"]["subscribe"]` and tool registration in
  `packages/core/src/plugin/host.ts` (~lines 284, 506). Exact event names,
  payload shapes, and tool schemas must be verified against this source
  during implementation.
- No new requirement on opencode release timing; works with v2.0.4+ plugin
  contracts, developed/tested against 2.2.7.
- Every host may be offline or on a different network at any time.

## Approaches considered

- **A — Postgres storage-engine fork of opencode**: replace SQLite in
  `@opencode/core` with PostgreSQL, all hosts sharing one DB. Gives native
  resume-anywhere, but requires porting the Drizzle dialect layer, schemas,
  migrations, and ~50 `json_extract` call sites, plus permanent fork
  maintenance; and v2's process-local session ownership makes concurrent
  cross-host resume unsafe without added fencing. **Rejected**: too much
  build and maintenance for the actual requirement.
- **B — Stock hosts + central history service via plugin (CHOSEN)**: a plugin
  on each host streams session events to a central history service backed by
  PostgreSQL, and registers agent tools to search/fetch that history. No
  fork, small blast radius, the collector's schema is owned by this project.
- **C — SQLite replication between hosts**: Litestream-style replication is
  single-writer; multi-host writes do not merge. **Rejected**.
- **D — Upstream placement/clustering**: sanctioned long-term direction
  (opencode `Location`/`workspaceID` concepts), but unbuilt and dependent on
  maintainers. Left to the future; this project does not conflict with it.

## The design (Option B)

Two components in one new monorepo, plus docs. Language/toolchain everywhere:
**TypeScript on Bun** (the same toolchain opencode itself uses; the owner's
macOS dev host has Bun 1.4.4).

```
opencode-shared-history/
  docs/superpowers/specs/2026-11-12-shared-history-design.md  (this file)
  plugin/            # installed on every opencode host
  service/           # central history service, runs on one host of the owner's choosing
  README.md          # install + configuration per host
```

### 1. Per-host plugin (`plugin/`)

Installed as a local plugin file/directory on each opencode host (no npm
publish needed; opencode loads local plugins from its plugin directory or a
config entry — exact v2 install mechanics to be confirmed in source).

Responsibilities:

1. **Capture**: subscribe to session events via the plugin context. Record
   session start/end, user messages, assistant text, and tool call activity
   (name + truncated input/output). Each record carries: host id, project
   directory, session id, event id, timestamp, kind, payload.
2. **Buffer (outbox)**: append records to a local JSONL outbox,
   `~/.local/share/opencode-shared-history/outbox.jsonl`. A background flush
   loop batches records to the service (`POST /events`) with retry/backoff.
   Failed delivery never blocks or fails the agent. Flushed batches are
   removed from the outbox; the service is idempotent so retries are safe.
3. **Read tools for the agent**, registered by the plugin:
   - `history_search({ query, host?, project?, since?, limit? })` — full-text
     and metadata search across all hosts' history, returns matching snippets
     with host/project/session/timestamp references.
   - `history_transcript({ sessionId, host? })` — fetch an ordered transcript
     of one session.
   - `history_seed({ sessionId, host? })` — fetch a transcript, condense it
     (preserve decisions and outcomes, drop bulky tool output), and start a
     new **local** session with that condensed history as its initial
     context, so the local agent continues the work with host-local files.
     Exact mechanism (local server API vs plugin context) to be settled
     during implementation against v2.2.7 source.
     (Builder call, post-review: seeding **creates and returns** the new
     session id/title and never auto-submits a prompt; every call creates a
     fresh session. The human opens and starts it explicitly.)

     **Fork semantics (owner-clarified requirement)**: seeding is an
     *independent fork*, never a shared session. The fork gets a new local
     session id on the destination host; the original on the source host is
     untouched. After forking, each session runs and syncs its further
     history under its own id — no concurrent-writer problem, no fencing
     needed. Two boundaries of the fork: (a) it receives a **condensed
     transcript as initial context**, not a byte-identical copy of internal
     session state; (b) **file contents do not travel** — the fork works on
     destination-host files, and synchronizing the code itself is a job for
     git (push on A, pull on B), which complements this design.
4. **Configuration** (env, same names on every host):
   - `HISTORY_URL` — base URL of the central service (required to sync).
   - `HISTORY_TOKEN` — shared bearer token.
   - `HISTORY_HOST` — stable host identity; default machine hostname.
   - Plugin loads and works even when `HISTORY_URL` is unset: capture still
   writes to the local outbox, tools return a clear "not configured" error.

### 2. Central history service (`service/`)

Small Bun HTTP service, one instance, runs wherever the owner chooses (one of
the existing hosts is fine). Plain SQL via the `postgres` npm package; no ORM
(builder call: the schema is tiny and search is SQL-friendly).

API (all behind `Authorization: Bearer <HISTORY_TOKEN>`):

- `POST /events` — batch ingest; idempotent on `(host, event_id)`; accepts
  out-of-order and duplicate deliveries.
- `GET /search?query=&host=&project=&since=&limit=` — snippet search.
- `GET /sessions/:host/:sessionId/transcript` — ordered events for a session.
- `GET /sessions` — list known sessions with host/project/time bounds.
- `GET /health` — liveness, no auth.

PostgreSQL schema (single table plus indexes; exact DDL in implementation):

- `events(host text, event_id text, session_id text, project text,
  ts timestamptz, kind text, payload jsonb, content text,
  UNIQUE(host, event_id))`
- Indexes on `(session_id, ts)`, `(project, ts)`, and `content` for v1
  `ILIKE` search. (Postgres full-text/trigram indexes are a documented
  follow-up, not v1.)

Operational rules:

- Tool inputs/outputs truncated to a fixed budget (default 4 KB per record)
  at the plugin, before anything leaves the host.
- The opencode credential store and opencode config are never captured;
  message/tool content is unredacted apart from truncation (see Anti-goals).
- Deployment: single `bun run` process plus PostgreSQL; connection string via
  `DATABASE_URL`; listen address/port via env. Remote hosts reach it however
  the owner's network already works (LAN, VPN, or SSH tunnel); TLS is the
  owner's network responsibility in v1.
- Backup is ordinary Postgres backup; the host outboxes remain a secondary
  copy until acknowledged.

### 3. Human access

A small CLI script in `service/` (or run via `curl`): `search`, `sessions`,
`transcript`, and `seed` subcommands wrapping the same API. No separate TUI
integration in v1.

(Builder call, post-review: CLI `seed` runs on the machine that should own
the new session — it fetches the transcript from the service and creates a
new session on the **local** opencode server using the same mechanism as the
plugin's `history_seed`, then prints the new session id. No additional
service endpoint.)

## What is left to the builder

- Verify against v2.2.7 source: exact event names/payloads seen by
  `event.subscribe`; tool registration signature and schema format; the
  local-plugin install location; and the cleanest way for a plugin to create
  a new local session with initial context for `history_seed`.
- Decide batching/backoff constants and outbox rotation limits.
- Tests: service API tests against a real PostgreSQL (throwaway container);
  plugin tests using the host APIs without mocking internal opencode logic;
  end-to-end smoke: two local "hosts" (two opencode instances) sharing one
  dev service.
- Time/size: buildable in a few working days; if seeding turns out to need
  significant new mechanism, stop and report rather than growing scope.

## Approval

Pending owner approval after builder check.

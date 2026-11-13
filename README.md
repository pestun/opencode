# Shared history for OpenCode

Share session narrative across independent OpenCode hosts without moving execution, files, or workspaces onto a central machine. A stock OpenCode v2.2.7 plugin on each host captures selected session events to a durable local outbox, then asynchronously syncs them to one private history service.

## Overview

```text
 Host A                         Host B                         Host C
 OpenCode + plugin              OpenCode + plugin              OpenCode + plugin
 local files and sessions       local files and sessions       local files and sessions
 local JSONL outbox             local JSONL outbox             local JSONL outbox
          \                              |                              /
           \                             |                             /
            `------------ authenticated event sync -----------------'
                                         |
                              history service :8797
                              search / transcript API
                                         |
                                    PostgreSQL
```

The service stores narrative; it does not run agents or hold project checkouts. Agents use `history_search`, `history_transcript`, and `history_seed` to find prior work, read it, and fork it into a new local session.

## Prerequisites

- Stock OpenCode v2.2.7 on every host that runs the plugin.
- Bun (developed with 1.4.4) on the service host and wherever the CLI is used.
- Docker with the Compose plugin for the supplied development PostgreSQL container, or another PostgreSQL 16 database.
- Network access from every host to the service. VPN, SSH tunneling, firewall rules, and TLS termination remain deployment concerns.

## Service setup

Clone this repository on the chosen service host and install its workspace dependencies:

```sh
git clone <repository-url> opencode-shared-history
cd opencode-shared-history
bun install
```

Choose one strong bearer token and use the same value on the service and every client. Start PostgreSQL and the service from `service/`:

```sh
cd service
docker compose up -d db
export HISTORY_TOKEN='replace-with-a-long-random-token'
export PORT=8797
bun run start
```

`PORT` defaults to `8797`. The default connection string is `postgres://history:history@localhost:54329/history`; the Compose file exposes the database on host port `54329` and persists it in the `pgdata` volume. To use another database, set `DATABASE_URL` before starting:

```sh
export DATABASE_URL='postgres://user:password@database-host:5432/history'
```

Startup requires `HISTORY_TOKEN`; without it the process exits with `HISTORY_TOKEN required`. The database migration runs automatically. Check unauthenticated liveness with:

```sh
curl http://127.0.0.1:8797/health
```

All routes other than `/health` require `Authorization: Bearer $HISTORY_TOKEN`. Back up the PostgreSQL database using normal PostgreSQL backup procedures.

## Install on each OpenCode host

From a checkout of this repository, run:

```sh
bash plugin/install.sh
```

By default the installer writes a self-contained local plugin to:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/shared-history/
```

This is the global plugin directory auto-discovered by stock OpenCode v2.2.7; **no `opencode.json` edit is required**. The installer copies the runtime plugin sources and their private `shared` dependency and adds the conventional root `server.ts` entrypoint. It replaces only `plugins/shared-history/`, so repeated runs update the installation idempotently without touching other plugins or configuration files.

For an isolated installation or another OpenCode config root, set `OPENCODE_CONFIG_DIR` for both the installer and the OpenCode processes that should load it:

```sh
OPENCODE_CONFIG_DIR=/tmp/oc-history-config bash plugin/install.sh
OPENCODE_CONFIG_DIR=/tmp/oc-history-config opencode
```

Next, add these exports to the environment that launches OpenCode on that host:

```sh
export HISTORY_URL='http://history-host:8797'
export HISTORY_TOKEN='replace-with-a-long-random-token'
export HISTORY_HOST='alpha'  # optional stable identity; defaults to the machine hostname
```

Use a distinct, stable `HISTORY_HOST` value per host. Restart OpenCode after changing these variables so its server inherits them:

```sh
opencode service restart
```

With no `HISTORY_URL` and `HISTORY_TOKEN`, the plugin still captures to its outbox, but it cannot sync and its history tools return configuration instructions.

## Agent tools

### Search across hosts

```text
history_search({"query":"Postgres retry decision", "limit":10})
history_search({"query":"authentication", "host":"alpha", "project":"/srv/shop"})
history_search({"query":"deployment", "since":"2026-11-01T00:00:00Z"})
```

Only `query` is required. Results include timestamp, host, project, session ID, and matching content. The service returns newest matches first and caps `limit` at 100.

### Read a transcript

```text
history_transcript({"sessionId":"<source-session-id>", "host":"alpha"})
```

`host` defaults to the current `HISTORY_HOST` (or machine hostname). Events arrive in chronological order.

### Fork prior work locally

```text
history_seed({"sessionId":"<source-session-id>", "host":"alpha"})
```

The tool creates a new independent session on the destination host, admits condensed historical context with execution disabled, and prints:

```text
Open it with: opencode --session <new-session-id>
```

Opening the session does not retroactively execute the admitted context. Start work explicitly when ready.

## Command line

Run the CLI from the repository root with the same authenticated environment:

```sh
export HISTORY_URL='http://history-host:8797'
export HISTORY_TOKEN='replace-with-a-long-random-token'

bun run service/src/cli.ts search 'Postgres retry' --host alpha --limit 10
bun run service/src/cli.ts search 'deployment' --project /srv/shop --since 2026-11-01T00:00:00Z
bun run service/src/cli.ts sessions
bun run service/src/cli.ts transcript alpha '<source-session-id>'
```

The commands are `search`, `sessions`, `transcript`, and `seed`. `HISTORY_URL` is required, and every request carries the bearer token.

For an authenticated local fork, run `seed` on the destination host while its local OpenCode service is running:

```sh
bun run service/src/cli.ts seed alpha '<source-session-id>'
```

The CLI discovers the server with `opencode service status`, gets its local credential with `opencode service get password`, and creates the session through that server. It prints the new session ID and the `opencode --session <new-session-id>` command. If no local server is reachable, start OpenCode first; seeding does not fall back to creating a session on the source host.

## Fork workflow

Files travel via git, narrative travels via this service.

1. On the source host, commit and push the code state that the destination needs.
2. On the destination host, fetch or pull that revision into its own checkout.
3. Find the source session with `bun run service/src/cli.ts sessions` or `history_search`.
4. Run the CLI `seed` command or the `history_seed` tool using the source host and session ID.
5. Open the returned new local session and start it explicitly.

Seeding is an independent fork, not native resume and not a shared session. It copies neither files nor byte-identical internal session state. The condensed transcript keeps narrative and decisions while replacing tool payloads with one-line outcome summaries; older entries are dropped if the 16,000-character context budget is exceeded. The original session remains untouched, and subsequent events on either side sync under their own session IDs.

## Offline behavior

Capture appends selected events to `~/.local/share/opencode-shared-history/outbox.jsonl` without making agent work wait for the central service. Set `HISTORY_OUTBOX` to use another path.

- While the service is unreachable, events remain in the outbox; sync logs one warning per failure streak and retries with exponential backoff capped at 60 seconds.
- Normal sync flushes every 2 seconds in batches of up to 100 events and also flushes promptly when new events arrive.
- Records are removed only after successful ingestion. A restart or retry may redeliver them, and the service's `(host, event_id)` key makes duplicate delivery safe.
- When connectivity returns, delivery resumes automatically. Because retry uses exponential backoff capped at 60 seconds, a pending batch can take approximately 60 seconds to replay after a long outage. Search, transcript, and seed are online reads and require the service to be reachable.
- Above 10 MB, the outbox discards the oldest whole JSONL records until it is within the limit and logs a warning. A single record larger than 10 MB is dropped rather than clipped into invalid JSON. Extended offline operation can therefore shed old local records; size the outage window and central backups accordingly.

## Security and privacy

The OpenCode credential store and OpenCode configuration are not capture sources. However, **message and tool content is synced unredacted by owner decision**, apart from capture truncation. Any secret displayed in a prompt, response, environment dump, file excerpt, or command output can reach the central database.

The central database and every local outbox are therefore sensitive. Keep the service private and trusted, protect the shared bearer token, restrict database access, and use an appropriately secured private network or tunnel. This repository does not provide redaction, per-user authorization, or TLS termination.

## Testing

Run the complete verification suite from the repository root:

```sh
bun run test
```

This is the only repository-wide test entry point and runs `shared/`, `service/`, and `plugin/` serially in that order. **Do not run the package suites in parallel:** all service suites share the Docker Postgres database and truncate its tables between tests, so parallel suites corrupt each other's data.

For focused work, running `bun test` inside one package is allowed:

```sh
cd shared  # or service, or plugin
bun test
```

## Troubleshooting

### Service unreachable

1. From the affected host, run `curl "$HISTORY_URL/health"`. A successful response is `{"status":"ok"}`; this route does not use the token.
2. Check that the host uses the intended `HISTORY_URL`, including scheme and port, and that a VPN or tunnel required by the deployment is connected.
3. On the service host, run `docker compose ps` from `service/`, confirm `bun run start` is still running, and check `DATABASE_URL` if the defaults are not in use.
4. A `history service 401` response means the client and service `HISTORY_TOKEN` values differ. Restart both after correcting them.
5. Leave the plugin running after connectivity returns; no manual outbox replay is necessary. Existing agent history calls can be retried once the service is available.

### Plugin not loaded or tools missing

1. Confirm `${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/plugins/shared-history/server.ts` exists. If a config-root override was used at install time, OpenCode must receive the same override.
2. Re-run `bash plugin/install.sh`, then restart OpenCode in the environment containing `HISTORY_URL` and `HISTORY_TOKEN`.
3. Run `opencode plugin list`. Plugin activation is asynchronous, so an immediate cold-start listing can be empty; retry after a few seconds or check the tools from the running session. A healthy entry has ID `shared-history`, version `local`, and the installation path as its source.
4. Check OpenCode's startup logs for `shared-history`, `failed to load plugin`, or import errors. For standalone diagnostics, `opencode --standalone --print-logs plugin list` prints server logs while checking discovery.
5. Check applicable OpenCode `plugins` arrays for a `-shared-history` removal directive. Also ensure no second loaded plugin uses the same `shared-history` ID.
6. If the plugin is listed but tools say `history service not configured (set HISTORY_URL and HISTORY_TOKEN)`, the plugin loaded successfully and the missing item is the server process environment. Export both variables and restart OpenCode rather than reinstalling.

## E2E smoke — results 2026-11-13

Live smoke used `/opt/homebrew/bin/opencode` v2.2.7-vasily and two isolated hosts with both `HOME=/tmp/osh-a|b` and matching `OPENCODE_CONFIG_DIR` overrides. Provider config and auth were copied to the fake homes; the owner’s real configuration and background service were not modified. Plugins were installed with:

```sh
env -u OPENCODE_DISABLE_DEFAULT_PLUGINS HOME=/tmp/osh-a OPENCODE_CONFIG_DIR=/tmp/osh-a/.config/opencode bash plugin/install.sh
env -u OPENCODE_DISABLE_DEFAULT_PLUGINS HOME=/tmp/osh-b OPENCODE_CONFIG_DIR=/tmp/osh-b/.config/opencode bash plugin/install.sh
```

Each installer reported the correct destination, including the generated `server.ts`. Central service, from `service/`:

```sh
HISTORY_TOKEN=dev PORT=8797 /Users/vasily/code/.bun/bin/bun run start
curl -fsS --max-time 5 http://127.0.0.1:8797/health  # {"status":"ok"}
```

The managed alpha/beta services used ports 49375/49376 because the inherited port 49374 was the owner’s live service. Their environments were the respective home/config overrides plus `HISTORY_URL=http://localhost:8797`, `HISTORY_TOKEN=dev`, and `HISTORY_HOST=alpha|beta`, with `OPENCODE_DISABLE_DEFAULT_PLUGINS` unset.

1. **PASS — alpha capture:** `/opt/homebrew/bin/opencode run --format json 'Reply with exactly OK. Record HOST ALPHA MARKER 88231.'` created `ses_e299963e6ffeW7uuUsPib3p9X6` and returned `OK`. With `HISTORY_URL=http://localhost:8797 HISTORY_TOKEN=dev`, these commands:
   ```sh
   /Users/vasily/code/.bun/bin/bun run service/src/cli.ts sessions
   /Users/vasily/code/.bun/bin/bun run service/src/cli.ts search 88231
   ```
   respectively listed the alpha session and returned `2026-11-13T19:33:38.234Z  alpha  ses_e299963e6ffeW7uuUsPib3p9X6  Host alpha marker 88231`.
2. **PASS — beta live tool search:** under beta’s environment, `/opt/homebrew/bin/opencode run --auto --format json 'Call the history_search tool with {"query":"88231"}. Return only host=... and session=... from the tool output.'` completed a nested `history_search` call. Its tool output included `host=alpha`, the alpha session ID, and `Host alpha marker 88231`; final text was `host=alpha session=ses_e299963e6ffeW7uuUsPib3p9X6`. An initial invocation without `--auto` timed out awaiting tool execution and was not counted as a pass.
3. **PASS — fork without execution:** under beta’s environment, `/Users/vasily/code/.bun/bin/bun run service/src/cli.ts seed alpha ses_e299963e6ffeW7uuUsPib3p9X6` created the different session `ses_e29901710ffeLRqmF3XfS2luyO`. `/opt/homebrew/bin/opencode api get /api/session/ses_e29901710ffeLRqmF3XfS2luyO/inbox` returned one admitted `type:user` payload containing the condensed alpha history and marker. `/opt/homebrew/bin/opencode session export ses_e29901710ffeLRqmF3XfS2luyO` showed zero tokens and `messages:[]`; central beta transcript contained only `session.created`. Saving alpha’s transcript before/after with `/Users/vasily/code/.bun/bin/bun run service/src/cli.ts transcript alpha ses_e299963e6ffeW7uuUsPib3p9X6` and running `cmp -s` exited zero, proving it unchanged.
4. **PASS — offline recovery and user capture:** with fixed mapper commit `c06e987` installed into alpha’s isolated plugin directory, central was stopped and alpha ran `/opt/homebrew/bin/opencode run --auto --format json 'Reply with exactly OK. Record HOST ALPHA OFFLINE MARKER 99302.'`. It returned `OK` and buffered five records in session `ses_e29446799ffek161KcVtfEx1ap`. Central was restarted with `HISTORY_TOKEN=dev PORT=8797 /Users/vasily/code/.bun/bin/bun run start` from `service/`; alpha was not restarted and no new turns or manual replays were issued. A once-per-second condition loop with a 90-second deadline ran:
   ```sh
   HISTORY_URL=http://localhost:8797 HISTORY_TOKEN=dev /Users/vasily/code/.bun/bin/bun run service/src/cli.ts search 99302
   wc -l < /tmp/osh-a/.local/share/opencode-shared-history/outbox.jsonl
   ```
   It passed at `t=24s` with this exact output:
   ```text
   2026-11-13T21:06:23.595Z  alpha  ses_e29446799ffek161KcVtfEx1ap  Host alpha offline marker 99302
   2026-11-13T21:06:21.123Z  alpha  ses_e29446799ffek161KcVtfEx1ap  Reply with exactly OK. Record HOST ALPHA OFFLINE MARKER 99302.
   Pending alpha outbox records: 0
   ```
   Central transcript confirmed the latter as a `message` record containing the exact admitted user prompt.

**Final result: 4/4 PASS.** The E2E caught two defects: the original 10-second check was shorter than legitimate capped-backoff recovery (now allowed up to 90 seconds), and admitted user prompts were absent until `session.inbox.enqueued` mapping was added. Full chronological evidence and cleanup are in `.superpowers/sdd/2026-11-12-shared-history/task-10-report.md`.

All smoke OpenCode/history processes were stopped after the passing replay; central port 8797 remains stopped. The pre-existing Docker database and the owner’s unrelated service on port 49374 remain untouched.

# Linux setup guide

This guide sets up **shared history for OpenCode** on Linux hosts: the central history
service (with its PostgreSQL database) and the plugin on each OpenCode host. No C, C++,
Rust, or Go compiler is needed: this project is TypeScript executed by Bun, and the
supplied plugin and service run from source.

## 1. What you need to download

| Component | Needed on | Purpose |
|---|---|---|
| Git | every host | clone this repository |
| `curl`, `unzip`, CA certificates | every installer host | download OpenCode and Bun |
| **Bun 1.4.4 or newer 1.4.x** | service host and hosts using the CLI | run the TypeScript service, plugin tooling, tests and CLI |
| **Stock OpenCode v2.2.7 or newer** | every agent host | host sessions and load this plugin; no opencode source changes needed |
| **Docker + Compose v2**, or an existing **PostgreSQL 16** server | service host, and any host running the test suite | run the central history database; tests use a real DB (no mocks) |
| PostgreSQL client tools (optional) | service host | inspect/backup the DB |

The complete runtime download footprint is roughly 400 MB per agent host, plus a
PostgreSQL container/database on the service host. Node.js is not required.

## 2. Supported machine assumptions

The instructions below target a 64-bit Linux machine (`x86_64` or `aarch64/arm64`) with
Internet access for the initial installation. Verify your CPU architecture with:

```sh
uname -m
id
```

Use a non-root account for the OpenCode agents. Database containers optionally use
`sudo` if the account is not in the `docker` group.

For an **airgapped** setup, transfer the Bun binary, the OpenCode binary, to this repository
and an initialized PostgreSQL data store (or database container image) using your internal
artifact channel before continuing. The database must live on a host reachable from every
agent host that you want to share history.

## 3. Install per-platform prerequisites

These are examples for Ubuntu/Debian. Use the equivalent package names with `dnf` on
Fedora/RHEL or `zypper` on openSUSE.

```sh
sudo apt update
sudo apt install -y git curl unzip ca-certificates openssl
```

Install the official Docker packages (including the Compose plugin) by following your
distribution's Docker instructions; on Debian/Ubuntu the simplest distribution-supplied
packages are typically:

```sh
sudo apt install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
```

Log out and back in after changing group membership, or run subsequent Docker commands
with `sudo`. Verify:

```sh
docker version
docker compose version
```

If you already run PostgreSQL 16 elsewhere, **skip Docker entirely** and use that instance;
you only need to set `DATABASE_URL` in the service environment below. To install local
PostgreSQL 16 without containers, use your distro's standard packages or PostgreSQL's
official PGDG repository, create the `history` database and a user, then export its URL.
Do not reuse a different running service's database cluster blindly; the default Compose
port 54329 is chosen to avoid existing local Postgres instances on 5432.

## 4. Install Bun (pinned version)

On the service host and any host where you want to invoke `oc-history`:

```sh
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.4"
```

This installs Bun to `~/.bun` and adds it to your shell profile. Open a new shell, or apply
it immediately in your current shell:

```sh
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
bun --version
```

Expected: `1.4.4`. Any newer `1.4.x` satisfies the project toolchain; the development build
was tested with 1.4.4.

## 5. Install stock OpenCode on each agent host

Use OpenCode's normal installer:

```sh
curl -fsSL https://opencode.ai/install | bash
```

Open a new shell, ensure `~/.opencode/bin` (or the path the installer prints) is on `PATH`,
and check:

```sh
which opencode
opencode --version
```

Expected: `v2.2.7` or newer. This project's plugin was verified live against the source-built
v2.2.7 on macOS and uses only the v2 plugin contracts. Pin the Linux installation to a
v2.2.7+ release, not an older v1 build.

If your organization prefers source-built binaries, see [Appendix A](#appendix-a-building-opencode-itself-on-linux).

## 6. Get this repository

Clone the project branch (the one used for this release):

```sh
git clone -b build-shared-history https://github.com/pestun/opencode.git opencode-shared-history
cd opencode-shared-history
bun install
```

The `build-shared-history` branch in that repository contains this shared-history project.
The repository's `main` history belongs to the upstream opencode fork, not to this project;
the `-b` selection above is therefore required.

This installs the monorepo's workspace dependencies. It does **not** create a separate
compiled executable: Bun executes the service and CLI source directly.

Before running the test suite, start its real development database (the only external
component the tests require; do this on every machine where you run tests):

```sh
(cd service && docker compose up -d db)
```

Expected: a `service-db-1` container listening on **port 54329**. If Docker says
`unknown command "compose"`, you do not have the Compose plugin and can either install the
Compose v2 plugin (Step 3) or avoid it entirely with the plain-`docker run` command in
Step 7a below. Switch to your own
PostgreSQL instead by exporting `DATABASE_URL` for the test process. If you skip the DB
step you will see PostgreSQL connection-refused failures — that means the database is not
reachable, not that the plugin build failed. You do **not** need to start the central history
service for the test suite: the tests launch their own throwaway HTTP servers automatically
on random ports.

Verify with:

```sh
bun run test
```

Expected: `87 pass, 0 fail` totals across `shared`, `service`, and `plugin` (a frozen number
of assertions may grow if new fixes/tests are added). The test output may take about a
minute: the longest test deliberately proves automatic recovery after a full offline window.
The root command runs the packages serially because service tests share and truncate the
development database; do not run package suites in parallel.

## 7. Start the central service

Perform this section on just one host (a VM, central dev box, or one of your agent hosts).

### 7a. Start PostgreSQL

From the repository's `service/` directory:

```sh
cd service
docker compose up -d db
docker compose ps
```

The `db` container initializes a database/user/password named `history` and listens on
host port **54329**, with data stored in the Compose `pgdata` volume. Secure network exposure
at host level (for example with a private bind instead of the Compose default), especially
outside a private test environment.

**Alternative without Compose:** if `docker compose` reports `unknown command`, you can start
the equivalent database using only the Docker engine. Add `sudo` **only** if your account
actually needs elevated Docker privileges; on rootless Docker, or with an already-authorized
account, omit it entirely. If the engine responds with `permission denied ... docker.sock`,
Docker access is restricted by the host administrator — use an existing reachable PostgreSQL
16 through `DATABASE_URL`, or ask for access:

```sh
docker run -d \
  --name opencode-history-db \
  --restart unless-stopped \
  -p 127.0.0.1:54329:5432 \
  -e POSTGRES_USER=history \
  -e POSTGRES_PASSWORD=history \
  -e POSTGRES_DB=history \
  -v opencode-history-pgdata:/var/lib/postgresql/data \
  postgres:16-alpine
```

This gives the same database, host port and credentials but persists under the named volume
`opencode-history-pgdata`. After that, the test suite and `DATABASE_URL` usage below work
unchanged; you never need to install the Compose plugin just to run this project.

### 7b. Configure and run the service

Generate a strong shared secret and keep this value for all hosts:

```sh
export HISTORY_TOKEN="$(openssl rand -hex 32)"
printf '%s\n' "$HISTORY_TOKEN"   # record this in your private deployment manager
export PORT=8797
export DATABASE_URL='postgres://history:history@localhost:54329/history'
bun run start
```

The default `DATABASE_URL` shown above matches the Compose service. `bun run start` starts
the service (Hono HTTP listener); an existing remote database use your own connection string
instead. `HISTORY_TOKEN` is mandatory at startup; `PORT` defaults to 8797. A transiently
unavailable DB is retried before the HTTP listener starts; after bounded retry exhaustion
the process exits with an actionable message so systemd or another supervisor can restart it.

Check liveness in another shell:

```sh
curl -fsS http://127.0.0.1:8797/health
```

Expected: `{"status":"ok"}`.

To keep it running after the terminal closes, an optional user `systemd` unit is shown in
[Appendix B](#appendix-b-optional-systemd-user-service).

## 8. Install the plugin on every OpenCode host

On **each** agent host, clone this repository if it does not already have a checkout, run
`bun install` once, then from its root:

```sh
bash plugin/install.sh
```

No `opencode.json` edit is required. This resolves through XDG/OpenCode defaults to:

```text
${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins/shared-history/
```

It only replaces the `plugins/shared-history/` subtree and is safe to run repeatedly.
Hosts using a different config root can override it with `OPENCODE_CONFIG_DIR`; use that same
override when launching OpenCode.

Set the environment that will launch OpenCode (for example in `~/.bashrc`):

```sh
export HISTORY_HOST='alpha'                        # unique per host (e.g. alpha, beta, db-node)
export HISTORY_URL='http://SERVICE_HOST_IP:8797'   # NOT localhost unless service is local
export HISTORY_TOKEN='the same token generated in 7b'
```

Replace `SERVICE_HOST_IP` with the actual host/IP or VPN/DNS name reachable from this agent
host. From a laptop moving between networks, prefer an SSH tunnel or an already established
private VPN:

```sh
# optional pattern; forward the service port onto the agent host, then use localhost:
ssh -L 8797:127.0.0.1:8797 user@SERVICE_HOST_IP
# and on this agent host:
export HISTORY_URL='http://127.0.0.1:8797'
```

Restart OpenCode after installing the plugin. Verify the plugin discovery listing:

```sh
opencode plugin list
```

`shared-history` should appear with source `local`.

## 9. Verify sharing between two hosts

On host `alpha`, run a short session and include a distinctive marker in it. One example:

```sh
opencode run --prompt 'Reply with exactly OK. Record SHARED HISTORY LINUX MARKER 58123.'
```

On host `beta`, query the common store. With `HISTORY_URL` and `HISTORY_TOKEN` exported,
invoke the CLI from the checkout using Bun:

```sh
bun run service/src/cli.ts sessions
bun run service/src/cli.ts search 58123
```

You should see alpha's session and the prompt text, including `host=alpha`-style attribution.

Alternatively, ask the agent on beta: "Call history_search with {\"query\":\"58123\"} and
return the host/session." The stock OpenCode agent has the plugin tools registered: read
cross-host history with `history_transcript`, or continue that work through `history_seed`.

### Forking a session from one host to another

On the destination host (e.g. beta), run replacing HOST and ID with those shown by `sessions`:

```sh
bun run service/src/cli.ts search 58123
bun run service/src/cli.ts transcript alpha SESSION_ID
bun run service/src/cli.ts seed alpha SESSION_ID
opencode --session NEW_SESSION_ID
```

This creates an **independent** local fork with a new ID: the source session is untouched,
the condensed history is admitted without automatically executing a model turn, and future
work records under the new ID. **Files are not copied**: push/pull code state through git as
usual. Shared history carries the narrative; git carries workspace contents. Seeding an
unknown session fails with a clear session-not-found error instead of creating an empty fork.

## 10. Offline behavior, safety and operations

- Losing connectivity to the history service never blocks the agent. Local outbox records
  accumulate under `~/.local/share/opencode-shared-history/outbox.jsonl` and are sent later.
- Delivery is idempotent on `(host, event_id)` with acknowledgement only after successful
  ingest. After a long connectivity outage, worst-case recovery occurs within roughly 60
  seconds of service restoration; no manual replay is required.
- Outboxes are capped at 10 MiB; oldest records can be shed after that bound if a host cannot
  sync indefinitely. Back up PostgreSQL as you would any private application database.
- The owner of this deployment deliberately chose **no content redaction**. A tool printing
  a secret can therefore sync that secret to the private central DB. Treat both the central
  DB and local outboxes as sensitive data. Never share an exported database or outbox dump
  over an untrusted channel.

For additional commands and troubleshooting, see the project [README](../README.md).

## Appendix A: Building OpenCode itself on Linux

Separate task; **not required** for shared-history's service/plugin. Only do this when you
need a custom-built OpenCode instead of the stock binary. **Do not run these commands in the
`opencode-shared-history` project checkout:** `packages/cli` belongs to the separate upstream
OpenCode repository, which this appendix clones into a different directory.

Prerequisites on Linux: git, curl, unzip and Bun 1.4.4 as above. Then:

```sh
# Run this from a separate directory, creating a new upstream OpenCode checkout:
git clone --filter=blob:none https://github.com/anomalyco/opencode.git opencode-upstream
cd opencode-upstream
git checkout v2.2.7
bun install
cd packages/cli
OPENCODE_VERSION=2.2.7-custom bun run build --single
./dist/cli-linux-x64/bin/opencode --version    # on x86_64
./dist/cli-linux-arm64/bin/opencode --version  # on aarch64
```

The self-contained binary is at `dist/cli-linux-<arch>/bin/opencode`. Move **only that file**
onto another Linux host, `chmod +x` it and put it on PATH. No Bun, Node.js or `node_modules`
is needed on that runtime host. For Linux container/musl targets use explicit targets such as
`OPENCODE_TARGET=linux-x64-musl bun run build` without `--single`; do not pass `--skip-install`
on a first cross-target build, since native dependency downloads are required.

## Appendix B: Optional `systemd` user service

One possible Linux service unit (`~/.config/systemd/user/opencode-history.service`); replace
`/path/to/opencode-shared-history` and substitute your secret without putting the real token
in a publicly shared file:

```ini
[Unit]
Description=Shared history for OpenCode
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/opencode-shared-history/service
Environment=HISTORY_TOKEN=replace-with-a-long-random-token
Environment=PORT=8797
Environment=DATABASE_URL=postgres://history:history@localhost:54329/history
ExecStart=%h/.bun/bin/bun run start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Apply and enable:

```sh
systemctl --user daemon-reload
systemctl --user enable --now opencode-history
journalctl --user -u opencode-history -f
```

The host still needs Docker to run the bundled DB first (`docker compose up -d db`), or a
separately configured `DATABASE_URL`.

import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHistoryClient } from "shared/client"
import type { HistoryEvent } from "shared/event"
import { runCli } from "./cli"
import { startTestService, type TestService } from "./testkit"

let service: TestService
let client: ReturnType<typeof createHistoryClient>
const localCleanups: Array<() => Promise<void>> = []

beforeAll(async () => {
  service = await startTestService()
  client = createHistoryClient({ url: service.url, token: service.token })
})

beforeEach(async () => {
  await service.sql`truncate table events`
})

afterEach(async () => {
  for (const cleanup of localCleanups.splice(0)) await cleanup()
})

afterAll(async () => {
  await service.stop()
})

function makeEvent(overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    host: "cli-host",
    eventId: "event-1",
    sessionId: "cli-session",
    project: "cli-project",
    ts: "2026-11-12T10:00:00.000Z",
    kind: "message",
    content: "needle in the first event",
    payload: { source: "cli-test" },
    ...overrides,
  }
}

async function invoke(argv: string[], env: Record<string, string | undefined> = {}) {
  const stdout: string[] = []
  const stderr: string[] = []
  const exit = await runCli(argv, env, {
    stdout: line => stdout.push(line),
    stderr: line => stderr.push(line),
  })
  return { exit, stdout: stdout.join("\n"), stderr: stderr.join("\n") }
}

function configuredEnv(): Record<string, string> {
  return { HISTORY_URL: service.url, HISTORY_TOKEN: service.token }
}

type LocalSeed = {
  url: string
  env: Record<string, string>
  authorization?: string
  requests: Array<{ path: string; authorization: string | null; body: Record<string, unknown> }>
  rejectedAuthorizations: Array<string | null>
  stop(): void
}

async function startLocalSeed(options: { password?: string; discoveredPassword?: string } = {}): Promise<LocalSeed> {
  const authorization = options.password
    ? `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`
    : undefined
  const requests: LocalSeed["requests"] = []
  const rejectedAuthorizations: LocalSeed["rejectedAuthorizations"] = []
  const local = Bun.serve({
    port: 0,
    async fetch(request) {
      const receivedAuthorization = request.headers.get("authorization")
      if (authorization !== undefined && receivedAuthorization !== authorization) {
        rejectedAuthorizations.push(receivedAuthorization)
        return Response.json({ error: "unauthorized" }, { status: 401 })
      }
      const path = new URL(request.url).pathname
      const body = (await request.json()) as Record<string, unknown>
      requests.push({ path, authorization: receivedAuthorization, body })
      if (path === "/api/session") return Response.json({ data: { id: "ses_local_fork" } })
      return Response.json({ data: { id: "message-1" } })
    },
  })
  const directory = await mkdtemp(join(tmpdir(), "shared-history-cli-"))
  const executable = join(directory, "opencode")
  const password = options.discoveredPassword ?? options.password ?? ""
  const script = `#!/bin/sh
if [ "$1 $2 $3" = "service get password" ]; then
  printf '%s\\n' '${password}'
  exit 0
fi
printf '%s\\n' 'http://127.0.0.1:${local.port}'
`
  await writeFile(executable, script)
  await chmod(executable, 0o755)
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    local.stop(true)
  }
  localCleanups.push(async () => {
    stop()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    url: `http://127.0.0.1:${local.port}`,
    env: { ...configuredEnv(), PATH: directory },
    authorization,
    requests,
    rejectedAuthorizations,
    stop,
  }
}

async function temporaryPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "shared-history-cli-"))
  localCleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test("usage exits 2 on an unknown command", async () => {
  const result = await invoke(["unknown"])

  expect(result.exit).toBe(2)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("Usage: oc-history")
  expect(result.stderr).toContain("search <query>")
})

test("missing HISTORY_URL exits 1 with an actionable message", async () => {
  const result = await invoke(["search", "needle"], { HISTORY_TOKEN: "test-token" })

  expect(result.exit).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("HISTORY_URL is required")
  expect(result.stderr).toContain("set HISTORY_URL")
})

test("search prints rows from a running service and forwards all filters", async () => {
  await client.ingest([
    makeEvent({ eventId: "older", ts: "2026-11-12T09:00:00.000Z" }),
    makeEvent(),
    makeEvent({ eventId: "later", ts: "2026-11-12T11:00:00.000Z", content: "needle in the latest event" }),
    makeEvent({ eventId: "other-host", host: "other-host", ts: "2026-11-12T12:00:00.000Z" }),
    makeEvent({ eventId: "other-project", project: "other-project", ts: "2026-11-12T13:00:00.000Z" }),
  ])

  const result = await invoke(
    [
      "search",
      "needle",
      "--host",
      "cli-host",
      "--project",
      "cli-project",
      "--since",
      "2026-11-12T09:30:00.000Z",
      "--limit",
      "1",
    ],
    configuredEnv(),
  )

  expect(result).toEqual({
    exit: 0,
    stdout: "2026-11-12T11:00:00.000Z  cli-host  cli-session  needle in the latest event",
    stderr: "",
  })
})

test("search renders content as a single line of at most 120 characters", async () => {
  await client.ingest([makeEvent({ content: `first line\nsecond line ${"x".repeat(120)}` })])

  const result = await invoke(["search", "first"], configuredEnv())

  expect(result.exit).toBe(0)
  expect(result.stdout).toBe(
    `2026-11-12T10:00:00.000Z  cli-host  cli-session  first line second line ${"x".repeat(97)}`,
  )
  expect(result.stderr).toBe("")
})

test("sessions prints host, session, project, and time bounds", async () => {
  await client.ingest([
    makeEvent(),
    makeEvent({ eventId: "event-2", ts: "2026-11-12T11:00:00.000Z", content: "another event" }),
  ])

  const result = await invoke(["sessions"], configuredEnv())

  expect(result).toEqual({
    exit: 0,
    stdout:
      "2026-11-12T11:00:00.000Z  cli-host  cli-session  cli-project  2026-11-12T10:00:00.000Z",
    stderr: "",
  })
})

test("seed authenticates every request to a managed local server", async () => {
  const source = makeEvent({ host: "source-host", sessionId: "source-session", content: "carry this decision" })
  await client.ingest([source])
  const local = await startLocalSeed({ password: "managed-secret" })

  const result = await invoke(["seed", source.host, source.sessionId!], local.env)

  expect(result).toEqual({
    exit: 0,
    stdout: "Created session ses_local_fork\nOpen it with: opencode --session ses_local_fork",
    stderr: "",
  })
  expect(local.requests).toHaveLength(2)
  expect(local.requests.map(request => request.authorization)).toEqual([local.authorization!, local.authorization!])
  expect(local.requests[0]?.path).toBe("/api/session")
  expect(local.requests[0]?.body).toEqual({
    title: "Fork of source-session on source-host",
    metadata: { forkedFrom: { host: source.host, sessionId: source.sessionId } },
  })
  expect(local.requests[0]?.body).not.toHaveProperty("parentID")
  expect(local.requests[1]?.path).toBe("/api/session/ses_local_fork/prompt")
  expect(local.requests[1]?.body).toEqual({
    text: "Forked from host source-host, session source-session. Original below.\n\n" +
      "[2026-11-12T10:00:00.000Z] message\n\ncarry this decision",
    resume: false,
  })
})

test("seed rejects an unknown session before any local session request", async () => {
  const local = await startLocalSeed()

  const result = await invoke(["seed", "missing-host", "missing-session"], local.env)

  expect(result.exit).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("Session not found: missing-host/missing-session")
  expect(local.requests).toEqual([])
})

test("seed boundary rejects missing or wrong Basic auth with a clear error", async () => {
  const source = makeEvent({ host: "source-host", sessionId: "source-session" })
  await client.ingest([source])
  const local = await startLocalSeed({ password: "managed-secret", discoveredPassword: "wrong-secret" })

  const missingAuth = await fetch(`${local.url}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
  const result = await invoke(["seed", source.host, source.sessionId!], local.env)

  expect(missingAuth.status).toBe(401)
  expect(result.exit).toBe(1)
  expect(result.stdout).toBe("")
  expect(result.stderr).toContain("local opencode request failed (401)")
  expect(result.stderr).toContain("unauthorized")
  expect(local.rejectedAuthorizations).toEqual([
    null,
    `Basic ${Buffer.from("opencode:wrong-secret").toString("base64")}`,
  ])
  expect(local.requests).toEqual([])
})

test("seed supports an unauthenticated standalone local server", async () => {
  await client.ingest([makeEvent({ host: "source-host", sessionId: "source-session" })])
  const local = await startLocalSeed()

  const result = await invoke(["seed", "source-host", "source-session"], local.env)

  expect(result.exit).toBe(0)
  expect(local.requests).toHaveLength(2)
  expect(local.requests.map(request => request.authorization)).toEqual([null, null])
})

test("seed explains how to proceed when the opencode executable is missing", async () => {
  await client.ingest([makeEvent({ host: "source-host", sessionId: "source-session" })])

  const result = await invoke(["seed", "source-host", "source-session"], {
    ...configuredEnv(),
    PATH: await temporaryPath(),
  })

  expect(result).toEqual({
    exit: 1,
    stdout: "",
    stderr: "Could not reach a local opencode server; start opencode first",
  })
})

test("seed explains how to proceed when the discovered server is unreachable", async () => {
  await client.ingest([makeEvent({ host: "source-host", sessionId: "source-session" })])
  const local = await startLocalSeed()
  local.stop()

  const result = await invoke(["seed", "source-host", "source-session"], local.env)

  expect(result).toEqual({
    exit: 1,
    stdout: "",
    stderr: "Could not reach a local opencode server; start opencode first",
  })
})

test("transcript prints ordered event lines", async () => {
  await client.ingest([
    makeEvent({ eventId: "event-2", ts: "2026-11-12T11:00:00.000Z", kind: "tool", content: "second\nevent" }),
    makeEvent(),
  ])

  const result = await invoke(["transcript", "cli-host", "cli-session"], configuredEnv())

  expect(result).toEqual({
    exit: 0,
    stdout:
      "[2026-11-12T10:00:00.000Z] message: needle in the first event\n" +
      "[2026-11-12T11:00:00.000Z] tool: second event",
    stderr: "",
  })
})

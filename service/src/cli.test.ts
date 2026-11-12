import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { createHistoryClient } from "shared/client"
import type { HistoryEvent } from "shared/event"
import { runCli } from "./cli"
import { startTestService, type TestService } from "./testkit"

let service: TestService
let client: ReturnType<typeof createHistoryClient>

beforeAll(async () => {
  service = await startTestService()
  client = createHistoryClient({ url: service.url, token: service.token })
})

beforeEach(async () => {
  await service.sql`truncate table events`
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

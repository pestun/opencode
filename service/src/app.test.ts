import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createHistoryClient } from "shared/client"
import type { HistoryEvent } from "shared/event"
import { startTestService, type TestService } from "./testkit"

let service: TestService
let url: string
let client: ReturnType<typeof createHistoryClient>

beforeAll(async () => {
  service = await startTestService()
  url = service.url
  client = createHistoryClient({ url, token: service.token })
})

beforeEach(async () => {
  await service.sql`truncate table events`
})

afterAll(async () => {
  await service.stop()
})

function makeEvent(overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    host: "api-host",
    eventId: "event-1",
    sessionId: "api-session",
    project: "api-project",
    ts: "2026-11-12T10:00:00.000Z",
    kind: "message",
    content: "needle in the first event",
    payload: { source: "api-test" },
    ...overrides,
  }
}

test("health is available without authentication", async () => {
  const response = await fetch(`${url}/health`)

  expect(response.status).toBe(200)
})

test("events require a bearer token", async () => {
  const response = await fetch(`${url}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "[]",
  })

  expect(response.status).toBe(401)
})

test("a malformed event batch returns a 400 error", async () => {
  const response = await fetch(`${url}/events`, {
    method: "POST",
    headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
    body: JSON.stringify([{ host: "x" }]),
  })

  expect(response.status).toBe(400)
  const body = (await response.json()) as { error?: unknown }
  expect(typeof body.error).toBe("string")
})

test("client ingests, searches, lists sessions, and reads an ordered transcript", async () => {
  const first = makeEvent()
  const second = makeEvent({
    eventId: "event-2",
    ts: "2026-11-12T11:00:00.000Z",
    content: "another event",
  })

  expect(await client.ingest([second, first])).toBeUndefined()
  expect((await client.search({ query: "needle" })).map(event => event.eventId)).toEqual(["event-1"])
  expect(await client.sessions()).toEqual([
    {
      host: "api-host",
      sessionId: "api-session",
      project: "api-project",
      firstSeen: "2026-11-12T10:00:00.000Z",
      lastSeen: "2026-11-12T11:00:00.000Z",
    },
  ])
  expect((await client.transcript("api-host", "api-session")).map(event => event.eventId)).toEqual([
    "event-1",
    "event-2",
  ])
})

test("client sends all search filters", async () => {
  await client.ingest([
    makeEvent({ eventId: "older", ts: "2026-11-12T09:00:00.000Z" }),
    makeEvent({ eventId: "matching", ts: "2026-11-12T10:00:00.000Z" }),
    makeEvent({ eventId: "later", ts: "2026-11-12T11:00:00.000Z" }),
    makeEvent({ eventId: "other-host", host: "other-host", ts: "2026-11-12T12:00:00.000Z" }),
    makeEvent({ eventId: "other-project", project: "other-project", ts: "2026-11-12T13:00:00.000Z" }),
  ])

  const results = await client.search({
    query: "needle",
    host: "api-host",
    project: "api-project",
    since: "2026-11-12T09:30:00.000Z",
    limit: 1,
  })

  expect(results.map(event => event.eventId)).toEqual(["later"])
})

test("an unknown session has an empty transcript", async () => {
  expect(await client.transcript("missing-host", "missing-session")).toEqual([])
})

test("client errors include the service status and body", async () => {
  const unauthorizedClient = createHistoryClient({ url, token: "wrong-token" })

  await expect(unauthorizedClient.ingest([])).rejects.toThrow('history service 401: {"error":"unauthorized"}')
})

test("startup fails fast when HISTORY_TOKEN is missing", async () => {
  const env: Record<string, string | undefined> = { ...process.env, PORT: "0" }
  delete env.HISTORY_TOKEN
  const child = Bun.spawn({
    cmd: [process.execPath, "run", "src/index.ts"],
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env,
    stdout: "pipe",
    stderr: "pipe",
  })

  expect(await child.exited).not.toBe(0)
  expect(await new Response(child.stderr).text()).toContain("HISTORY_TOKEN required")
})

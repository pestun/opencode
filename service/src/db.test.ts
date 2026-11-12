import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import type { HistoryEvent } from "shared/event"
import { connect, insertEvents, listSessions, searchEvents, transcript } from "./db"

const sql = connect()

beforeAll(async () => {
  await listSessions(sql)
})

beforeEach(async () => {
  await sql`truncate table events`
})

afterAll(async () => {
  await sql.end()
})

function makeEvent(overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    host: "test-host",
    eventId: "event-1",
    sessionId: "test-session",
    project: "test-project",
    ts: "2026-11-12T10:00:00.000Z",
    kind: "message",
    content: "hello",
    payload: { source: "test" },
    ...overrides,
  }
}

test("connect - applies migration idempotently", async () => {
  const secondSql = connect()
  try {
    await expect(listSessions(secondSql)).resolves.toEqual([])
  } finally {
    await secondSql.end()
  }
})

test("insertEvents - duplicate batch is a no-op", async () => {
  const event = makeEvent({ host: "duplicate-host", eventId: "duplicate-event", sessionId: "duplicate-session" })

  expect(await insertEvents(sql, [event])).toEqual({ inserted: 1 })
  expect(await insertEvents(sql, [event])).toEqual({ inserted: 0 })
  expect(await transcript(sql, event.host, event.sessionId!)).toHaveLength(1)
})

test("searchEvents - escapes LIKE metacharacters", async () => {
  await insertEvents(sql, [
    makeEvent({ host: "escape-host", eventId: "percent", content: "100% coverage" }),
    makeEvent({ host: "escape-host", eventId: "wildcard", content: "100x coverage" }),
  ])

  const results = await searchEvents(sql, { query: "100%", host: "escape-host" })
  expect(results.map(event => event.eventId)).toEqual(["percent"])
})

test("searchEvents - filters by host and project and caps limit", async () => {
  const matching = Array.from({ length: 105 }, (_, index) =>
    makeEvent({
      host: "filter-host",
      eventId: `matching-${index}`,
      project: "filter-project",
      ts: new Date(Date.parse("2026-11-12T10:00:00.000Z") + index * 1000).toISOString(),
      content: "filter needle",
    }),
  )
  await insertEvents(sql, [
    ...matching,
    makeEvent({ host: "other-host", eventId: "wrong-host", project: "filter-project", content: "filter needle" }),
    makeEvent({ host: "filter-host", eventId: "wrong-project", project: "other-project", content: "filter needle" }),
  ])

  const results = await searchEvents(sql, {
    query: "needle",
    host: "filter-host",
    project: "filter-project",
    limit: 1000,
  })
  expect(results).toHaveLength(100)
  expect(results.every(event => event.host === "filter-host" && event.project === "filter-project")).toBe(true)
})

test("searchEvents - filters by since and defaults to 20 results", async () => {
  await insertEvents(
    sql,
    Array.from({ length: 25 }, (_, index) =>
      makeEvent({
        host: "since-host",
        eventId: `since-${index}`,
        ts: new Date(Date.parse("2026-11-12T11:00:00.000Z") + index * 1000).toISOString(),
        content: "since needle",
      }),
    ),
  )

  const defaultResults = await searchEvents(sql, { query: "since needle", host: "since-host" })
  expect(defaultResults).toHaveLength(20)
  expect(defaultResults[0]?.eventId).toBe("since-24")

  const sinceResults = await searchEvents(sql, {
    query: "since needle",
    host: "since-host",
    since: "2026-11-12T11:00:20.000Z",
  })
  expect(sinceResults.map(event => event.eventId)).toEqual(["since-24", "since-23", "since-22", "since-21", "since-20"])
})

test("listSessions - aggregates by host and session ordered by last seen", async () => {
  await insertEvents(sql, [
    makeEvent({
      host: "summary-host",
      eventId: "summary-old",
      sessionId: "shared-session",
      project: "summary-project",
      ts: "2026-11-12T08:00:00.000Z",
    }),
    makeEvent({
      host: "summary-host",
      eventId: "summary-new",
      sessionId: "shared-session",
      project: "summary-project",
      ts: "2026-11-12T09:00:00.000Z",
    }),
    makeEvent({
      host: "other-summary-host",
      eventId: "summary-other",
      sessionId: "shared-session",
      project: "other-project",
      ts: "2026-11-12T09:30:00.000Z",
    }),
  ])

  expect(await listSessions(sql)).toEqual([
    {
      host: "other-summary-host",
      sessionId: "shared-session",
      project: "other-project",
      firstSeen: "2026-11-12T09:30:00.000Z",
      lastSeen: "2026-11-12T09:30:00.000Z",
    },
    {
      host: "summary-host",
      sessionId: "shared-session",
      project: "summary-project",
      firstSeen: "2026-11-12T08:00:00.000Z",
      lastSeen: "2026-11-12T09:00:00.000Z",
    },
  ])
})

test("transcript - orders by ts ascending", async () => {
  const longContent = "full tool output\n".repeat(400)
  await insertEvents(sql, [
    makeEvent({
      host: "transcript-host",
      sessionId: "transcript-session",
      eventId: "b",
      ts: "2026-11-12T12:00:00.000Z",
    }),
    makeEvent({
      host: "transcript-host",
      sessionId: "transcript-session",
      eventId: "a",
      ts: "2026-11-12T12:00:00.000Z",
      content: longContent,
    }),
    makeEvent({
      host: "transcript-host",
      sessionId: "transcript-session",
      eventId: "earlier",
      ts: "2026-11-12T11:59:00.000Z",
    }),
  ])

  const results = await transcript(sql, "transcript-host", "transcript-session")
  expect(results.map(event => event.eventId)).toEqual(["earlier", "a", "b"])
  expect(results[1]?.content).toBe(longContent)
})

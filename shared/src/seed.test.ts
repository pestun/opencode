import { expect, test } from "bun:test"
import type { HistoryClient } from "./client"
import type { HistoryEvent, HistoryEventKind } from "./event"
import { condenseTranscript, seedSession } from "./seed"

function event(kind: HistoryEventKind, content: string, ts: string, eventId = ts): HistoryEvent {
  return {
    host: "alpha",
    eventId,
    sessionId: "ses_source",
    project: "/repo/source",
    ts,
    kind,
    content,
    payload: { privateToolPayload: "must not leak" },
  }
}

test("condenseTranscript - drops tool payloads", () => {
  const result = condenseTranscript([
    event("message", "first line\nsecond line stays complete", "2026-11-12T10:00:00.000Z", "message"),
    event("tool", "bash success private command output", "2026-11-12T10:01:00.000Z", "tool-ok"),
    event("tool", "read failed private error output", "2026-11-12T10:02:00.000Z", "tool-failed"),
  ])

  expect(result).toContain("first line\nsecond line stays complete")
  expect(result).toContain("- tool bash: ok")
  expect(result).toContain("- tool read: failed")
  expect(result).not.toContain("private")
  expect(result).not.toContain("must not leak")
})

test("condenseTranscript - prepends fork header and sorts chronologically", () => {
  const result = condenseTranscript([
    event("message", "later message", "2026-11-12T11:00:00.000Z", "later"),
    event("session.created", "Original title", "2026-11-12T10:00:00.000Z", "created"),
  ])

  expect(result.startsWith("Forked from host alpha, session ses_source. Original below.\n")).toBe(true)
  expect(result.indexOf("Original title")).toBeLessThan(result.indexOf("later message"))
})

test("seedSession - rejects an unknown session before creating a local fork", async () => {
  let creates = 0
  const client: HistoryClient = {
    async ingest() {
      throw new Error("unknown session test must not ingest")
    },
    async search() {
      return []
    },
    async sessions() {
      return []
    },
    async transcript() {
      return []
    },
  }
  const ctx = {
    session: {
      async create() {
        creates++
        return { id: "ses_should_not_exist" }
      },
      async prompt() {
        throw new Error("unknown session must not be prompted")
      },
    },
  }

  await expect(seedSession(ctx, client, { host: "alpha", sessionId: "ses_missing" })).rejects.toThrow(
    "Session not found: alpha/ses_missing",
  )
  expect(creates).toBe(0)
})

test("condenseTranscript - respects budget by dropping oldest", () => {
  const newest = "[2026-11-12T11:00:00.000Z] message\n\nnewest message stays whole"
  const expected = `Forked from host alpha, session ses_source. Original below.\n\n${newest}`
  const result = condenseTranscript(
    [
      event("message", "old message must be dropped", "2026-11-12T09:00:00.000Z", "old"),
      event("message", "middle message must be dropped", "2026-11-12T10:00:00.000Z", "middle"),
      event("message", "newest message stays whole", "2026-11-12T11:00:00.000Z", "new"),
    ],
    expected.length,
  )

  expect(result).toBe(expected)
  expect(result.length).toBeLessThanOrEqual(expected.length)
})

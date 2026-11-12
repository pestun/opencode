import { expect, test } from "bun:test"
import type { HistoryEventKind } from "shared/event"
import { clip, mapEvent } from "./mapper"

function durableEvent(type: string, data: Record<string, unknown>, version = 1) {
  return {
    id: "evt_test",
    created: 0,
    type,
    durable: { aggregateID: "ses_1", seq: 1, version },
    data,
  }
}

function ephemeralEvent(type: string, data: Record<string, unknown>) {
  return { id: "evt_test", created: 0, type, data }
}

function expectMapped(
  event: { type: string; data: Record<string, unknown>; [k: string]: unknown },
  kind: HistoryEventKind,
  content: string,
) {
  expect(mapEvent({ host: "alpha", project: "/repo", event })).toEqual({
    host: "alpha",
    eventId: "evt_test",
    sessionId: "ses_1",
    project: "/repo",
    ts: "1970-01-01T00:00:00.000Z",
    kind,
    content,
    payload: event.data,
  })
}

test("mapEvent - session.created carries title", () => {
  const event = durableEvent("session.created", {
    sessionID: "ses_1",
    projectID: "prj_1",
    location: { directory: "/repo" },
    slug: "shared-history",
    title: "Shared history",
    version: "2.2.7",
  })

  expectMapped(event, "session.created", "Shared history")
})

test("mapEvent - session.created without a title has empty content", () => {
  const event = durableEvent("session.created", {
    sessionID: "ses_1",
    projectID: "prj_1",
    location: { directory: "/repo" },
    slug: "shared-history",
    version: "2.2.7",
  })

  expectMapped(event, "session.created", "")
})

test("mapEvent - session.renamed carries the new title", () => {
  expectMapped(
    durableEvent("session.renamed", { sessionID: "ses_1", title: "Renamed session" }),
    "session.renamed",
    "Renamed session",
  )
})

test("mapEvent - message content updates carry only assistant text", () => {
  const event = durableEvent("session.message.content.updated", {
    sessionID: "ses_1",
    messageID: "msg_1",
    content: [
      { type: "text", text: "First paragraph" },
      { type: "reasoning", text: "Private reasoning" },
      { type: "text", text: "Second paragraph" },
    ],
  })

  expectMapped(event, "message", "First paragraph\nSecond paragraph")
})

test("mapEvent - completed text carries the full message text", () => {
  const event = durableEvent("session.text.ended", {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    ordinal: 0,
    text: "Complete response",
  })

  expectMapped(event, "message", "Complete response")
})

test("mapEvent - tool calls carry serialized input", () => {
  const event = durableEvent("session.tool.called", {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    id: "call_grep",
    input: { pattern: "needle" },
    executed: false,
  })

  expectMapped(event, "tool", 'unknown called {"pattern":"needle"}')
})

test("mapEvent - successful tools carry text output", () => {
  const event = durableEvent(
    "session.tool.success",
    {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      id: "call_grep",
      content: [
        { type: "text", text: "Found 2 matches" },
        { type: "file", uri: "file:///repo/result.txt", mime: "text/plain" },
      ],
      metadata: { matches: 2 },
      executed: true,
    },
    2,
  )

  expectMapped(event, "tool", "unknown success Found 2 matches")
})

test("mapEvent - failed tools carry partial output and the error", () => {
  const event = durableEvent(
    "session.tool.failed",
    {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      id: "call_shell",
      error: { type: "tool.execution", message: "Command failed" },
      content: [{ type: "text", text: "Partial output" }],
      executed: true,
    },
    2,
  )

  expectMapped(event, "tool", "unknown failed Partial output\nCommand failed")
})

test.each([
  ["session.execution.started", {}, "started"],
  ["session.execution.succeeded", {}, "succeeded"],
  ["session.execution.failed", { error: { type: "provider", message: "Unavailable" } }, "failed"],
  ["session.execution.interrupted", { reason: "user" }, "interrupted"],
])("mapEvent - %s produces a one-line execution status", (type, data, status) => {
  expectMapped(durableEvent(type, { sessionID: "ses_1", ...data }), "execution", `execution ${status}`)
})

test("mapEvent - unknown type returns undefined", () => {
  const event = ephemeralEvent("session.text.delta", {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    ordinal: 0,
    delta: "partial",
  })

  expect(mapEvent({ host: "alpha", project: "/repo", event })).toBeUndefined()
})

test.each([
  [
    "session.reasoning.delta",
    ephemeralEvent("session.reasoning.delta", {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      ordinal: 0,
      delta: "reasoning fragment",
    }),
  ],
  [
    "session.usage.updated",
    ephemeralEvent("session.usage.updated", {
      sessionID: "ses_1",
      cost: 0.01,
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    }),
  ],
  [
    "session.inbox.delivered",
    durableEvent("session.inbox.delivered", { sessionID: "ses_1", inboxID: "msg_inbox" }),
  ],
  [
    "session.step.streamed",
    durableEvent("session.step.streamed", { sessionID: "ses_1", assistantMessageID: "msg_1" }),
  ],
])("mapEvent - excludes %s", (_type, event) => {
  expect(mapEvent({ host: "alpha", project: "/repo", event })).toBeUndefined()
})

test("mapEvent - preserves whitespace in tool output", () => {
  const event = durableEvent(
    "session.tool.success",
    {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      id: "call_read",
      content: [{ type: "text", text: " output \n" }],
      executed: true,
    },
    2,
  )

  expectMapped(event, "tool", "unknown success  output \n")
})

test("mapEvent - clips tool output to 4096 bytes", () => {
  const prefix = `${"a".repeat(4095)}é`
  const event = durableEvent(
    "session.tool.success",
    {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      id: "call_read",
      content: [{ type: "text", text: `${prefix}z` }],
      executed: true,
    },
    2,
  )

  expectMapped(event, "tool", `unknown success ${prefix}…[truncated]`)
})

test("clip - preserves text at the budget and clips text above it", () => {
  expect(clip("abcdef", 6)).toBe("abcdef")
  expect(clip("abcdefgh", 6)).toBe("abcdef…[truncated]")
})

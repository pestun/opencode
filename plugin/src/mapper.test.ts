import { expect, test } from "bun:test"
import type { HistoryEventKind } from "shared/event"
import { clip, createMapper } from "./mapper"

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

function payloadStrings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(payloadStrings)
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(payloadStrings)
  return []
}

function expectMapped(
  event: { type: string; data: Record<string, unknown>; [k: string]: unknown },
  kind: HistoryEventKind,
  content: string,
  payload: Record<string, unknown> = event.data,
) {
  expect(createMapper()({ host: "alpha", project: "/repo", event })).toEqual({
    host: "alpha",
    eventId: "evt_test",
    sessionId: "ses_1",
    project: "/repo",
    ts: "1970-01-01T00:00:00.000Z",
    kind,
    content,
    payload,
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

  expectMapped(event, "tool", 'call_grep called {"pattern":"needle"}')
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

  expectMapped(event, "tool", "call_grep success Found 2 matches")
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

  expectMapped(event, "tool", "call_shell failed Partial output\nCommand failed")
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

  expect(createMapper()({ host: "alpha", project: "/repo", event })).toBeUndefined()
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
  expect(createMapper()({ host: "alpha", project: "/repo", event })).toBeUndefined()
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

  expectMapped(event, "tool", "call_read success  output \n")
})

test("mapEvent - correlates tool names by call ID without recording input.started", () => {
  const mapEvent = createMapper()
  const started = durableEvent("session.tool.input.started", {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    id: "call_grep",
    name: "grep",
  })
  const called = durableEvent("session.tool.called", {
    sessionID: "ses_1",
    assistantMessageID: "msg_1",
    id: "call_grep",
    input: { pattern: "needle" },
    executed: false,
  })
  const succeeded = durableEvent(
    "session.tool.success",
    {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      id: "call_grep",
      content: [{ type: "text", text: "Found" }],
      executed: true,
    },
    2,
  )
  const failed = durableEvent(
    "session.tool.failed",
    {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      id: "call_grep",
      error: { type: "tool.execution", message: "Failed" },
      executed: true,
    },
    2,
  )

  expect(mapEvent({ host: "alpha", project: "/repo", event: started })).toBeUndefined()
  expect(mapEvent({ host: "alpha", project: "/repo", event: called })?.content).toBe('grep called {"pattern":"needle"}')
  expect(mapEvent({ host: "alpha", project: "/repo", event: succeeded })?.content).toBe("grep success Found")
  expect(mapEvent({ host: "alpha", project: "/repo", event: failed })?.content).toBe("grep failed Failed")
})

test("mapEvent - clips tool output to 4096 bytes without splitting Unicode", () => {
  const prefix = "a".repeat(4081)
  const output = `${prefix}é${"z".repeat(20)}`
  const expected = `${prefix}…[truncated]`
  const result = clip(output)

  expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(4096)
  expect(Buffer.byteLength(expected, "utf8")).toBe(4095)
  expect(result).toBe(expected)
  expect(result.includes(String.fromCodePoint(0xfffd))).toBe(false)

  const event = durableEvent(
    "session.tool.success",
    {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      id: "call_read",
      content: [{ type: "text", text: output }],
      executed: true,
    },
    2,
  )
  expectMapped(event, "tool", `call_read success ${expected}`, {
    ...event.data,
    content: [{ type: "text", text: expected }],
  })
})

test("mapEvent - bounds every nested string in tool payloads", () => {
  const output = "🙂".repeat(2500)
  const event = durableEvent(
    "session.tool.success",
    {
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      id: "call_read",
      content: [{ type: "text", text: output }],
      metadata: { detail: { text: output } },
      executed: true,
    },
    2,
  )

  const record = createMapper()({ host: "alpha", project: "/repo", event })
  const strings = payloadStrings(record?.payload)
  expect(strings.length).toBeGreaterThan(0)
  expect(strings.filter((value) => Buffer.byteLength(value, "utf8") > 4096)).toEqual([])
  expect(strings).not.toContain(output)
})

test("clip - preserves text at the byte budget and includes the suffix within it", () => {
  expect(clip("abcdef", 20)).toBe("abcdef")
  expect(clip("abcdefghijklmnopqrstu", 20)).toBe("abcdef…[truncated]")
  expect(Buffer.byteLength(clip("abcdefghijklmnopqrstu", 20), "utf8")).toBe(20)
})

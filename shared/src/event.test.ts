import { test, expect } from "bun:test"
import { decodeHistoryEvent, decodeHistoryEventBatch } from "./event"

const valid = {
  host: "alpha",
  eventId: "e1",
  sessionId: "s1",
  project: "/p",
  ts: new Date(0).toISOString(),
  kind: "message" as const,
  content: "hello",
  payload: {},
}

test("accepts a valid record", () => expect(decodeHistoryEvent(valid)).toEqual(valid))
test("rejects missing host", () => expect(() => decodeHistoryEvent({ ...valid, host: "" })).toThrow("host"))
test("rejects non-ISO ts", () => expect(() => decodeHistoryEvent({ ...valid, ts: "yesterday" })).toThrow("ts"))
test("batch rejects if any item invalid", () =>
  expect(() => decodeHistoryEventBatch([valid, { ...valid, kind: "nope" }])).toThrow("kind"))

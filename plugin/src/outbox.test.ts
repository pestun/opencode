import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HistoryEvent } from "shared/event"
import { ack, append, outboxPath, readPending } from "./outbox"

let directory = ""
let originalOutbox: string | undefined
let warnings: ReturnType<typeof spyOn>

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "shared-history-outbox-"))
  originalOutbox = process.env.HISTORY_OUTBOX
  process.env.HISTORY_OUTBOX = join(directory, "nested", "outbox.jsonl")
  warnings = spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(async () => {
  if (originalOutbox === undefined) delete process.env.HISTORY_OUTBOX
  else process.env.HISTORY_OUTBOX = originalOutbox
  warnings.mockRestore()
  await rm(directory, { recursive: true, force: true })
})

function event(index: number, content = `event ${index}`): HistoryEvent {
  return {
    host: "alpha",
    eventId: `evt_${index}`,
    sessionId: "ses_1",
    project: "/repo",
    ts: "2026-11-12T00:00:00.000Z",
    kind: "message",
    content,
    payload: { index },
  }
}

function largeEvent(index: number): HistoryEvent {
  return event(index, "x".repeat(64 * 1024))
}

test("outboxPath uses HISTORY_OUTBOX and otherwise the XDG default", () => {
  expect(outboxPath()).toBe(join(directory, "nested", "outbox.jsonl"))
  delete process.env.HISTORY_OUTBOX
  expect(outboxPath()).toBe(join(process.env.HOME ?? "", ".local/share/opencode-shared-history/outbox.jsonl"))
})

test("append/read roundtrip preserves order", async () => {
  await append([event(1), event(2)])
  await append([event(3)])

  expect(await readPending()).toEqual([event(1), event(2), event(3)])
  expect(outboxPath()).toBe(join(directory, "nested", "outbox.jsonl"))
})

test("readOutbox - tolerates truncated final line", async () => {
  await append([event(1), event(2)])
  const bytes = await readFile(outboxPath())
  await writeFile(outboxPath(), bytes.subarray(0, bytes.length - 5))

  expect(await readPending()).toEqual([event(1)])
  expect(warnings).toHaveBeenCalledTimes(1)
})

test("ack removes exactly the acked prefix", async () => {
  await append([event(1), event(2), event(3)])

  await ack(2)

  expect(await readPending()).toEqual([event(3)])
})

test("replay skips individually invalid lines", async () => {
  await append([event(1), event(2)])
  const invalid = JSON.stringify({ ...event(99), kind: "invalid" })
  await writeFile(outboxPath(), `${JSON.stringify(event(1))}\n${invalid}\n{"torn"\n${JSON.stringify(event(2))}\n`)

  expect(await readPending()).toEqual([event(1), event(2)])
  expect(warnings).toHaveBeenCalledTimes(2)
})

test("ack counts decoded records rather than invalid physical lines", async () => {
  await append([event(1)])
  await writeFile(
    outboxPath(),
    `${JSON.stringify(event(1))}\nnot-json\n${JSON.stringify(event(2))}\n${JSON.stringify(event(3))}\n`,
  )

  await ack(2)

  expect(await readPending()).toEqual([event(3)])
})

test("interleaved append and ack calls do not lose unacked records", async () => {
  const first = Array.from({ length: 100 }, (_, index) => event(index))
  const operations: Promise<void>[] = [append(first)]

  for (let start = 0; start < first.length; start += 10) {
    operations.push(ack(3))
    operations.push(append(Array.from({ length: 10 }, (_, offset) => event(100 + start + offset))))
  }
  await Promise.all(operations)

  const pending = await readPending()
  expect(pending.slice(0, 70)).toEqual(first.slice(30))
  expect(pending.slice(70)).toEqual(Array.from({ length: 100 }, (_, index) => event(100 + index)))
  expect(pending).toHaveLength(170)
})

test("at 10 MB append discards the oldest half with one warning", async () => {
  const records = Array.from({ length: 170 }, (_, index) => largeEvent(index))

  await append(records)

  const pending = await readPending()
  expect(pending[0]?.eventId).toBe("evt_85")
  expect(pending).toHaveLength(85)
  expect(warnings).toHaveBeenCalledTimes(1)
  expect((await readFile(outboxPath(), "utf8")).endsWith("\n")).toBe(true)
})

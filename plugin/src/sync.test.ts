import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHistoryClient, type HistoryClient } from "shared/client"
import type { HistoryEvent } from "shared/event"
import { startTestService, type TestService } from "../../service/src/testkit.js"
import { append, readPending } from "./outbox"
import { createSyncLoop } from "./sync"

let directory = ""
let originalOutbox: string | undefined
let service: TestService
let liveClient: HistoryClient
let loops: { stop(): void }[] = []

beforeAll(async () => {
  service = await startTestService()
  liveClient = createHistoryClient({ url: service.url, token: service.token })
})

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "shared-history-sync-"))
  originalOutbox = process.env.HISTORY_OUTBOX
  process.env.HISTORY_OUTBOX = join(directory, "outbox.jsonl")
})

afterEach(async () => {
  for (const loop of loops) loop.stop()
  loops = []
  if (originalOutbox === undefined) delete process.env.HISTORY_OUTBOX
  else process.env.HISTORY_OUTBOX = originalOutbox
  await rm(directory, { recursive: true, force: true })
})

afterAll(async () => {
  await service.stop()
})

function event(index: number, host: string): HistoryEvent {
  return {
    host,
    eventId: `sync_${index}`,
    sessionId: "ses_sync",
    project: "/repo",
    ts: "2026-11-12T00:00:00.000Z",
    kind: "message",
    content: `event ${index}`,
    payload: { index },
  }
}

function track(client: HistoryClient | (() => HistoryClient | undefined), onError?: (error: unknown) => void) {
  const loop = createSyncLoop({ client, intervalMs: 60_000, onError })
  loops.push(loop)
  return loop
}

async function eventually(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 5_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await assertion()
      return
    } catch (error) {
      lastError = error
      await Bun.sleep(10)
    }
  }
  throw lastError
}

test("sync - offline keeps records and recovers", async () => {
  const host = `sync-offline-${crypto.randomUUID()}`
  const events = [event(1, host), event(2, host), event(3, host)]
  await append(events)
  const offlineClient = createHistoryClient({
    url: "http://127.0.0.1:1",
    token: "offline",
  })
  let client = offlineClient
  let reportError!: () => void
  const reported = new Promise<void>(resolve => {
    reportError = resolve
  })
  const errors: unknown[] = []
  const loop = track(
    () => client,
    error => {
      errors.push(error)
      reportError()
    },
  )

  expect(() => loop.notify()).not.toThrow()
  await reported
  expect(errors).toHaveLength(1)
  expect(await readPending()).toEqual(events)

  client = liveClient
  loop.notify()
  await eventually(async () => {
    expect(await liveClient.transcript(host, "ses_sync")).toEqual(events)
    expect(await readPending()).toEqual([])
  })
  expect(errors).toHaveLength(1)
})

test("sync - no client means no-op", async () => {
  const host = `sync-no-client-${crypto.randomUUID()}`
  const events = [event(1, host)]
  await append(events)
  const errors: unknown[] = []
  const loop = createSyncLoop({
    intervalMs: 1,
    onError: error => errors.push(error),
  })
  loops.push(loop)

  loop.notify()
  await Bun.sleep(25)

  expect(await readPending()).toEqual(events)
  expect(errors).toEqual([])
  expect(await liveClient.transcript(host, "ses_sync")).toEqual([])
})

test("sync - ingests batches of 100 and acknowledges only after success", async () => {
  const host = `sync-batches-${crypto.randomUUID()}`
  const events = Array.from({ length: 205 }, (_, index) => event(index + 1, host))
  await append(events)
  const batches: number[] = []
  const client: HistoryClient = {
    ...liveClient,
    async ingest(batch) {
      batches.push(batch.length)
      await liveClient.ingest(batch)
    },
  }
  const loop = track(client)

  loop.notify()
  await eventually(async () => {
    expect(await readPending()).toEqual([])
  })

  expect(batches).toEqual([100, 100, 5])
  expect(await liveClient.transcript(host, "ses_sync")).toHaveLength(205)
})

test("sync - overlapping triggers stay single-flight and coalesce a follow-up", async () => {
  const host = `sync-single-flight-${crypto.randomUUID()}`
  await append([event(1, host)])
  let calls = 0
  let active = 0
  let maximumActive = 0
  let markStarted!: () => void
  const started = new Promise<void>(resolve => {
    markStarted = resolve
  })
  let unblock!: () => void
  const blocked = new Promise<void>(resolve => {
    unblock = resolve
  })
  const client: HistoryClient = {
    ...liveClient,
    async ingest(batch) {
      calls++
      active++
      maximumActive = Math.max(maximumActive, active)
      try {
        if (calls === 1) {
          markStarted()
          await blocked
        }
        await liveClient.ingest(batch)
      } finally {
        active--
      }
    },
  }
  const loop = track(client)

  loop.notify()
  await started
  await append([event(2, host)])
  loop.notify()
  loop.notify()
  await Bun.sleep(20)
  expect(calls).toBe(1)

  unblock()
  await eventually(async () => {
    expect(await readPending()).toEqual([])
  })
  expect(calls).toBe(2)
  expect(maximumActive).toBe(1)
  expect(await liveClient.transcript(host, "ses_sync")).toHaveLength(2)
})

test("sync - reports once per failure streak and resets after success", async () => {
  const host = `sync-errors-${crypto.randomUUID()}`
  await append([event(1, host)])
  const offlineClient = createHistoryClient({
    url: "http://127.0.0.1:1",
    token: "offline",
  })
  let client = offlineClient
  const errors: unknown[] = []
  let nextReport: (() => void) | undefined
  const loop = track(
    () => client,
    error => {
      errors.push(error)
      nextReport?.()
    },
  )
  const reported = () =>
    new Promise<void>(resolve => {
      nextReport = resolve
    })

  let report = reported()
  loop.notify()
  await report
  expect(errors).toHaveLength(1)

  loop.notify()
  await Bun.sleep(25)
  expect(errors).toHaveLength(1)
  expect(await readPending()).toHaveLength(1)

  client = liveClient
  loop.notify()
  await eventually(async () => {
    expect(await readPending()).toEqual([])
  })

  client = offlineClient
  await append([event(2, host)])
  report = reported()
  loop.notify()
  await report
  expect(errors).toHaveLength(2)
  expect(await readPending()).toEqual([event(2, host)])
})

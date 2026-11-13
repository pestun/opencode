import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHistoryClient, type HistoryClient } from "shared/client"
import type { HistoryEvent } from "shared/event"
import { condenseTranscript, seedSession } from "shared/seed"
import { startTestService, type TestService } from "../../service/src/testkit.js"
import plugin from "./index"
import { readPending } from "./outbox"
import { createHistoryTools } from "./tools"

const unconfiguredText = "history service not configured (set HISTORY_URL and HISTORY_TOKEN)"
let service: TestService
let client: HistoryClient
let temporaryDirectory: string | undefined
let originalEnvironment: Record<string, string | undefined> = {}

beforeAll(async () => {
  service = await startTestService()
  client = createHistoryClient({ url: service.url, token: service.token })
})

afterEach(async () => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnvironment = {}
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

afterAll(async () => {
  await service.stop()
})

function configureTemporaryOutbox(host: string): void {
  originalEnvironment = {
    HISTORY_OUTBOX: process.env.HISTORY_OUTBOX,
    HISTORY_URL: process.env.HISTORY_URL,
    HISTORY_TOKEN: process.env.HISTORY_TOKEN,
    HISTORY_HOST: process.env.HISTORY_HOST,
  }
  process.env.HISTORY_URL = service.url
  process.env.HISTORY_TOKEN = service.token
  process.env.HISTORY_HOST = host
}

function sourceEvent(overrides: Partial<HistoryEvent> = {}): HistoryEvent {
  return {
    host: `seed-${crypto.randomUUID()}`,
    eventId: "event-1",
    sessionId: "ses_source",
    project: "/repo/source",
    ts: "2026-11-12T10:00:00.000Z",
    kind: "message",
    content: "Remember this decision",
    payload: {},
    ...overrides,
  }
}

test("seed - admits context without execution", async () => {
  const source = sourceEvent()
  const toolEvent: HistoryEvent = {
    ...source,
    eventId: "event-2",
    ts: "2026-11-12T10:01:00.000Z",
    kind: "tool",
    content: "bash success secret tool output",
  }
  await client.ingest([source, toolEvent])
  const condensed = condenseTranscript([source, toolEvent])
  const createCalls: Array<{
    title: string
    metadata: { forkedFrom: { host: string; sessionId: string } }
    parentID?: string
  }> = []
  const promptCalls: Array<{ sessionID: string; text: string; resume: boolean }> = []
  const ctx = {
    session: {
      async create(input: (typeof createCalls)[number]) {
        createCalls.push(input)
        return { id: "ses_independent" }
      },
      async prompt(input: (typeof promptCalls)[number]) {
        promptCalls.push(input)
        return { id: "message-1" }
      },
    },
  }

  const result = await seedSession(ctx, client, { host: source.host, sessionId: source.sessionId! })

  expect(result).toEqual({ newSessionId: "ses_independent" })
  expect(createCalls).toEqual([
    {
      title: `Fork of ${source.sessionId} on ${source.host}`,
      metadata: { forkedFrom: { host: source.host, sessionId: source.sessionId! } },
    },
  ])
  expect(createCalls[0]).not.toHaveProperty("parentID")
  expect(promptCalls).toEqual([{ sessionID: "ses_independent", text: condensed, resume: false }])
  expect(promptCalls[0]?.text).not.toContain("secret tool output")
})

test("tools - search returns formatted snippets", async () => {
  const source = sourceEvent({ content: "decision X\nwith implementation notes" })
  await client.ingest([source])
  const tools = createHistoryTools(
    {
      session: {
        async create() {
          return { id: "unused" }
        },
        async prompt() {
          return {}
        },
      },
    },
    client,
  )

  const result = await tools.history_search.execute({ query: "decision X", host: source.host })

  expect(result).toEqual({
    content: `[${source.ts}] host=${source.host} project=${source.project} session=${source.sessionId}\ndecision X with implementation notes`,
  })
})

test("tools - seed rejects an empty transcript before creating a session", async () => {
  let creates = 0
  const tools = createHistoryTools(
    {
      session: {
        async create() {
          creates++
          return { id: "ses_should_not_exist" }
        },
        async prompt() {
          return {}
        },
      },
    },
    client,
  )

  await expect(
    tools.history_seed.execute({ host: `missing-${crypto.randomUUID()}`, sessionId: "ses_missing" }),
  ).rejects.toThrow("Session not found:")
  expect(creates).toBe(0)
})

test("tools - unconfigured returns instructions text", async () => {
  const ctx = {
    session: {
      async create() {
        throw new Error("unconfigured seed must not create a session")
      },
      async prompt() {
        throw new Error("unconfigured seed must not admit a prompt")
      },
    },
  }
  const tools = createHistoryTools(ctx)

  expect(await tools.history_search.execute({ query: "anything" })).toEqual({ content: unconfiguredText })
  expect(await tools.history_transcript.execute({ sessionId: "ses_source" })).toEqual({ content: unconfiguredText })
  expect(await tools.history_seed.execute({ sessionId: "ses_source" })).toEqual({ content: unconfiguredText })
})

test("plugin - captures events and registers all history tools", async () => {
  const host = `plugin-${crypto.randomUUID()}`
  configureTemporaryOutbox(host)
  temporaryDirectory = await mkdtemp(join(tmpdir(), "shared-history-plugin-"))
  process.env.HISTORY_OUTBOX = join(temporaryDirectory, "outbox.jsonl")
  const registered: string[] = []
  const ctx = {
    location: { directory: "/repo/plugin" },
    event: {
      subscribe() {
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              id: `plugin-${crypto.randomUUID()}`,
              created: Date.parse("2026-11-12T12:00:00.000Z"),
              type: "session.text.ended",
              data: { sessionID: "ses_plugin", text: "captured through plugin" },
            }
          },
        }
      },
    },
    tool: {
      async transform(callback: (editor: { add(tool: { name: string }): void }) => void) {
        callback({ add: tool => registered.push(tool.name) })
        return { dispose: async () => {} }
      },
    },
    session: {
      async create() {
        return { id: "unused" }
      },
      async prompt() {
        return {}
      },
    },
  }

  const cleanup = await plugin.setup(ctx)
  try {
    const deadline = Date.now() + 5_000
    let captured = false
    while (!captured && Date.now() < deadline) {
      const [matches, pending] = await Promise.all([
        client.search({ query: "captured through plugin", host }),
        readPending(),
      ])
      captured = matches.length === 1 && pending.length === 0
      if (!captured) await Bun.sleep(10)
    }
    expect(captured).toBe(true)
    expect(registered).toEqual(["history_search", "history_transcript", "history_seed"])
  } finally {
    await cleanup?.()
  }
})

test("plugin - a malformed event warns and does not stop later capture", async () => {
  const host = `plugin-malformed-${crypto.randomUUID()}`
  configureTemporaryOutbox(host)
  temporaryDirectory = await mkdtemp(join(tmpdir(), "shared-history-plugin-"))
  process.env.HISTORY_OUTBOX = join(temporaryDirectory, "outbox.jsonl")
  const warnings = spyOn(console, "warn").mockImplementation(() => {})
  const ctx = {
    location: { directory: "/repo/plugin" },
    event: {
      subscribe() {
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              id: "bad-timestamp",
              created: Number.NaN,
              type: "session.text.ended",
              data: { sessionID: "ses_plugin", text: "must not stop capture" },
            }
            yield {
              id: "valid-after-malformed",
              created: Date.parse("2026-11-12T12:00:00.000Z"),
              type: "session.text.ended",
              data: { sessionID: "ses_plugin", text: "valid event survives malformed capture" },
            }
          },
        }
      },
    },
    tool: {
      async transform() {
        return { dispose: async () => {} }
      },
    },
    session: {
      async create() {
        return { id: "unused" }
      },
      async prompt() {
        return {}
      },
    },
  }

  const cleanup = await plugin.setup(ctx)
  try {
    let matches: HistoryEvent[] = []
    const deadline = Date.now() + 5_000
    while (matches.length === 0 && Date.now() < deadline) {
      matches = await client.search({ query: "valid event survives malformed capture", host })
      if (matches.length === 0) await Bun.sleep(10)
    }
    expect(matches).toHaveLength(1)
    expect(await readPending()).toEqual([])
    expect(
      warnings.mock.calls.some(
        ([message]) =>
          typeof message === "string" && message.includes("session.text.ended") && message.includes("bad-timestamp"),
      ),
    ).toBe(true)
  } finally {
    await cleanup?.()
    warnings.mockRestore()
  }
}, 10_000)

test("plugin - setup failures warn without breaking opencode", async () => {
  const warnings = spyOn(console, "warn").mockImplementation(() => {})
  try {
    const ctx = {
      location: { directory: "/repo/plugin" },
      event: {
        subscribe() {
          throw new Error("event API unavailable")
        },
      },
      tool: {
        async transform() {
          return { dispose: async () => {} }
        },
      },
      session: {
        async create() {
          return { id: "unused" }
        },
        async prompt() {
          return {}
        },
      },
    }

    await expect(plugin.setup(ctx)).resolves.toBeUndefined()
    expect(warnings).toHaveBeenCalled()
  } finally {
    warnings.mockRestore()
  }
})

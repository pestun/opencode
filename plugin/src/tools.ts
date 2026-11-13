import { hostname } from "node:os"
import type { HistoryClient, HistorySearchParams } from "shared/client"
import { seedSession, type SeedContext } from "shared/seed"

export const unconfiguredHistoryMessage = "history service not configured (set HISTORY_URL and HISTORY_TOKEN)"

type HistoryTool<Input> = {
  name: string
  description: string
  input: Record<string, unknown>
  execute(input: Input): Promise<{ content: string }>
}

export type HistoryToolContext = SeedContext & {
  tool: {
    transform(
      callback: (editor: { add<Input>(tool: HistoryTool<Input>): void }) => void,
    ): Promise<unknown>
  }
}

type SessionReference = {
  sessionId: string
  host?: string
}

export function createHistoryTools(ctx: SeedContext, client?: HistoryClient, localHost = defaultHost()) {
  const history_search: HistoryTool<HistorySearchParams> = {
    name: "history_search",
    description: "Search shared opencode history and return matching snippets with source references.",
    input: {
      type: "object",
      properties: {
        query: { type: "string" },
        host: { type: "string" },
        project: { type: "string" },
        since: { type: "string", format: "date-time" },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async execute(input) {
      if (!client) return { content: unconfiguredHistoryMessage }
      const events = await client.search(input)
      return {
        content: events
          .map(
            event =>
              `[${event.ts}] host=${event.host} project=${event.project} session=${event.sessionId ?? "-"}\n` +
              event.content.replace(/\s+/g, " ").trim(),
          )
          .join("\n\n"),
      }
    },
  }

  const history_transcript: HistoryTool<SessionReference> = {
    name: "history_transcript",
    description: "Read the ordered transcript of a session from shared opencode history.",
    input: sessionReferenceInput(),
    async execute(input) {
      if (!client) return { content: unconfiguredHistoryMessage }
      const events = await client.transcript(input.host ?? localHost, input.sessionId)
      return {
        content: events.map(event => `[${event.ts}] ${event.kind}: ${event.content}`).join("\n"),
      }
    },
  }

  const history_seed: HistoryTool<SessionReference> = {
    name: "history_seed",
    description:
      "Create an independent local session containing condensed history as admitted context without running it.",
    input: sessionReferenceInput(),
    async execute(input) {
      if (!client) return { content: unconfiguredHistoryMessage }
      const host = input.host ?? localHost
      const result = await seedSession(ctx, client, { host, sessionId: input.sessionId })
      return {
        content: `Created session ${result.newSessionId}\nOpen it with: opencode --session ${result.newSessionId}`,
      }
    },
  }

  return { history_search, history_transcript, history_seed }
}

export async function registerHistoryTools(ctx: HistoryToolContext, client?: HistoryClient): Promise<void> {
  const host = process.env.HISTORY_HOST ?? hostname()
  const tools = createHistoryTools(ctx, client, host)
  await ctx.tool.transform(editor => {
    editor.add(tools.history_search)
    editor.add(tools.history_transcript)
    editor.add(tools.history_seed)
  })
}

function sessionReferenceInput(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      sessionId: { type: "string" },
      host: { type: "string" },
    },
    required: ["sessionId"],
    additionalProperties: false,
  }
}

function defaultHost(): string {
  return process.env.HISTORY_HOST ?? hostname()
}

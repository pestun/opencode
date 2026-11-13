import type { HistoryClient } from "./client"
import type { HistoryEvent } from "./event"

export type SeedContext = {
  session: {
    create(input: {
      title: string
      metadata: { forkedFrom: { host: string; sessionId: string } }
    }): Promise<{ id: string }>
    prompt(input: { sessionID: string; text: string; resume: false }): Promise<unknown>
  }
}

export function condenseTranscript(events: HistoryEvent[], budget = 16000): string {
  const source = events[0]
  const host = source?.host ?? "unknown"
  const sessionId = source?.sessionId ?? "unknown"
  const header = `Forked from host ${host}, session ${sessionId}. Original below.`
  const chronological = [...events].sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts))
  const rendered = chronological.map(eventMarkdown)
  const render = () => [header, ...rendered].join("\n\n")

  while (rendered.length > 0 && render().length > budget) rendered.shift()
  return render()
}

export async function seedSession(
  ctx: SeedContext,
  client: HistoryClient,
  source: { host: string; sessionId: string },
): Promise<{ newSessionId: string }> {
  const events = await client.transcript(source.host, source.sessionId)
  if (events.length === 0) throw new Error(`Session not found: ${source.host}/${source.sessionId}`)
  const session = await ctx.session.create({
    title: `Fork of ${source.sessionId} on ${source.host}`,
    metadata: { forkedFrom: source },
  })
  await ctx.session.prompt({
    sessionID: session.id,
    text: condenseTranscript(events),
    resume: false,
  })
  return { newSessionId: session.id }
}

function eventMarkdown(event: HistoryEvent): string {
  if (event.kind !== "tool") return `[${event.ts}] ${event.kind}\n\n${event.content}`

  const [contentName, contentStatus] = event.content.split(/\s+/)
  const name = typeof event.payload.name === "string" ? event.payload.name : (contentName ?? "unknown")
  const status = contentStatus === "failed" ? "failed" : "ok"
  return `- tool ${name}: ${status}`
}

import type { HistoryEvent, HistoryEventKind } from "shared/event"

/**
 * Field names verified against opencode v2.2.7 `packages/schema/src/event.ts`, `session-event.ts`, `tool.ts`, and
 * `packages/core/src/session/message-updater.ts` / `projector.ts`:
 * - Event envelopes carry `id`, epoch-millisecond `created`, `type`, and payload fields under `data.sessionID`.
 * - `session.text.ended` carries full text in `data.text`; content updates carry encoded parts in `data.content`, with
 *   assistant text in each `{ type: "text", text }` part.
 * - Called tools carry input in `data.input`; settled tools carry output in `data.content` text parts. Failed tools
 *   also carry `data.error.message`. Only the non-allowlisted `session.tool.input.started` event carries `data.name`,
 *   so the allowlisted called/success/failed events use an optional `data.name` when available and `unknown` otherwise.
 */
export function mapEvent(input: {
  host: string
  project: string
  event: { type: string; [k: string]: unknown }
}): HistoryEvent | undefined {
  const data = isRecord(input.event.data) ? input.event.data : {}
  const mapped = mapContent(input.event.type, data)
  if (!mapped) return

  return {
    host: input.host,
    eventId: typeof input.event.id === "string" ? input.event.id : "",
    sessionId: typeof data.sessionID === "string" ? data.sessionID : null,
    project: input.project,
    ts: new Date(typeof input.event.created === "number" ? input.event.created : 0).toISOString(),
    kind: mapped.kind,
    content: mapped.content,
    payload: data,
  }
}

export function clip(text: string, max = 4096): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…[truncated]`
}

function mapContent(
  type: string,
  data: Record<string, unknown>,
): { kind: HistoryEventKind; content: string } | undefined {
  switch (type) {
    case "session.created":
    case "session.renamed":
      return { kind: type, content: typeof data.title === "string" ? data.title : "" }
    case "session.message.content.updated":
      return { kind: "message", content: contentText(data.content) }
    case "session.text.ended":
      return { kind: "message", content: typeof data.text === "string" ? data.text : "" }
    case "session.tool.called":
      return { kind: "tool", content: toolContent(data, "called", JSON.stringify(data.input ?? {}) ?? "") }
    case "session.tool.success":
      return { kind: "tool", content: toolContent(data, "success", contentText(data.content)) }
    case "session.tool.failed": {
      const error = isRecord(data.error) && typeof data.error.message === "string" ? data.error.message : ""
      const text = [contentText(data.content), error].filter((part) => part.length > 0).join("\n")
      return { kind: "tool", content: toolContent(data, "failed", text) }
    }
    case "session.execution.started":
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return { kind: "execution", content: `execution ${type.slice("session.execution.".length)}` }
    default:
      return
  }
}

function toolContent(data: Record<string, unknown>, status: string, text: string): string {
  const name = typeof data.name === "string" ? data.name : "unknown"
  const clipped = clip(text)
  return clipped.length > 0 ? `${name} ${status} ${clipped}` : `${name} ${status}`
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ""
  return content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

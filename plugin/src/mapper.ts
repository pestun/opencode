import type { HistoryEvent, HistoryEventKind } from "shared/event"

const encoder = new TextEncoder()
const truncationSuffix = "…[truncated]"

/**
 * Field names verified against opencode v2.2.7 `packages/schema/src/event.ts`, `session-event.ts`, `tool.ts`, and
 * `packages/core/src/session/message-updater.ts` / `projector.ts`:
 * - Event envelopes carry `id`, epoch-millisecond `created`, `type`, and payload fields under `data.sessionID`.
 * - `session.text.ended` carries full text in `data.text`; content updates carry encoded parts in `data.content`, with
 *   assistant text in each `{ type: "text", text }` part.
 * - Called tools carry input in `data.input`; settled tools carry output in `data.content` text parts. Failed tools
 *   also carry `data.error.message`. `session.tool.input.started` carries `data.id` and `data.name`; it only updates
 *   the mapper's call-ID registry and emits no history record. A plugin restart loses names, so later events fall back
 *   to optional `data.name` and then their required call ID in `data.id`.
 */
type MapperInput = {
  host: string
  project: string
  event: { type: string; [k: string]: unknown }
}

export function createMapper() {
  const toolNames = new Map<string, string>()

  return function mapEvent(input: MapperInput): HistoryEvent | undefined {
    const data = isRecord(input.event.data) ? input.event.data : {}
    if (input.event.type === "session.tool.input.started") {
      if (typeof data.id === "string" && typeof data.name === "string") toolNames.set(data.id, data.name)
      return
    }

    const mapped = mapContent(input.event.type, data, toolNames)
    if (!mapped) return

    return {
      host: input.host,
      eventId: typeof input.event.id === "string" ? input.event.id : "",
      sessionId: typeof data.sessionID === "string" ? data.sessionID : null,
      project: input.project,
      ts: new Date(typeof input.event.created === "number" ? input.event.created : 0).toISOString(),
      kind: mapped.kind,
      content: mapped.content,
      payload: mapped.kind === "tool" ? boundPayload(data) : data,
    }
  }
}

export function clip(text: string, max = 4096): string {
  if (max <= 0) return ""
  if (encoder.encode(text).byteLength <= max) return text

  const suffixLength = encoder.encode(truncationSuffix).byteLength
  if (suffixLength >= max) return utf8Prefix(truncationSuffix, max)
  return `${utf8Prefix(text, max - suffixLength)}${truncationSuffix}`
}

function utf8Prefix(text: string, max: number): string {
  let bytes = 0
  let end = 0
  for (const character of text) {
    const size = encoder.encode(character).byteLength
    if (bytes + size > max) break
    bytes += size
    end += character.length
  }
  return text.slice(0, end)
}

function mapContent(
  type: string,
  data: Record<string, unknown>,
  toolNames: ReadonlyMap<string, string>,
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
      return { kind: "tool", content: toolContent(data, toolNames, "called", JSON.stringify(data.input ?? {}) ?? "") }
    case "session.tool.success":
      return { kind: "tool", content: toolContent(data, toolNames, "success", contentText(data.content)) }
    case "session.tool.failed": {
      const error = isRecord(data.error) && typeof data.error.message === "string" ? data.error.message : ""
      const text = [contentText(data.content), error].filter((part) => part.length > 0).join("\n")
      return { kind: "tool", content: toolContent(data, toolNames, "failed", text) }
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

function toolContent(
  data: Record<string, unknown>,
  toolNames: ReadonlyMap<string, string>,
  status: string,
  text: string,
): string {
  const id = typeof data.id === "string" ? data.id : undefined
  const name = (id === undefined ? undefined : toolNames.get(id)) ??
    (typeof data.name === "string" ? data.name : undefined) ??
    id ??
    "unknown"
  const clipped = clip(text)
  return clipped.length > 0 ? `${name} ${status} ${clipped}` : `${name} ${status}`
}

function boundPayload(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, boundPayloadValue(value, 1)]))
}

function boundPayloadValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return clip(value)
  if (Array.isArray(value)) {
    if (depth >= 8) return truncationSuffix
    return value.slice(0, 100).map((item) => boundPayloadValue(item, depth + 1))
  }
  if (isRecord(value)) {
    if (depth >= 8) return truncationSuffix
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, boundPayloadValue(nested, depth + 1)]),
    )
  }
  return value
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

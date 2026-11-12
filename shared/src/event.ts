export type HistoryEventKind = "session.created" | "session.renamed" | "message" | "tool" | "execution"

export type HistoryEvent = {
  host: string
  eventId: string
  sessionId: string | null
  project: string
  ts: string
  kind: HistoryEventKind
  content: string
  payload: Record<string, unknown>
}

const historyEventKinds: ReadonlySet<string> = new Set([
  "session.created",
  "session.renamed",
  "message",
  "tool",
  "execution",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`)
  }
  return value
}

function requireNonEmptyString(value: unknown, field: string): string {
  const stringValue = requireString(value, field)
  if (stringValue.length === 0) {
    throw new Error(`${field} must not be empty`)
  }
  return stringValue
}

function isHistoryEventKind(value: unknown): value is HistoryEventKind {
  return typeof value === "string" && historyEventKinds.has(value)
}

export function decodeHistoryEvent(input: unknown): HistoryEvent {
  if (!isRecord(input)) {
    throw new Error("event must be an object")
  }

  const host = requireNonEmptyString(input.host, "host")
  const eventId = requireNonEmptyString(input.eventId, "eventId")
  const sessionId = input.sessionId == null ? null : requireNonEmptyString(input.sessionId, "sessionId")
  const project = requireNonEmptyString(input.project, "project")
  const ts = requireNonEmptyString(input.ts, "ts")
  if (!ts.includes("T") || Number.isNaN(Date.parse(ts))) {
    throw new Error("ts must be an ISO 8601 timestamp")
  }
  if (!isHistoryEventKind(input.kind)) {
    throw new Error("kind must be a supported history event kind")
  }
  const content = requireString(input.content, "content")
  if (!isRecord(input.payload)) {
    throw new Error("payload must be an object")
  }

  return { host, eventId, sessionId, project, ts, kind: input.kind, content, payload: input.payload }
}

export function decodeHistoryEventBatch(input: unknown): HistoryEvent[] {
  if (!Array.isArray(input)) {
    throw new Error("batch must be an array")
  }
  return input.map((item) => decodeHistoryEvent(item))
}

import { fileURLToPath } from "node:url"
import postgres, { type Sql } from "postgres"
import { decodeHistoryEventBatch, type HistoryEvent } from "shared/event"

const defaultDatabaseUrl = "postgres://history:history@localhost:54329/history"
const migrations = new WeakMap<Sql, Promise<unknown>>()

export type SessionSummary = {
  host: string
  sessionId: string
  project: string
  firstSeen: string
  lastSeen: string
}

type EventRow = {
  host: string
  event_id: string
  session_id: string | null
  project: string
  ts: string | Date
  kind: string
  payload: Record<string, unknown>
  content: string
}

type SessionRow = {
  host: string
  session_id: string
  project: string
  first_seen: string | Date
  last_seen: string | Date
}

function toIsoString(timestamp: string | Date): string {
  return typeof timestamp === "string" ? new Date(timestamp).toISOString() : timestamp.toISOString()
}

function historyEvents(rows: EventRow[]): HistoryEvent[] {
  return decodeHistoryEventBatch(
    rows.map(row => ({
      host: row.host,
      eventId: row.event_id,
      sessionId: row.session_id,
      project: row.project,
      ts: toIsoString(row.ts),
      kind: row.kind,
      content: row.content,
      payload: row.payload,
    })),
  )
}

function migrate(sql: Sql): Promise<unknown> {
  const migrationPath = fileURLToPath(new URL("./migrations/001_init.sql", import.meta.url))
  return Promise.resolve(sql.file(migrationPath))
}

async function migrated(sql: Sql): Promise<void> {
  let migration = migrations.get(sql)
  if (migration === undefined) {
    migration = migrate(sql)
    migrations.set(sql, migration)
  }
  try {
    await migration
  } catch (error) {
    if (migrations.get(sql) === migration) migrations.delete(sql)
    throw error
  }
}

export function connect(databaseUrl?: string): Sql {
  const sql = postgres(databaseUrl ?? process.env.DATABASE_URL ?? defaultDatabaseUrl, { onnotice: () => {} })
  migrations.set(sql, migrate(sql))
  return sql
}

export async function insertEvents(sql: Sql, events: HistoryEvent[]): Promise<{ inserted: number }> {
  if (events.length === 0) {
    return { inserted: 0 }
  }
  await migrated(sql)
  const rows = events.map(event => ({
    host: event.host,
    event_id: event.eventId,
    session_id: event.sessionId,
    project: event.project,
    ts: event.ts,
    kind: event.kind,
    payload: sql.json(event.payload as postgres.JSONValue),
    content: event.content,
  }))
  const result = await sql`
    insert into events ${sql(rows)}
    on conflict (host, event_id) do nothing
  `
  return { inserted: result.count }
}

export async function searchEvents(
  sql: Sql,
  { query, host, project, since, limit = 20 }: {
    query: string
    host?: string
    project?: string
    since?: string
    limit?: number
  },
): Promise<HistoryEvent[]> {
  await migrated(sql)
  const escaped = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")
  const pattern = `%${escaped}%`
  const rows = await sql<EventRow[]>`
    select host, event_id, session_id, project, ts, kind, payload, content
    from events
    where content ilike ${pattern} escape '\\'
      ${host === undefined ? sql`` : sql`and host = ${host}`}
      ${project === undefined ? sql`` : sql`and project = ${project}`}
      ${since === undefined ? sql`` : sql`and ts >= ${since}`}
    order by ts desc
    limit ${Math.min(limit, 100)}
  `
  return historyEvents(rows)
}

export async function listSessions(sql: Sql): Promise<SessionSummary[]> {
  await migrated(sql)
  const rows = await sql<SessionRow[]>`
    select
      host,
      session_id,
      (array_agg(project order by ts desc, event_id desc))[1] as project,
      min(ts) as first_seen,
      max(ts) as last_seen
    from events
    where session_id is not null
    group by host, session_id
    order by last_seen desc
  `
  return rows.map(row => ({
    host: row.host,
    sessionId: row.session_id,
    project: row.project,
    firstSeen: toIsoString(row.first_seen),
    lastSeen: toIsoString(row.last_seen),
  }))
}

export async function transcript(sql: Sql, host: string, sessionId: string): Promise<HistoryEvent[]> {
  await migrated(sql)
  const rows = await sql<EventRow[]>`
    select host, event_id, session_id, project, ts, kind, payload, content
    from events
    where host = ${host} and session_id = ${sessionId}
    order by ts asc, event_id asc
  `
  return historyEvents(rows)
}

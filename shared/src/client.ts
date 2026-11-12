import { decodeHistoryEventBatch, type HistoryEvent } from "./event"

export type HistorySearchParams = {
  query: string
  host?: string
  project?: string
  since?: string
  limit?: number
}

export type SessionSummary = {
  host: string
  sessionId: string
  project: string
  firstSeen: string
  lastSeen: string
}

export type HistoryClient = {
  ingest(events: HistoryEvent[]): Promise<void>
  search(params: HistorySearchParams): Promise<HistoryEvent[]>
  sessions(): Promise<SessionSummary[]>
  transcript(host: string, sessionId: string): Promise<HistoryEvent[]>
}

type HistoryClientOptions = {
  url: string
  token: string
}

export function createHistoryClient({ url, token }: HistoryClientOptions): HistoryClient {
  const baseUrl = url.replace(/\/+$/, "")

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set("Authorization", `Bearer ${token}`)
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) {
      throw new Error(`history service ${response.status}: ${await response.text()}`)
    }
    return response
  }

  return {
    async ingest(events) {
      await request("/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(events),
      })
    },

    async search(params) {
      const query = new URLSearchParams({ query: params.query })
      if (params.host !== undefined) query.set("host", params.host)
      if (params.project !== undefined) query.set("project", params.project)
      if (params.since !== undefined) query.set("since", params.since)
      if (params.limit !== undefined) query.set("limit", String(params.limit))
      const response = await request(`/search?${query}`)
      return decodeHistoryEventBatch(await response.json())
    },

    async sessions() {
      const response = await request("/sessions")
      return (await response.json()) as SessionSummary[]
    },

    async transcript(host, sessionId) {
      const response = await request(
        `/sessions/${encodeURIComponent(host)}/${encodeURIComponent(sessionId)}/transcript`,
      )
      return decodeHistoryEventBatch(await response.json())
    },
  }
}

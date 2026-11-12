import { Hono } from "hono"
import type { Sql } from "postgres"
import { decodeHistoryEventBatch, type HistoryEvent } from "shared/event"
import { insertEvents, listSessions, searchEvents, transcript } from "./db"

export function buildApp(sql: Sql, token: string): Hono {
  const app = new Hono()

  app.use("*", async (c, next) => {
    if (c.req.path !== "/health" && c.req.header("Authorization") !== `Bearer ${token}`) {
      return c.json({ error: "unauthorized" }, 401)
    }
    await next()
  })

  app.get("/health", c => c.json({ status: "ok" }))

  app.post("/events", async c => {
    let events: HistoryEvent[]
    try {
      events = decodeHistoryEventBatch(await c.req.json())
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "invalid event batch" }, 400)
    }
    return c.json(await insertEvents(sql, events))
  })

  app.get("/search", async c => {
    const limit = c.req.query("limit")
    return c.json(
      await searchEvents(sql, {
        query: c.req.query("query") ?? "",
        host: c.req.query("host"),
        project: c.req.query("project"),
        since: c.req.query("since"),
        limit: limit === undefined ? undefined : Number(limit),
      }),
    )
  })

  app.get("/sessions", async c => c.json(await listSessions(sql)))
  app.get("/sessions/:host/:sessionId/transcript", async c =>
    c.json(await transcript(sql, c.req.param("host"), c.req.param("sessionId"))),
  )

  return app
}

import type { Sql } from "postgres"
import { buildApp } from "./app"
import { connect, listSessions } from "./db"

export type TestService = {
  url: string
  token: string
  sql: Sql
  stop(): Promise<void>
}

/**
 * Starts the real Hono service on a random port with migrated Postgres storage and a test token.
 * Returns its base URL, bearer token, SQL handle for data cleanup, and stop() to close both resources.
 */
export async function startTestService(): Promise<TestService> {
  const sql = connect()
  await listSessions(sql)
  const token = "test-token"
  const server = Bun.serve({ port: 0, fetch: buildApp(sql, token).fetch })

  return {
    url: `http://127.0.0.1:${server.port}`,
    token,
    sql,
    async stop() {
      server.stop(true)
      await sql.end()
    },
  }
}

import { buildApp } from "./app"
import { connect } from "./db"

const token = process.env.HISTORY_TOKEN
if (!token) {
  throw new Error("HISTORY_TOKEN required")
}

const sql = connect(process.env.DATABASE_URL)
const server = Bun.serve({
  port: Number(process.env.PORT ?? 8797),
  fetch: buildApp(sql, token).fetch,
})

console.log(`history service listening on ${server.url}`)

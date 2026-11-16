import { buildApp } from "./app"
import { connect, listSessions } from "./db"

const token = process.env.HISTORY_TOKEN
if (!token) {
  throw new Error("HISTORY_TOKEN required")
}

const sql = connect(process.env.DATABASE_URL)
const maxStartupAttempts = 10
for (let attempt = 1; attempt <= maxStartupAttempts; attempt++) {
  try {
    await listSessions(sql)
    break
  } catch (error) {
    if (attempt === maxStartupAttempts) {
      await sql.end()
      throw new Error(
        `History database startup failed after ${maxStartupAttempts} attempts; check DATABASE_URL and PostgreSQL availability`,
        { cause: error },
      )
    }
    const delay = Math.min(500 * 2 ** (attempt - 1), 5000)
    console.warn(`History database startup attempt ${attempt}/${maxStartupAttempts} failed; retrying in ${delay} ms`)
    await Bun.sleep(delay)
  }
}
const server = Bun.serve({
  port: Number(process.env.PORT ?? 8797),
  fetch: buildApp(sql, token).fetch,
})

console.log(`history service listening on ${server.url}`)

import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createHistoryClient } from "shared/client"
import type { HistoryEvent } from "shared/event"

async function docker(args: string[]): Promise<void> {
  const child = Bun.spawn({ cmd: ["docker", ...args], stdout: "pipe", stderr: "pipe" })
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  if (exit !== 0) throw new Error(`docker ${args.join(" ")} failed: ${stderr}`)
}

function unusedPort(): number {
  const listener = Bun.serve({ port: 0, fetch: () => new Response("unused") })
  const port = listener.port
  listener.stop(true)
  return port
}

async function collect(stream: ReadableStream<Uint8Array>, append: (text: string) => void): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) return
    append(decoder.decode(value, { stream: true }))
  }
}

test("startup retries migration until a temporarily unavailable database is usable", async () => {
  const databasePort = unusedPort()
  const container = `shared-history-startup-${process.pid}-${Date.now()}`
  const token = "startup-test-token"
  const source: HistoryEvent = {
    host: "startup-host",
    eventId: "startup-event",
    sessionId: "startup-session",
    project: "startup-project",
    ts: "2026-11-12T10:00:00.000Z",
    kind: "message",
    content: "database recovered",
    payload: {},
  }

  await docker([
    "create",
    "--name", container,
    "--publish", `127.0.0.1:${databasePort}:5432`,
    "--env", "POSTGRES_DB=history",
    "--env", "POSTGRES_USER=history",
    "--env", "POSTGRES_PASSWORD=history",
    "postgres:16-alpine",
  ])
  try {
    const child = Bun.spawn({
      cmd: [process.execPath, "run", "src/index.ts"],
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: {
        ...process.env,
        HISTORY_TOKEN: token,
        DATABASE_URL: `postgres://history:history@127.0.0.1:${databasePort}/history`,
        PORT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    let stdout = ""
    let stderr = ""
    const output = Promise.all([
      collect(child.stdout, text => { stdout += text }),
      collect(child.stderr, text => { stderr += text }),
    ])
    try {
      // Let the first connection fail while the stopped container's port is unavailable.
      await Bun.sleep(300)
      await docker(["start", container])

      const deadline = Date.now() + 15_000
      let recovered = false
      let lastError: unknown
      while (Date.now() < deadline && !recovered) {
        const match = /https?:\/\/[^\s]+/.exec(stdout)
        if (match) {
          const client = createHistoryClient({ url: match[0], token })
          try {
            await client.ingest([source])
            expect(await client.transcript(source.host, source.sessionId!)).toEqual([source])
            recovered = true
          } catch (error) {
            lastError = error
          }
        }
        if (!recovered) await Bun.sleep(100)
      }
      if (!recovered) {
        throw new Error(`service did not recover; stdout=${stdout}; stderr=${stderr}`, { cause: lastError })
      }
    } finally {
      if (child.exitCode === null) child.kill()
      await child.exited
      await output
    }
  } finally {
    await docker(["rm", "-f", container])
  }
}, 30_000)

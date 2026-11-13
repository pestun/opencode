#!/usr/bin/env bun
import { createHistoryClient, type HistorySearchParams } from "shared/client"
import { condenseTranscript } from "shared/seed"

export type CliOutput = {
  stdout(line: string): void
  stderr(line: string): void
}

const defaultOutput: CliOutput = {
  stdout: line => console.log(line),
  stderr: line => console.error(line),
}

const usage = `Usage: oc-history <command> [args]
  search <query> [--host H] [--project P] [--since ISO] [--limit N]
  sessions
  transcript <host> <sessionId>
  seed <host> <sessionId>`

function printUsage(output: CliOutput): number {
  output.stderr(usage)
  return 2
}

function singleLine(content: string): string {
  return content.replace(/\s+/g, " ").trim()
}

function parseSearch(args: string[]): HistorySearchParams | undefined {
  const query = args[0]
  if (query === undefined) return undefined

  const params: HistorySearchParams = { query }
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (value === undefined) return undefined

    switch (option) {
      case "--host":
        params.host = value
        break
      case "--project":
        params.project = value
        break
      case "--since":
        params.since = value
        break
      case "--limit": {
        const limit = Number(value)
        if (!Number.isInteger(limit) || limit <= 0) return undefined
        params.limit = limit
        break
      }
      default:
        return undefined
    }
  }
  return params
}

export async function runCli(
  argv: string[],
  env: Record<string, string | undefined>,
  output: CliOutput = defaultOutput,
): Promise<number> {
  const command = argv[0]
  if (command !== "search" && command !== "sessions" && command !== "transcript" && command !== "seed") {
    return printUsage(output)
  }

  const url = env.HISTORY_URL
  if (!url) {
    output.stderr("HISTORY_URL is required; set HISTORY_URL to the history service URL")
    return 1
  }

  const client = createHistoryClient({ url, token: env.HISTORY_TOKEN ?? "" })
  const args = argv.slice(1)

  try {
    if (command === "search") {
      const params = parseSearch(args)
      if (!params) return printUsage(output)
      for (const event of await client.search(params)) {
        output.stdout(
          `${event.ts}  ${event.host}  ${event.sessionId ?? "-"}  ${singleLine(event.content).slice(0, 120)}`,
        )
      }
      return 0
    }

    if (command === "sessions") {
      if (args.length !== 0) return printUsage(output)
      for (const session of await client.sessions()) {
        output.stdout(
          `${session.lastSeen}  ${session.host}  ${session.sessionId}  ${session.project}  ${session.firstSeen}`,
        )
      }
      return 0
    }

    if (args.length !== 2) return printUsage(output)
    const [host, sessionId] = args
    if (command === "seed") {
      const text = condenseTranscript(await client.transcript(host, sessionId))
      const server = await localOpenCodeUrl(env)
      const created = await localOpenCodeRequest(server, "/api/session", {
        title: `Fork of ${sessionId} on ${host}`,
        metadata: { forkedFrom: { host, sessionId } },
      })
      const newSessionId = sessionIdFromResponse(created)
      await localOpenCodeRequest(server, `/api/session/${encodeURIComponent(newSessionId)}/prompt`, {
        text,
        resume: false,
      })
      output.stdout(`Created session ${newSessionId}`)
      output.stdout(`Open it with: opencode --session ${newSessionId}`)
      return 0
    }

    for (const event of await client.transcript(host, sessionId)) {
      output.stdout(`[${event.ts}] ${event.kind}: ${singleLine(event.content)}`)
    }
    return 0
  } catch (error) {
    output.stderr(error instanceof Error ? error.message : "history service request failed")
    return 1
  }
}

async function localOpenCodeUrl(env: Record<string, string | undefined>): Promise<string> {
  const child = Bun.spawn(["opencode", "service", "status"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  const url = stdout.trim()
  if (exit !== 0 || !/^https?:\/\//.test(url)) {
    throw new Error("Could not reach a local opencode server; start opencode first")
  }
  return url.replace(/\/+$/, "")
}

async function localOpenCodeRequest(server: string, path: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${server}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`local opencode request failed (${response.status}): ${await response.text()}`)
  return response.json()
}

function sessionIdFromResponse(response: unknown): string {
  if (typeof response === "object" && response !== null && "data" in response) {
    const data = response.data
    if (typeof data === "object" && data !== null && "id" in data && typeof data.id === "string") return data.id
  }
  throw new Error("local opencode create response did not contain a session id")
}

if (import.meta.main) {
  process.exitCode = await runCli(Bun.argv.slice(2), process.env)
}

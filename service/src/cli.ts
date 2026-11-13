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
      const events = await client.transcript(host, sessionId)
      if (events.length === 0) throw new Error(`Session not found: ${host}/${sessionId}`)
      const text = condenseTranscript(events)
      const server = await discoverLocalOpenCode(env)
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

const localServerMessage = "Could not reach a local opencode server; start opencode first"

type LocalOpenCode = {
  url: string
  authorization?: string
}

async function discoverLocalOpenCode(env: Record<string, string | undefined>): Promise<LocalOpenCode> {
  let status: { exit: number; stdout: string }
  try {
    status = await openCodeCommand(env, ["status"])
  } catch {
    throw new Error(localServerMessage)
  }
  const url = status.stdout.trim()
  if (status.exit !== 0 || !/^https?:\/\//.test(url)) throw new Error(localServerMessage)

  const credentials = await openCodeCommand(env, ["get", "password"]).catch(() => undefined)
  const password = credentials?.exit === 0 ? credentials.stdout.trim() : ""
  return {
    url: url.replace(/\/+$/, ""),
    ...(password
      ? { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` }
      : {}),
  }
}

async function openCodeCommand(
  env: Record<string, string | undefined>,
  args: string[],
): Promise<{ exit: number; stdout: string }> {
  const child = Bun.spawn(["opencode", "service", ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  return { exit, stdout }
}

async function localOpenCodeRequest(
  server: LocalOpenCode,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${server.url}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(server.authorization ? { Authorization: server.authorization } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    throw new Error(localServerMessage)
  }
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

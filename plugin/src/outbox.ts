import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { decodeHistoryEventBatch, type HistoryEvent } from "shared/event"

const maxOutboxBytes = 10 * 1024 * 1024
let queue: Promise<void> = Promise.resolve()

export function outboxPath(): string {
  return process.env.HISTORY_OUTBOX ?? join(homedir(), ".local/share/opencode-shared-history/outbox.jsonl")
}

export function append(events: HistoryEvent[]): Promise<void> {
  if (events.length === 0) return Promise.resolve()

  return serialize(async () => {
    const path = outboxPath()
    await mkdir(dirname(path), { recursive: true })
    const file = await open(path, "a+")
    try {
      const { size } = await file.stat()
      let separator = ""
      if (size > 0) {
        const lastByte = Buffer.alloc(1)
        await file.read(lastByte, 0, 1, size - 1)
        if (lastByte[0] !== 10) separator = "\n"
      }
      await file.appendFile(`${separator}${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8")
    } finally {
      await file.close()
    }

    if ((await stat(path)).size <= maxOutboxBytes) return
    const lines = outboxLines(await readFile(path, "utf8"))
    let retainedBytes = Buffer.byteLength(`${lines.join("\n")}\n`, "utf8")
    while (lines.length > 0 && retainedBytes > maxOutboxBytes) {
      retainedBytes -= Buffer.byteLength(lines.shift()!, "utf8") + 1
    }
    await replace(path, lines.length > 0 ? `${lines.join("\n")}\n` : "")
    console.warn("History outbox exceeded 10 MB; discarded oldest records to fit (oversized records are dropped)")
  })
}

export function readPending(): Promise<HistoryEvent[]> {
  return serialize(async () => {
    const path = outboxPath()
    let lines: string[]
    try {
      lines = outboxLines(await readFile(path, "utf8"))
    } catch (error) {
      if (isMissingFile(error)) return []
      throw error
    }

    const events: HistoryEvent[] = []
    for (const [index, line] of lines.entries()) {
      try {
        events.push(decodeLine(line))
      } catch (error) {
        console.warn(`Skipping invalid history outbox line ${index + 1}`, error)
      }
    }
    return events
  })
}

export function ack(expected: HistoryEvent[]): Promise<boolean> {
  return serialize(async () => {
    if (expected.length === 0) return true

    const path = outboxPath()
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch (error) {
      if (isMissingFile(error)) return false
      throw error
    }

    const lines = text.split("\n")
    let matched = 0
    for (let index = 0; index < lines.length; index++) {
      let current: HistoryEvent
      try {
        current = decodeLine(lines[index] ?? "")
      } catch {
        continue
      }

      const event = expected[matched]!
      if (current.host !== event.host || current.eventId !== event.eventId) return false
      matched++
      if (matched === expected.length) {
        await replace(path, lines.slice(index + 1).join("\n"))
        return true
      }
    }
    return false
  })
}

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation)
  queue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

function outboxLines(text: string): string[] {
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

function decodeLine(line: string): HistoryEvent {
  const decoded = decodeHistoryEventBatch([JSON.parse(line)])[0]
  if (decoded === undefined) throw new Error("history outbox line did not contain an event")
  return decoded
}

async function replace(path: string, contents: string): Promise<void> {
  const temporaryPath = `${path}.tmp`
  await writeFile(temporaryPath, contents, "utf8")
  await rename(temporaryPath, path)
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

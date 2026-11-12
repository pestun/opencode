import type { createHistoryClient } from "shared/client"
import { ack, readPending } from "./outbox"

type HistoryClient = ReturnType<typeof createHistoryClient>
type ClientSource = HistoryClient | (() => HistoryClient | undefined)

type SyncLoopOptions = {
  /** A getter is resolved on every flush, allowing endpoint changes without restarting the loop. */
  client?: ClientSource
  intervalMs?: number
  onError?: (error: unknown) => void
}

export function createSyncLoop({ client, intervalMs = 2000, onError = console.warn }: SyncLoopOptions) {
  if (client === undefined) return { notify() {}, stop() {} }

  const getClient = typeof client === "function" ? client : () => client
  let stopped = false
  let inFlight = false
  let followUp = false
  let failures = 0
  let failureReported = false
  let immediateTimer: ReturnType<typeof setTimeout> | undefined
  let flushTimer: ReturnType<typeof setTimeout> | undefined

  function scheduleImmediate() {
    if (stopped || immediateTimer !== undefined) return
    immediateTimer = setTimeout(() => {
      immediateTimer = undefined
      requestFlush(true)
    }, 0)
    immediateTimer.unref()
  }

  function scheduleFlush(delay: number) {
    if (stopped) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      requestFlush(false)
    }, delay)
    flushTimer.unref()
  }

  function requestFlush(immediate: boolean) {
    if (stopped) return
    if (inFlight) {
      if (immediate) followUp = true
      return
    }
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    void flush()
  }

  async function flush() {
    inFlight = true
    let nextDelay = intervalMs
    try {
      const currentClient = getClient()
      if (currentClient !== undefined) {
        const pending = await readPending()
        for (let offset = 0; offset < pending.length; offset += 100) {
          const batch = pending.slice(offset, offset + 100)
          await currentClient.ingest(batch)
          await ack(batch.length)
        }
        failures = 0
        failureReported = false
      }
    } catch (error) {
      failures++
      nextDelay = Math.min(intervalMs * 2 ** (failures - 1), 60_000)
      if (!failureReported) {
        failureReported = true
        try {
          onError(error)
        } catch {}
      }
    } finally {
      inFlight = false
      if (!stopped) {
        if (followUp) {
          followUp = false
          scheduleImmediate()
        } else {
          scheduleFlush(nextDelay)
        }
      }
    }
  }

  scheduleFlush(intervalMs)

  return {
    notify() {
      if (stopped) return
      if (inFlight) {
        followUp = true
        return
      }
      scheduleImmediate()
    },
    stop() {
      stopped = true
      followUp = false
      if (immediateTimer !== undefined) {
        clearTimeout(immediateTimer)
        immediateTimer = undefined
      }
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer)
        flushTimer = undefined
      }
    },
  }
}

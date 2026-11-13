import { hostname } from "node:os"
import { createHistoryClient } from "shared/client"
import { createMapper } from "./mapper"
import { append } from "./outbox"
import { createSyncLoop } from "./sync"
import { registerHistoryTools, type HistoryToolContext } from "./tools"

type OpenCodeEvent = { type: string; [key: string]: unknown }

type PluginContext = HistoryToolContext & {
  location: { directory: string }
  event: { subscribe(): AsyncIterable<OpenCodeEvent> }
}

export default {
  id: "shared-history",
  async setup(ctx: PluginContext) {
    let sync: ReturnType<typeof createSyncLoop> | undefined
    let iterator: AsyncIterator<OpenCodeEvent> | undefined
    let consumer: Promise<void> | undefined
    let stopped = false

    try {
      const url = process.env.HISTORY_URL
      const token = process.env.HISTORY_TOKEN
      const client = url && token ? createHistoryClient({ url, token }) : undefined
      const mapper = createMapper()
      const host = process.env.HISTORY_HOST ?? hostname()
      const loop = createSyncLoop({ client })
      sync = loop
      iterator = ctx.event.subscribe()[Symbol.asyncIterator]()
      consumer = (async () => {
        try {
          while (!stopped) {
            const next = await iterator.next()
            if (next.done) return
            const event = mapper({ host, project: ctx.location.directory, event: next.value })
            if (!event) continue
            await append([event])
            loop.notify()
          }
        } catch (error) {
          if (!stopped) console.warn("shared-history capture failed", error)
        }
      })()

      await registerHistoryTools(ctx, client)
      return async () => {
        stopped = true
        loop.stop()
        await iterator?.return?.()
        await consumer
      }
    } catch (error) {
      stopped = true
      sync?.stop()
      await iterator?.return?.()
      await consumer
      console.warn("shared-history plugin setup failed", error)
    }
  },
}

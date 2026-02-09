// Label commands: list, get, create, delete, counts.
// Manages Gmail labels with table output and cache integration.

import type { Goke } from 'goke'
import { z } from 'zod'
import { authenticate } from '../auth.js'
import { GmailClient } from '../gmail-client.js'
import { GmailCache } from '../gmail-cache.js'
import * as out from '../output.js'

export function registerLabelCommands(cli: Goke) {
  // =========================================================================
  // label list
  // =========================================================================

  cli
    .command('label list', 'List all labels')
    .option('--json', 'Output as JSON')
    .option('--no-cache', 'Skip cache')
    .action(async (options: { json?: boolean; noCache?: boolean }) => {
      const auth = await authenticate()
      const client = new GmailClient({ auth })
      const cache = options.noCache ? null : new GmailCache()

      type LabelList = Awaited<ReturnType<GmailClient['listLabels']>>
      let labels = cache?.getCachedLabels<LabelList>()
      if (!labels) {
        labels = await client.listLabels()
        cache?.cacheLabels(labels)
      }

      cache?.close()

      if (options.json) {
        out.printJson(labels)
        return
      }

      if (labels.length === 0) {
        out.hint('No labels found')
        return
      }

      // Sort: user labels first, then system
      const sorted = [...labels].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'user' ? -1 : 1
        return a.name.localeCompare(b.name)
      })

      out.printTable({
        head: ['ID', 'Name', 'Type'],
        rows: sorted.map((l) => [l.id, l.name, l.type]),
      })

      out.hint(`${labels.length} label(s)`)
    })

  // =========================================================================
  // label get
  // =========================================================================

  cli
    .command('label get <labelId>', 'Get label details with counts')
    .option('--json', 'Output as JSON')
    .action(async (labelId: string, options: { json?: boolean }) => {
      const auth = await authenticate()
      const client = new GmailClient({ auth })

      const label = await client.getLabel({ labelId })

      if (options.json) {
        out.printJson(label)
        return
      }

      out.printTable({
        head: ['Field', 'Value'],
        rows: [
          ['ID', label.id],
          ['Name', label.name],
          ['Type', label.type],
          ['Messages (total)', label.messagesTotal],
          ['Messages (unread)', label.messagesUnread],
          ['Threads (total)', label.threadsTotal],
          ['Threads (unread)', label.threadsUnread],
        ],
      })
    })

  // =========================================================================
  // label create
  // =========================================================================

  cli
    .command('label create <name>', 'Create a new label')
    .option('--bg-color <bgColor>', z.string().describe('Background color (hex, e.g. #4986e7)'))
    .option('--text-color <textColor>', z.string().describe('Text color (hex, e.g. #ffffff)'))
    .option('--json', 'Output as JSON')
    .action(async (name: string, options: {
      bgColor?: string
      textColor?: string
      json?: boolean
    }) => {
      const auth = await authenticate()
      const client = new GmailClient({ auth })

      const result = await client.createLabel({
        name,
        color: options.bgColor && options.textColor
          ? { backgroundColor: options.bgColor, textColor: options.textColor }
          : undefined,
      })

      // Invalidate cache
      const cache = new GmailCache()
      cache.invalidateLabels()
      cache.close()

      if (options.json) {
        out.printJson(result)
        return
      }

      out.success(`Label created: "${result.name}" (ID: ${result.id})`)
    })

  // =========================================================================
  // label delete
  // =========================================================================

  cli
    .command('label delete <labelId>', 'Delete a label')
    .option('--force', 'Skip confirmation')
    .option('--json', 'Output as JSON')
    .action(async (labelId: string, options: { force?: boolean; json?: boolean }) => {
      if (!options.force && process.stdin.isTTY) {
        const readline = await import('node:readline')
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
        const answer = await new Promise<string>((resolve) => {
          rl.question(`Delete label ${labelId}? [y/N] `, resolve)
        })
        rl.close()

        if (answer.toLowerCase() !== 'y') {
          out.hint('Cancelled')
          return
        }
      }

      const auth = await authenticate()
      const client = new GmailClient({ auth })

      await client.deleteLabel({ labelId })

      // Invalidate cache
      const cache = new GmailCache()
      cache.invalidateLabels()
      cache.invalidateLabelCounts()
      cache.close()

      if (options.json) {
        out.printJson({ labelId, deleted: true })
        return
      }

      out.success(`Label ${labelId} deleted`)
    })

  // =========================================================================
  // label counts
  // =========================================================================

  cli
    .command('label counts', 'Show unread counts per label')
    .option('--json', 'Output as JSON')
    .option('--no-cache', 'Skip cache')
    .action(async (options: { json?: boolean; noCache?: boolean }) => {
      const auth = await authenticate()
      const client = new GmailClient({ auth })
      const cache = options.noCache ? null : new GmailCache()

      type CountList = Awaited<ReturnType<GmailClient['getLabelCounts']>>
      let counts = cache?.getCachedLabelCounts<CountList>()
      if (!counts) {
        counts = await client.getLabelCounts()
        cache?.cacheLabelCounts(counts)
      }

      cache?.close()

      if (options.json) {
        out.printJson(counts)
        return
      }

      // Filter to labels with counts > 0 and sort descending
      const withCounts = counts.filter((c) => c.count > 0).sort((a, b) => b.count - a.count)

      if (withCounts.length === 0) {
        out.hint('All clear — no unread messages')
        return
      }

      out.printTable({
        head: ['Label', 'Count'],
        rows: withCounts.map((c) => [c.label, c.count]),
        colAligns: ['left', 'right'],
      })
    })
}

// Label commands: list, get, create, delete, counts.
// Manages Gmail labels with YAML output.
// Cache is handled by the client — commands just call methods and use data.
// Multi-account: list and counts fetch all accounts concurrently and merge.

import type { Goke } from 'goke'
import { z } from 'zod'
import { getClients, getClient } from '../auth.js'
import * as out from '../output.js'

export function registerLabelCommands(cli: Goke) {
  // =========================================================================
  // label list
  // =========================================================================

  cli
    .command('label list', 'List all labels')
    .action(async (options) => {
      const clients = await getClients(options.account)

      // Fetch from all accounts concurrently, tolerating individual failures
      const settled = await Promise.allSettled(
        clients.map(async ({ email, client }) => {
          const { parsed: labels } = await client.listLabels()
          return { email, labels }
        }),
      )

      const allResults = settled
        .filter((r): r is PromiseFulfilledResult<{ email: string; labels: ReturnType<typeof import('../gmail-client.js').GmailClient.parseRawLabels> }> => {
          if (r.status === 'rejected') {
            out.error(`Failed to fetch labels: ${r.reason}`)
            return false
          }
          return true
        })
        .map((r) => r.value)

      // Merge labels from all accounts
      const merged = allResults.flatMap(({ email, labels }) =>
        labels.map((l) => ({ ...l, account: email })),
      )

      if (merged.length === 0) {
        out.hint('No labels found')
        return
      }

      // Sort: user labels first, then system
      const sorted = [...merged].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'user' ? -1 : 1
        return a.name.localeCompare(b.name)
      })

      const showAccount = clients.length > 1
      out.printList(
        sorted.map((l) => ({
          ...(showAccount ? { account: l.account } : {}),
          id: l.id,
          name: l.name,
          type: l.type,
        })),
      )

      out.hint(`${merged.length} label(s)`)
    })

  // =========================================================================
  // label get
  // =========================================================================

  cli
    .command('label get <labelId>', 'Get label details with counts')
    .action(async (labelId, options) => {
      const { client } = await getClient(options.account)

      const label = await client.getLabel({ labelId })

      out.printYaml({
        id: label.id,
        name: label.name,
        type: label.type,
        messages_total: label.messagesTotal,
        messages_unread: label.messagesUnread,
        threads_total: label.threadsTotal,
        threads_unread: label.threadsUnread,
      })
    })

  // =========================================================================
  // label create
  // =========================================================================

  cli
    .command('label create <name>', 'Create a new label')
    .option('--bg-color <bgColor>', z.string().describe('Background color (hex, e.g. #4986e7)'))
    .option('--text-color <textColor>', z.string().describe('Text color (hex, e.g. #ffffff)'))
    .action(async (name, options) => {
      const { client } = await getClient(options.account)

      const result = await client.createLabel({
        name,
        color: options.bgColor && options.textColor
          ? { backgroundColor: options.bgColor, textColor: options.textColor }
          : undefined,
      })

      out.printYaml(result)
      out.success(`Label created: "${result.name}"`)
    })

  // =========================================================================
  // label delete
  // =========================================================================

  cli
    .command('label delete <labelId>', 'Delete a label')
    .option('--force', 'Skip confirmation')
    .action(async (labelId, options) => {
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

      const { client } = await getClient(options.account)
      await client.deleteLabel({ labelId })

      out.printYaml({ label_id: labelId, deleted: true })
    })

  // =========================================================================
  // label counts
  // =========================================================================

  cli
    .command('label counts', 'Show unread counts per label')
    .action(async (options) => {
      const clients = await getClients(options.account)

      // Fetch from all accounts concurrently, tolerating individual failures
      const settled = await Promise.allSettled(
        clients.map(async ({ email, client }) => {
          const { parsed: counts } = await client.getLabelCounts()
          return { email, counts }
        }),
      )

      const allResults = settled
        .filter((r): r is PromiseFulfilledResult<{ email: string; counts: Array<{ label: string; count: number }> }> => {
          if (r.status === 'rejected') {
            out.error(`Failed to fetch counts: ${r.reason}`)
            return false
          }
          return true
        })
        .map((r) => r.value)

      // Merge counts from all accounts
      const merged = allResults.flatMap(({ email, counts }) =>
        counts.map((c) => ({ ...c, account: email })),
      )

      // Filter to labels with counts > 0 and sort descending
      const withCounts = merged.filter((c) => c.count > 0).sort((a, b) => b.count - a.count)

      if (withCounts.length === 0) {
        out.hint('All clear — no unread messages')
        return
      }

      const showAccount = clients.length > 1
      out.printList(
        withCounts.map((c) => ({
          ...(showAccount ? { account: c.account } : {}),
          label: c.label,
          count: c.count,
        })),
      )
    })
}

// Profile command: show account info.
// Displays email address, message/thread counts, and aliases as YAML.
// Cache is handled by the client — commands just call methods and use data.
// Multi-account: shows all accounts or filtered by --account.

import type { Goke } from 'goke'
import { getClients } from '../auth.js'
import * as out from '../output.js'

export function registerProfileCommands(cli: Goke) {
  cli
    .command('profile', 'Show Gmail account info')
    .action(async (options) => {
      const clients = await getClients(options.account)

      // Fetch all accounts concurrently, tolerating individual failures
      const settled = await Promise.allSettled(
        clients.map(async ({ client }) => {
          const profile = await client.getProfile()
          // Always fetch aliases fresh
          const aliases = await client.getEmailAliases()
          return { profile, aliases }
        }),
      )

      const results = settled
        .filter((r): r is PromiseFulfilledResult<{ profile: Awaited<ReturnType<typeof import('../gmail-client.js').GmailClient.prototype.getProfile>>; aliases: Awaited<ReturnType<typeof import('../gmail-client.js').GmailClient.prototype.getEmailAliases>> }> => {
          if (r.status === 'rejected') {
            out.error(`Failed to fetch profile: ${r.reason}`)
            return false
          }
          return true
        })
        .map((r) => r.value)

      for (const { profile, aliases } of results) {
        out.printYaml({
          email: profile.emailAddress,
          messages_total: profile.messagesTotal,
          threads_total: profile.threadsTotal,
          history_id: profile.historyId,
          aliases: aliases.map((a) => ({
            email: a.email,
            name: a.name ?? null,
            primary: a.primary,
          })),
        })
      }
    })
}

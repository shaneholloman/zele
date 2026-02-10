// Profile command: show account info.
// Displays email address, message/thread counts, and aliases as YAML.
// Cache is handled by the client — commands just call methods and use data.
// Multi-account: shows all accounts or filtered by --account.

import type { Goke } from 'goke'
import { getClients } from '../auth.js'
import { AuthError } from '../api-utils.js'
import * as out from '../output.js'

export function registerProfileCommands(cli: Goke) {
  cli
    .command('profile', 'Show Gmail account info')
    .action(async (options) => {
      const clients = await getClients(options.account)

      // Fetch all accounts concurrently
      const allResults = await Promise.all(
        clients.map(async ({ client }) => {
          const profile = await client.getProfile()
          if (profile instanceof Error) return profile
          // Always fetch aliases fresh
          const aliases = await client.getEmailAliases()
          if (aliases instanceof Error) return aliases
          return { profile, aliases }
        }),
      )

      const results = allResults.filter((r): r is Exclude<typeof r, Error> => {
          if (r instanceof AuthError) { out.error(`${r.message}. Try: zele login`); return false }
          if (r instanceof Error) { out.error(`Failed to fetch profile: ${r.message}`); return false }
          return true
        })

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

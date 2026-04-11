// Mail action commands: star, unstar, archive, trash, untrash, mark read/unread,
// spam, unspam, label modify, unsubscribe.
// Bulk operations on threads — cache invalidation is handled by the client methods.

import type { ZeleCli } from '../cli-types.js'
import { z } from 'zod'
import * as errore from 'errore'
import { getClient } from '../auth.js'
import type { GmailClient, ParsedMessage } from '../gmail-client.js'
import type { ImapSmtpClient } from '../imap-smtp-client.js'
import { UnsubscribeUnavailableError, UnsubscribeFailedError } from '../api-utils.js'
import {
  planUnsubscribe,
  type UnsubscribeMechanism,
  type UnsubscribePlan,
} from '../unsubscribe.js'
import * as out from '../output.js'
import { handleCommandError } from '../output.js'

// ---------------------------------------------------------------------------
// Helper: run a bulk action
// ---------------------------------------------------------------------------

async function bulkAction(
  threadIds: string[],
  actionName: string,
  accountFilter: string[] | undefined,
  fn: (client: GmailClient | ImapSmtpClient, ids: string[]) => Promise<void | Error>,
) {
  if (threadIds.length === 0) {
    out.error('No thread IDs provided')
    process.exit(1)
  }

  const { client } = await getClient(accountFilter)
  const result = await fn(client, threadIds)
  if (result instanceof Error) handleCommandError(result)

  out.printYaml({ action: actionName, thread_ids: threadIds, success: true })
}

// ---------------------------------------------------------------------------
// Register commands
// ---------------------------------------------------------------------------

export function registerMailActionCommands(cli: ZeleCli) {
  cli
    .command('mail star [...threadIds]', 'Star threads')
    .action(async (threadIds, options) => {
      await bulkAction(threadIds, 'Starred', options.account, (c, ids) => c.star({ threadIds: ids }))
    })

  cli
    .command('mail unstar [...threadIds]', 'Remove star from threads')
    .action(async (threadIds, options) => {
      await bulkAction(threadIds, 'Unstarred', options.account, (c, ids) => c.unstar({ threadIds: ids }))
    })

  cli
    .command('mail archive [...threadIds]', 'Archive threads (remove from inbox)')
    .action(async (threadIds, options) => {
      await bulkAction(threadIds, 'Archived', options.account, (c, ids) => c.archive({ threadIds: ids }))
    })

  cli
    .command('mail trash <threadId>', 'Move thread to trash')
    .action(async (threadId, options) => {
      await bulkAction([threadId], 'Trashed', options.account, (c, ids) => c.trash({ threadId: ids[0]! }))
    })

  cli
    .command('mail untrash <threadId>', 'Remove thread from trash')
    .action(async (threadId, options) => {
      await bulkAction([threadId], 'Untrashed', options.account, (c, ids) => c.untrash({ threadId: ids[0]! }))
    })

  cli
    .command('mail read-mark [...threadIds]', 'Mark threads as read (removes UNREAD label)')
    .action(async (threadIds, options) => {
      await bulkAction(threadIds, 'Marked as read', options.account, (c, ids) => c.markAsRead({ threadIds: ids }))
    })

  cli
    .command('mail unread-mark [...threadIds]', 'Mark threads as unread')
    .action(async (threadIds, options) => {
      await bulkAction(threadIds, 'Marked as unread', options.account, (c, ids) => c.markAsUnread({ threadIds: ids }))
    })

  cli
    .command('mail spam [...threadIds]', 'Mark threads as spam')
    .action(async (threadIds, options) => {
      await bulkAction(threadIds, 'Marked as spam', options.account, (c, ids) => c.markAsSpam({ threadIds: ids }))
    })

  cli
    .command('mail unspam [...threadIds]', 'Remove threads from spam')
    .action(async (threadIds, options) => {
      await bulkAction(threadIds, 'Removed from spam', options.account, (c, ids) => c.unmarkSpam({ threadIds: ids }))
    })

  cli
    .command('mail label [...threadIds]', 'Add or remove labels from threads')
    .option('--add <add>', z.string().describe('Labels to add (comma-separated)'))
    .option('--remove <remove>', z.string().describe('Labels to remove (comma-separated)'))
    .action(async (threadIds, options) => {
      if (!options.add && !options.remove) {
        out.error('At least one of --add or --remove is required')
        process.exit(1)
      }

      const addLabels = options.add?.split(',').map((l: string) => l.trim()).filter(Boolean) ?? []
      const removeLabels = options.remove?.split(',').map((l: string) => l.trim()).filter(Boolean) ?? []

      await bulkAction(
        threadIds,
        'Labels modified',
        options.account,
        (c, ids) => c.modifyLabels({ threadIds: ids, addLabelIds: addLabels, removeLabelIds: removeLabels }),
      )
    })

  cli
    .command('mail trash-spam', 'Trash all spam threads')
    .action(async (options) => {
      const { client } = await getClient(options.account)
      const result = await client.trashAllSpam()
      if (result instanceof Error) handleCommandError(result)

      out.printYaml(result)
      out.success(`Trashed ${result.count} spam thread(s)`)
    })

  // =========================================================================
  // mail unsubscribe — RFC 2369 + RFC 8058
  // =========================================================================
  //
  // Reads List-Unsubscribe and List-Unsubscribe-Post from the latest non-draft
  // message in a thread, then picks a mechanism:
  //   1. RFC 8058 one-click (HTTPS POST with `List-Unsubscribe=One-Click`)
  //   2. RFC 2369 mailto: (send the canonical unsubscribe email)
  //   3. RFC 2369 http(s): landing page (manual — print URL only)
  //
  // The decision logic lives in ../unsubscribe.ts so it can be unit-tested
  // with inline snapshots. This command is the thin executor: fetch thread,
  // build plan, optionally dry-run, otherwise perform the chosen mechanism.

  cli
    .command('mail unsubscribe <threadId>', 'Unsubscribe from a mailing list thread (RFC 2369 / RFC 8058)')
    .option('--via <via>', z.enum(['auto', 'one-click', 'mailto', 'url']).describe(
      'Mechanism to use (default: auto — prefers one-click, then mailto, then url)',
    ))
    .option('--dry-run', 'Print the unsubscribe plan without executing anything')
    .option('--require-dkim', 'Refuse one-click unless the message has DKIM=pass (Gmail only)')
    .option('--then <then>', z.enum(['nothing', 'archive', 'trash']).describe(
      'Follow-up action on the thread after unsubscribing (default: nothing)',
    ))
    .action(async (threadId, options) => {
      const via = options.via ?? 'auto'
      const then = options.then ?? 'nothing'

      const { client } = await getClient(options.account)
      const { parsed: thread } = await client.getThread({ threadId })

      const nonDraft = thread.messages.filter((m) => !m.isDraft)
      const latest: ParsedMessage | undefined = nonDraft[nonDraft.length - 1] ?? thread.messages[thread.messages.length - 1]
      if (!latest) {
        handleCommandError(new UnsubscribeUnavailableError({ threadId }))
      }

      const dkimAuthentic: boolean | null = latest.auth ? latest.auth.authentic : null
      const plan = planUnsubscribe({
        listUnsubscribe: latest.listUnsubscribe,
        listUnsubscribePost: latest.listUnsubscribePost,
        dkimAuthentic,
      })

      if (plan.mechanisms.length === 0) {
        handleCommandError(new UnsubscribeUnavailableError({ threadId }))
      }

      const chosen = pickMechanism(plan, via)
      if (chosen instanceof Error) handleCommandError(chosen)

      if (options.requireDkim && chosen.kind === 'one-click' && dkimAuthentic !== true) {
        handleCommandError(
          new UnsubscribeFailedError({
            mechanism: 'one-click',
            reason:
              dkimAuthentic === false
                ? 'DKIM did not pass and --require-dkim was set'
                : 'DKIM status unknown and --require-dkim was set',
          }),
        )
      }

      if (options.dryRun) {
        out.printYaml({
          action: 'Unsubscribe (dry-run)',
          thread_id: threadId,
          chosen: describeMechanism(chosen),
          plan: describePlan(plan),
        })
        return
      }

      // Execute the chosen mechanism.
      if (chosen.kind === 'one-click') {
        const res = await oneClickPost(chosen.url)
        if (res instanceof Error) handleCommandError(res)
      } else if (chosen.kind === 'mailto') {
        const sendResult = await client.sendMessage({
          to: [{ email: chosen.mailto.to }],
          subject: chosen.mailto.subject ?? 'unsubscribe',
          body: chosen.mailto.body ?? 'unsubscribe',
          cc: chosen.mailto.cc?.map((email) => ({ email })),
        })
        if (sendResult instanceof Error) {
          handleCommandError(
            new UnsubscribeFailedError({
              mechanism: 'mailto',
              reason: sendResult.message,
              cause: sendResult,
            }),
          )
        }
      } else {
        // url: cannot be executed programmatically — surface the URL and exit
        // without marking success (nothing was actually done).
        out.printYaml({
          action: 'Unsubscribe (manual required)',
          thread_id: threadId,
          url: chosen.url,
          note: 'Only a landing-page URL is available. Open it in a browser to complete unsubscription.',
          plan: describePlan(plan),
        })
        out.hint('Open the printed URL in a browser to finish unsubscribing.')
        return
      }

      // Optional follow-up action on the thread.
      if (then === 'archive') {
        const r = await client.archive({ threadIds: [threadId] })
        if (r instanceof Error) handleCommandError(r)
      } else if (then === 'trash') {
        const r = await client.trash({ threadId })
        if (r instanceof Error) handleCommandError(r)
      }

      out.printYaml({
        action: 'Unsubscribed',
        thread_id: threadId,
        mechanism: describeMechanism(chosen),
        then,
        plan: describePlan(plan),
      })
      out.success(`Unsubscribed via ${chosen.kind}`)
    })
}

// ---------------------------------------------------------------------------
// Unsubscribe helpers
// ---------------------------------------------------------------------------

/** Pick a mechanism from a plan based on the --via flag. */
function pickMechanism(
  plan: UnsubscribePlan,
  via: 'auto' | 'one-click' | 'mailto' | 'url',
): UnsubscribeMechanism | UnsubscribeFailedError {
  if (via === 'auto') {
    const first = plan.mechanisms[0]
    if (!first) {
      return new UnsubscribeFailedError({ mechanism: 'auto', reason: 'no mechanisms available' })
    }
    return first
  }
  const match = plan.mechanisms.find((m) => m.kind === via)
  if (match) return match
  return new UnsubscribeFailedError({
    mechanism: via,
    reason: `no ${via} mechanism advertised by the sender`,
  })
}

/** Build an RFC 8058 one-click POST request and validate the response.
 *  Returns void on success, UnsubscribeFailedError on any failure. */
async function oneClickPost(url: string): Promise<void | UnsubscribeFailedError> {
  // RFC 8058 §3.1: senders MUST NOT return redirects, so we refuse to follow.
  // `redirect: 'manual'` lets us see 3xx status codes instead of auto-following.
  const res = await errore.tryAsync({
    try: () =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
        redirect: 'manual',
      }),
    catch: (err) =>
      new UnsubscribeFailedError({
        mechanism: 'one-click',
        reason: String(err),
        cause: err,
      }),
  })
  if (res instanceof Error) return res

  if (res.status >= 200 && res.status < 300) return undefined
  if (res.status >= 300 && res.status < 400) {
    return new UnsubscribeFailedError({
      mechanism: 'one-click',
      reason: `HTTP ${res.status} redirect (RFC 8058 §3.1 forbids redirects from one-click endpoints)`,
    })
  }
  return new UnsubscribeFailedError({
    mechanism: 'one-click',
    reason: `HTTP ${res.status} ${res.statusText}`,
  })
}

/** YAML-friendly representation of a mechanism for output. */
function describeMechanism(m: UnsubscribeMechanism): Record<string, unknown> {
  if (m.kind === 'one-click') return { kind: 'one-click', url: m.url }
  if (m.kind === 'url') return { kind: 'url', url: m.url }
  return {
    kind: 'mailto',
    to: m.mailto.to,
    ...(m.mailto.subject ? { subject: m.mailto.subject } : {}),
    ...(m.mailto.body ? { body: m.mailto.body } : {}),
    ...(m.mailto.cc && m.mailto.cc.length > 0 ? { cc: m.mailto.cc } : {}),
  }
}

/** YAML-friendly representation of a full plan. */
function describePlan(plan: UnsubscribePlan): Record<string, unknown> {
  return {
    mechanisms: plan.mechanisms.map(describeMechanism),
    has_one_click: plan.hasOneClick,
    dkim_authentic: plan.dkimAuthentic,
    ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
  }
}

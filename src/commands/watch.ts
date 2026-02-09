// Mail watch command: poll for new emails using Gmail History API.
// Uses incremental historyId-based sync — each tick fetches only changes
// since the last known historyId, not the full inbox. On a quiet inbox
// this is a single API call returning nothing.
// Multi-account: watches all accounts concurrently and merges output.

import type { Goke } from 'goke'
import { z } from 'zod'
import { getClients } from '../auth.js'
import type { GmailClient } from '../gmail-client.js'
import { mapConcurrent } from '../api-utils.js'
import * as cache from '../gmail-cache.js'
import * as out from '../output.js'

// ---------------------------------------------------------------------------
// Folder label mapping (reuses mail list conventions)
// ---------------------------------------------------------------------------

const FOLDER_LABELS: Record<string, string> = {
  inbox: 'INBOX',
  sent: 'SENT',
  trash: 'TRASH',
  spam: 'SPAM',
  starred: 'STARRED',
  drafts: 'DRAFT',
}

// ---------------------------------------------------------------------------
// Register commands
// ---------------------------------------------------------------------------

export function registerWatchCommands(cli: Goke) {
  cli
    .command('mail watch', 'Watch for new emails (poll via History API)')
    .option('--interval [interval]', z.string().describe('Poll interval in seconds (default: 15)'))
    .option('--folder [folder]', z.string().describe('Folder to watch (default: inbox)'))
    .option('--query [query]', z.string().describe('Filter messages client-side using Gmail search operators (from:, to:, subject:, is:unread, has:attachment, etc). See https://support.google.com/mail/answer/7190'))
    .option('--once', z.boolean().describe('Print changes once and exit (no loop)'))
    .action(async (options) => {
      const interval = options.interval ? Number(options.interval) : 15
      if (isNaN(interval) || interval < 1) {
        out.error('--interval must be a positive number of seconds')
        process.exit(1)
      }

      const folder = options.folder ?? 'inbox'
      const filterLabelId = FOLDER_LABELS[folder]

      if (!filterLabelId) {
        out.error(`Unsupported folder for watch: "${folder}". Supported: ${Object.keys(FOLDER_LABELS).join(', ')}`)
        process.exit(1)
      }

      const clients = await getClients(options.account)

      // Seed historyId for each account
      const states = await Promise.all(
        clients.map(async ({ email, client }) => {
          let historyId = await cache.getLastHistoryId(email)

          if (!historyId) {
            const profile = await client.getProfile()
            historyId = profile.historyId
            await cache.setLastHistoryId(email, historyId)
            out.hint(`${email}: watching from now (historyId ${historyId})`)
          } else {
            out.hint(`${email}: resuming from historyId ${historyId}`)
          }

          return { email, client, historyId }
        }),
      )

      // Clean exit on SIGINT
      let running = true
      process.on('SIGINT', () => {
        running = false
        out.hint('Stopped watching')
        process.exit(0)
      })

      out.hint(`Polling every ${interval}s for ${folder} changes (Ctrl+C to stop)`)

      // Poll loop
      while (running) {
        const settled = await Promise.allSettled(
          states.map(async (state) => {
            try {
              return await pollAccount(state, filterLabelId, options.query)
            } catch (err: any) {
              // historyId expired — Google only keeps ~7 days
              if (isHistoryExpired(err)) {
                out.hint(`${state.email}: history expired, re-seeding...`)
                const profile = await state.client.getProfile()
                state.historyId = profile.historyId
                await cache.setLastHistoryId(state.email, state.historyId)
                // Retry once after reseed (important for --once mode)
                return await pollAccount(state, filterLabelId, options.query)
              }
              throw err
            }
          }),
        )

        const allItems: Array<Record<string, unknown>> = []
        for (const result of settled) {
          if (result.status === 'fulfilled' && result.value) {
            allItems.push(...result.value)
          } else if (result.status === 'rejected') {
            out.error(`${result.reason?.message ?? result.reason}`)
          }
        }

        if (allItems.length > 0) {
          out.printList(allItems)
        }

        if (options.once) break

        await sleep(interval * 1000)
      }
    })
}

// ---------------------------------------------------------------------------
// Poll a single account for changes
// ---------------------------------------------------------------------------

async function pollAccount(
  state: { email: string; client: GmailClient; historyId: string },
  filterLabelId: string,
  query: string | undefined,
): Promise<Array<Record<string, unknown>>> {
  const { history, historyId: newHistoryId } = await state.client.listHistory({
    startHistoryId: state.historyId,
    labelId: filterLabelId,
    historyTypes: ['messageAdded'],
  })

  // Update stored historyId even if no changes
  if (newHistoryId !== state.historyId) {
    state.historyId = newHistoryId
    await cache.setLastHistoryId(state.email, newHistoryId)
  }

  if (history.length === 0) return []

  // Collect unique message IDs from messageAdded events.
  // No client-side label filtering here — listHistory already filters by
  // labelId server-side, and the partial message objects in history responses
  // often have incomplete/missing labelIds.
  const seenIds = new Set<string>()
  const messageIds: string[] = []

  for (const entry of history) {
    for (const added of entry.messagesAdded ?? []) {
      const id = added.message?.id
      if (id && !seenIds.has(id)) {
        seenIds.add(id)
        messageIds.push(id)
      }
    }
  }

  if (messageIds.length === 0) return []

  // Hydrate messages with metadata (bounded concurrency)
  const hydrated = await mapConcurrent(messageIds, async (msgId) => {
    try {
      const msg = await state.client.getMessage({ messageId: msgId, format: 'metadata' })
      if ('raw' in msg) return null

      // If user specified a query, do a client-side check on subject/from
      // (the history API doesn't support query filtering natively)
      if (query && !matchesQuery(msg, query)) return null

      return {
        account: state.email,
        type: 'new_message',
        from: out.formatSender(msg.from),
        subject: msg.subject,
        date: out.formatDate(msg.date),
        thread_id: msg.threadId,
        message_id: msg.id,
        flags: out.formatFlags(msg),
      }
    } catch (err: any) {
      const status = err?.code ?? err?.status ?? err?.response?.status
      if (status === 404) return null // message deleted between history fetch and hydration
      out.hint(`Failed to fetch message ${msgId}: ${err.message ?? err}`)
      return null
    }
  })

  return hydrated.filter((item) => item !== null)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isHistoryExpired(err: any): boolean {
  const status = err?.code ?? err?.status ?? err?.response?.status
  if (status === 404) return true
  // Google sometimes returns 400 with "Invalid historyId"
  if (status === 400) {
    const message = err?.message ?? err?.response?.data?.error?.message ?? ''
    if (message.includes('historyId')) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Client-side Gmail query matching
// ---------------------------------------------------------------------------
// The History API doesn't support server-side query filtering, so we parse
// common Gmail search operators and match against message metadata.
// Supported operators: from:, to:, cc:, subject:, is:unread, is:starred,
// has:attachment, label:, and plain text (matches subject + from).
// Multiple terms are AND-ed together. Quoted phrases are supported.
// See https://support.google.com/mail/answer/7190 for the full Gmail spec.
// ---------------------------------------------------------------------------

interface MatchableMessage {
  subject: string
  from: { name?: string; email: string }
  to: Array<{ name?: string; email: string }>
  cc: Array<{ name?: string; email: string }> | null
  labelIds: string[]
  unread: boolean
  starred: boolean
  attachments: Array<{ filename: string }>
}

function matchesQuery(msg: MatchableMessage, query: string): boolean {
  const terms = parseQueryTerms(query)
  return terms.every((term) => matchesTerm(msg, term))
}

interface QueryTerm {
  operator: string | null // null = plain text, otherwise from/to/cc/subject/is/has/label
  value: string
  negated: boolean
}

function parseQueryTerms(query: string): QueryTerm[] {
  const terms: QueryTerm[] = []
  // Match: optional -, optional operator:, then either "quoted phrase" or non-space word
  const regex = /(-?)(?:(from|to|cc|subject|is|has|label):)?(?:"([^"]*)"|([\S]+))/gi
  let match: RegExpExecArray | null

  while ((match = regex.exec(query)) !== null) {
    const negated = match[1] === '-'
    const operator = match[2]?.toLowerCase() ?? null
    const value = (match[3] ?? match[4] ?? '').toLowerCase()
    if (value) terms.push({ operator, value, negated })
  }

  return terms
}

function senderMatches(sender: { name?: string; email: string }, value: string): boolean {
  const full = `${sender.name ?? ''} ${sender.email}`.toLowerCase()
  return full.includes(value)
}

function matchesTerm(msg: MatchableMessage, term: QueryTerm): boolean {
  let result: boolean

  switch (term.operator) {
    case 'from':
      result = senderMatches(msg.from, term.value)
      break
    case 'to':
      result = msg.to.some((r) => senderMatches(r, term.value))
      break
    case 'cc':
      result = (msg.cc ?? []).some((r) => senderMatches(r, term.value))
      break
    case 'subject':
      result = msg.subject.toLowerCase().includes(term.value)
      break
    case 'is':
      if (term.value === 'unread') result = msg.unread
      else if (term.value === 'read') result = !msg.unread
      else if (term.value === 'starred') result = msg.starred
      else result = false
      break
    case 'has':
      if (term.value === 'attachment') result = msg.attachments.length > 0
      else result = false
      break
    case 'label':
      result = msg.labelIds.some((l) => l.toLowerCase() === term.value || l.toLowerCase().replace('/', '-') === term.value)
      break
    default: {
      // Plain text: match against subject + from
      const subject = msg.subject.toLowerCase()
      const from = `${msg.from.name ?? ''} ${msg.from.email}`.toLowerCase()
      result = subject.includes(term.value) || from.includes(term.value)
      break
    }
  }

  return term.negated ? !result : result
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

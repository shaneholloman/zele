// Mail commands: list, search, read, send, reply, forward.
// Core email operations wrapping GmailClient with cache-first reads
// and cli-table3 output for list views.

import type { Goke } from 'goke'
import { z } from 'zod'
import fs from 'node:fs'
import { authenticate } from '../auth.js'
import { GmailClient, type ThreadData, type ThreadListResult } from '../gmail-client.js'
import { GmailCache } from '../gmail-cache.js'
import * as out from '../output.js'
import pc from 'picocolors'

// ---------------------------------------------------------------------------
// Shared: get authenticated client + cache
// ---------------------------------------------------------------------------

async function getClientAndCache(noCache: boolean) {
  const auth = await authenticate()
  const client = new GmailClient({ auth })
  const cache = noCache ? null : new GmailCache()
  return { client, cache }
}

// ---------------------------------------------------------------------------
// Register commands
// ---------------------------------------------------------------------------

export function registerMailCommands(cli: Goke) {
  // =========================================================================
  // mail list
  // =========================================================================

  cli
    .command('mail list', 'List email threads')
    .option('--folder [folder]', 'Folder to list (inbox, sent, trash, spam, starred, drafts, archive, all) (default: inbox)')
    .option('--max [max]', 'Max results per page (default: 20)')
    .option('--page <page>', 'Pagination token')
    .option('--label <label>', 'Filter by label name')
    .option('--json', 'Output as JSON')
    .option('--no-cache', 'Skip cache')
    .action(async (options: {
      folder?: string
      max?: string
      page?: string
      label?: string
      json?: boolean
      noCache?: boolean
    }) => {
      const folder = options.folder ?? 'inbox'
      const max = options.max ? Number(options.max) : 20
      const { client, cache } = await getClientAndCache(!!options.noCache)

      const cacheParams = {
        folder,
        labelIds: options.label ? [options.label] : undefined,
        pageToken: options.page,
      }

      // Cache-first read
      let result = cache?.getCachedThreadList<ThreadListResult>(cacheParams)
      if (!result) {
        result = await client.listThreads({
          folder,
          maxResults: max,
          labelIds: options.label ? [options.label] : undefined,
          pageToken: options.page,
        })
        cache?.cacheThreadList(cacheParams, result)
      }

      cache?.close()

      if (options.json) {
        out.printJson(result)
        return
      }

      if (result.threads.length === 0) {
        out.hint('No threads found')
        return
      }

      out.printTable({
        head: ['!', 'From', 'Subject', 'Date', 'Msgs'],
        rows: result.threads.map((t) => [
          out.formatFlags(t),
          out.truncate(out.formatSender(t.from), 25),
          out.truncate(t.subject, 45),
          out.formatDate(t.date),
          t.messageCount,
        ]),
      })

      out.hint(`${result.threads.length} threads (${folder})`)
      out.printNextPageHint(result.nextPageToken)
    })

  // =========================================================================
  // mail search
  // =========================================================================

  cli
    .command('mail search <query>', 'Search email threads')
    .option('--max [max]', 'Max results (default: 20)')
    .option('--page <page>', 'Pagination token')
    .option('--json', 'Output as JSON')
    .action(async (query: string, options: {
      max?: string
      page?: string
      json?: boolean
    }) => {
      const max = options.max ? Number(options.max) : 20
      const auth = await authenticate()
      const client = new GmailClient({ auth })

      const result = await client.listThreads({
        query,
        maxResults: max,
        pageToken: options.page,
      })

      if (options.json) {
        out.printJson(result)
        return
      }

      if (result.threads.length === 0) {
        out.hint(`No results for "${query}"`)
        return
      }

      out.printTable({
        head: ['!', 'From', 'Subject', 'Date', 'Msgs'],
        rows: result.threads.map((t) => [
          out.formatFlags(t),
          out.truncate(out.formatSender(t.from), 25),
          out.truncate(t.subject, 45),
          out.formatDate(t.date),
          t.messageCount,
        ]),
      })

      out.hint(`${result.threads.length} results for "${query}"`)
      out.printNextPageHint(result.nextPageToken)
    })

  // =========================================================================
  // mail read
  // =========================================================================

  cli
    .command('mail read <threadId>', 'Read a full email thread')
    .option('--raw', 'Show raw message (first message only)')
    .option('--json', 'Output as JSON')
    .option('--no-cache', 'Skip cache')
    .action(async (threadId: string, options: {
      raw?: boolean
      json?: boolean
      noCache?: boolean
    }) => {
      const { client, cache } = await getClientAndCache(!!options.noCache)

      if (options.raw) {
        // Get first message raw
        const thread = await client.getThread({ threadId })
        if (thread.messages.length === 0) {
          out.hint('No messages in thread')
          cache?.close()
          return
        }
        const rawMsg = await client.getRawMessage({ messageId: thread.messages[0]!.id })
        process.stdout.write(rawMsg + '\n')
        cache?.close()
        return
      }

      // Cache-first read
      let thread = cache?.getCachedThread<ThreadData>(threadId)
      if (!thread) {
        thread = await client.getThread({ threadId })
        cache?.cacheThread(threadId, thread)
      }

      cache?.close()

      if (options.json) {
        out.printJson(thread)
        return
      }

      if (thread.messages.length === 0) {
        out.hint('No messages in thread')
        return
      }

      // Render thread header
      process.stdout.write(pc.bold(thread.subject) + '\n')
      process.stdout.write(pc.dim(`Thread ID: ${thread.id} | ${thread.messageCount} message(s)`) + '\n')
      process.stdout.write(pc.dim('─'.repeat(60)) + '\n\n')

      // Render each message
      for (const msg of thread.messages) {
        const fromStr = out.formatSenderFull(msg.from)
        const dateStr = out.formatDate(msg.date)
        const flags = out.formatFlags(msg)

        process.stdout.write(pc.bold(fromStr) + (flags ? ` ${flags}` : '') + '\n')
        process.stdout.write(pc.dim(`To: ${msg.to.map((t) => t.email).join(', ')}`) + '\n')
        if (msg.cc && msg.cc.length > 0) {
          process.stdout.write(pc.dim(`Cc: ${msg.cc.map((c) => c.email).join(', ')}`) + '\n')
        }
        process.stdout.write(pc.dim(`Date: ${dateStr} | ID: ${msg.id}`) + '\n')

        if (msg.attachments.length > 0) {
          process.stdout.write(pc.dim(`Attachments: ${msg.attachments.map((a) => a.filename).join(', ')}`) + '\n')
        }

        process.stdout.write('\n')

        // Render body as markdown if HTML
        const body = out.renderEmailBody(msg.body, msg.mimeType)
        process.stdout.write(body + '\n')
        process.stdout.write('\n' + pc.dim('─'.repeat(60)) + '\n\n')
      }
    })

  // =========================================================================
  // mail send
  // =========================================================================

  cli
    .command('mail send', 'Send an email')
    .option('--to <to>', z.string().describe('Recipient email (repeatable with comma)'))
    .option('--subject <subject>', z.string().describe('Email subject'))
    .option('--body <body>', z.string().describe('Email body text'))
    .option('--body-file <bodyFile>', z.string().describe('Read body from file (use - for stdin)'))
    .option('--cc <cc>', z.string().describe('CC recipients (comma-separated)'))
    .option('--bcc <bcc>', z.string().describe('BCC recipients (comma-separated)'))
    .option('--from <from>', z.string().describe('Send-as alias email'))
    .option('--json', 'Output as JSON')
    .action(async (options: {
      to?: string
      subject?: string
      body?: string
      bodyFile?: string
      cc?: string
      bcc?: string
      from?: string
      json?: boolean
    }) => {
      if (!options.to) {
        out.error('--to is required')
        process.exit(1)
      }
      if (!options.subject) {
        out.error('--subject is required')
        process.exit(1)
      }

      // Resolve body
      let body = options.body ?? ''
      if (options.bodyFile) {
        if (options.bodyFile === '-') {
          // Read from stdin
          const chunks: Buffer[] = []
          for await (const chunk of process.stdin) {
            chunks.push(chunk)
          }
          body = Buffer.concat(chunks).toString('utf-8')
        } else {
          body = fs.readFileSync(options.bodyFile, 'utf-8')
        }
      }

      if (!body) {
        out.error('--body or --body-file is required')
        process.exit(1)
      }

      const parseEmails = (str: string) =>
        str.split(',').map((e) => e.trim()).filter(Boolean).map((email) => ({ email }))

      const auth = await authenticate()
      const client = new GmailClient({ auth })

      const result = await client.sendMessage({
        to: parseEmails(options.to),
        subject: options.subject,
        body,
        cc: options.cc ? parseEmails(options.cc) : undefined,
        bcc: options.bcc ? parseEmails(options.bcc) : undefined,
        fromEmail: options.from,
      })

      // Invalidate cache
      const cache = new GmailCache()
      cache.invalidateThreadLists()
      cache.close()

      if (options.json) {
        out.printJson(result)
        return
      }

      out.success(`Sent to ${options.to} (ID: ${result.id})`)
    })

  // =========================================================================
  // mail reply
  // =========================================================================

  cli
    .command('mail reply <threadId>', 'Reply to an email thread')
    .option('--body <body>', z.string().describe('Reply body text'))
    .option('--body-file <bodyFile>', z.string().describe('Read body from file (use - for stdin)'))
    .option('--cc <cc>', z.string().describe('Additional CC recipients'))
    .option('--all', 'Reply all (include all original recipients)')
    .option('--from <from>', z.string().describe('Send-as alias email'))
    .option('--json', 'Output as JSON')
    .action(async (threadId: string, options: {
      body?: string
      bodyFile?: string
      cc?: string
      all?: boolean
      from?: string
      json?: boolean
    }) => {
      const auth = await authenticate()
      const client = new GmailClient({ auth })

      // Fetch thread to get reply context
      const thread = await client.getThread({ threadId })
      if (thread.messages.length === 0) {
        out.error('No messages in thread')
        process.exit(1)
      }

      const lastMsg = thread.messages[thread.messages.length - 1]!

      // Resolve body
      let body = options.body ?? ''
      if (options.bodyFile) {
        if (options.bodyFile === '-') {
          const chunks: Buffer[] = []
          for await (const chunk of process.stdin) {
            chunks.push(chunk)
          }
          body = Buffer.concat(chunks).toString('utf-8')
        } else {
          body = fs.readFileSync(options.bodyFile, 'utf-8')
        }
      }

      if (!body) {
        out.error('--body or --body-file is required')
        process.exit(1)
      }

      // Build recipient list
      const replyTo = lastMsg.replyTo ?? lastMsg.from.email
      const to = [{ email: replyTo }]

      let cc: Array<{ email: string }> | undefined
      if (options.all) {
        // Reply-all: include original To and Cc, excluding sender
        const profile = await client.getProfile()
        const myEmail = profile.emailAddress.toLowerCase()

        const allRecipients = [
          ...lastMsg.to.map((r) => r.email),
          ...(lastMsg.cc?.map((r) => r.email) ?? []),
        ]
          .filter((email) => email.toLowerCase() !== myEmail)
          .filter((email) => email.toLowerCase() !== replyTo.toLowerCase())

        if (allRecipients.length > 0) {
          cc = allRecipients.map((email) => ({ email }))
        }
      }

      if (options.cc) {
        const extra = options.cc.split(',').map((e) => ({ email: e.trim() })).filter((e) => e.email)
        cc = [...(cc ?? []), ...extra]
      }

      // Build references chain
      const refs = [lastMsg.references, lastMsg.messageId].filter(Boolean).join(' ')

      const result = await client.sendMessage({
        to,
        subject: lastMsg.subject.startsWith('Re:') ? lastMsg.subject : `Re: ${lastMsg.subject}`,
        body,
        cc,
        threadId,
        inReplyTo: lastMsg.messageId,
        references: refs || undefined,
        fromEmail: options.from,
      })

      // Invalidate cache
      const cache = new GmailCache()
      cache.invalidateThread(threadId)
      cache.invalidateThreadLists()
      cache.close()

      if (options.json) {
        out.printJson(result)
        return
      }

      out.success(`Reply sent (ID: ${result.id})`)
    })

  // =========================================================================
  // mail forward
  // =========================================================================

  cli
    .command('mail forward <threadId>', 'Forward an email thread')
    .option('--to <to>', z.string().describe('Forward recipient(s), comma-separated'))
    .option('--body <body>', z.string().describe('Optional message to prepend'))
    .option('--from <from>', z.string().describe('Send-as alias email'))
    .option('--json', 'Output as JSON')
    .action(async (threadId: string, options: {
      to?: string
      body?: string
      from?: string
      json?: boolean
    }) => {
      if (!options.to) {
        out.error('--to is required')
        process.exit(1)
      }

      const auth = await authenticate()
      const client = new GmailClient({ auth })

      // Fetch thread to get the message to forward
      const thread = await client.getThread({ threadId })
      if (thread.messages.length === 0) {
        out.error('No messages in thread')
        process.exit(1)
      }

      const lastMsg = thread.messages[thread.messages.length - 1]!
      const forwardedBody = out.renderEmailBody(lastMsg.body, lastMsg.mimeType)

      const fullBody = [
        options.body ?? '',
        '',
        '---------- Forwarded message ----------',
        `From: ${out.formatSenderFull(lastMsg.from)}`,
        `Date: ${lastMsg.date}`,
        `Subject: ${lastMsg.subject}`,
        `To: ${lastMsg.to.map((t) => t.email).join(', ')}`,
        '',
        forwardedBody,
      ].join('\n')

      const recipients = options.to.split(',').map((e) => ({ email: e.trim() })).filter((e) => e.email)

      const result = await client.sendMessage({
        to: recipients,
        subject: `Fwd: ${lastMsg.subject}`,
        body: fullBody,
        fromEmail: options.from,
      })

      // Invalidate cache
      const cache = new GmailCache()
      cache.invalidateThreadLists()
      cache.close()

      if (options.json) {
        out.printJson(result)
        return
      }

      out.success(`Forwarded to ${options.to} (ID: ${result.id})`)
    })
}

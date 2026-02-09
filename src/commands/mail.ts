// Mail commands: list, search, read, send, reply, forward.
// Core email operations wrapping GmailClient with cache-first reads
// and YAML output for list views.
// Multi-account: list/search fetch all accounts concurrently and merge by date.

import type { Goke } from 'goke'
import { z } from 'zod'
import fs from 'node:fs'
import { getClients, getClient } from '../auth.js'
import { GmailClient, type ThreadData, type ThreadListResult } from '../gmail-client.js'
import * as cache from '../gmail-cache.js'
import * as out from '../output.js'
import pc from 'picocolors'

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
    .option('--no-cache', 'Skip cache')
    .action(async (options) => {
      const folder = options.folder ?? 'inbox'
      const max = options.max ? Number(options.max) : 20
      const clients = await getClients(options.account)

      if (options.page && clients.length > 1) {
        out.error('--page cannot be used with multiple accounts (page tokens are per-account)')
        process.exit(1)
      }

      const cacheParams = {
        folder,
        maxResults: max,
        labelIds: options.label ? [options.label] : undefined,
        pageToken: options.page,
      }

      // Fetch from all accounts concurrently, tolerating individual failures
      const settled = await Promise.allSettled(
        clients.map(async ({ email, client }) => {
          if (!options.noCache) {
            const cached = await cache.getCachedThreadList<ThreadListResult>(email, cacheParams)
            if (cached) {
              return { email, result: cached }
            }
          }

          const result = await client.listThreads({
            folder,
            maxResults: max,
            labelIds: options.label ? [options.label] : undefined,
            pageToken: options.page,
          })

          if (!options.noCache) {
            await cache.cacheThreadList(email, cacheParams, result)
          }

          return { email, result }
        }),
      )

      const allResults = settled
        .filter((r): r is PromiseFulfilledResult<{ email: string; result: ThreadListResult }> => {
          if (r.status === 'rejected') {
            out.error(`Failed to fetch: ${r.reason}`)
            return false
          }
          return true
        })
        .map((r) => r.value)

      // Merge threads from all accounts, sorted by date descending, capped at max
      const merged = allResults
        .flatMap(({ email, result }) =>
          result.threads.map((t) => ({ ...t, account: email })),
        )
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, max)

      if (merged.length === 0) {
        out.hint('No threads found')
        return
      }

      const showAccount = clients.length > 1
      out.printList(
        merged.map((t) => ({
          ...(showAccount ? { account: t.account } : {}),
          flags: out.formatFlags(t),
          from: out.formatSender(t.from),
          subject: t.subject,
          date: out.formatDate(t.date),
          messages: t.messageCount,
        })),
      )

      out.hint(`${merged.length} threads (${folder})`)
    })

  // =========================================================================
  // mail search
  // =========================================================================

  cli
    .command('mail search <query>', 'Search email threads using Gmail query syntax (from:, to:, subject:, has:attachment, etc). See https://support.google.com/mail/answer/7190')
    .option('--max [max]', 'Max results (default: 20)')
    .option('--page <page>', 'Pagination token')
    .action(async (query, options) => {
      const max = options.max ? Number(options.max) : 20
      const clients = await getClients(options.account)

      if (options.page && clients.length > 1) {
        out.error('--page cannot be used with multiple accounts (page tokens are per-account)')
        process.exit(1)
      }

      // Search all accounts concurrently, tolerating individual failures
      const settled = await Promise.allSettled(
        clients.map(async ({ email, client }) => {
          const result = await client.listThreads({
            query,
            maxResults: max,
            pageToken: options.page,
          })
          return { email, result }
        }),
      )

      const allResults = settled
        .filter((r): r is PromiseFulfilledResult<{ email: string; result: ThreadListResult }> => {
          if (r.status === 'rejected') {
            out.error(`Failed to search: ${r.reason}`)
            return false
          }
          return true
        })
        .map((r) => r.value)

      const merged = allResults
        .flatMap(({ email, result }) =>
          result.threads.map((t) => ({ ...t, account: email })),
        )
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, max)

      if (merged.length === 0) {
        out.hint(`No results for "${query}"`)
        return
      }

      const showAccount = clients.length > 1
      out.printList(
        merged.map((t) => ({
          ...(showAccount ? { account: t.account } : {}),
          flags: out.formatFlags(t),
          from: out.formatSender(t.from),
          subject: t.subject,
          date: out.formatDate(t.date),
          messages: t.messageCount,
        })),
      )

      out.hint(`${merged.length} results for "${query}"`)
    })

  // =========================================================================
  // mail read
  // =========================================================================

  cli
    .command('mail read <threadId>', 'Read a full email thread')
    .option('--raw', 'Show raw message (first message only)')
    .option('--no-cache', 'Skip cache')
    .action(async (threadId, options) => {
      const { email, client } = await getClient(options.account)

      if (options.raw) {
        const thread = await client.getThread({ threadId })
        if (thread.messages.length === 0) {
          out.hint('No messages in thread')
          return
        }
        const rawMsg = await client.getRawMessage({ messageId: thread.messages[0]!.id })
        process.stdout.write(rawMsg + '\n')
        return
      }

      // Cache-first read
      let thread: ThreadData | undefined
      if (!options.noCache) {
        thread = await cache.getCachedThread<ThreadData>(email, threadId)
      }
      if (!thread) {
        thread = await client.getThread({ threadId })
        if (!options.noCache) {
          await cache.cacheThread(email, threadId, thread)
        }
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
    .action(async (options) => {
      if (!options.to) {
        out.error('--to is required')
        process.exit(1)
      }
      if (!options.subject) {
        out.error('--subject is required')
        process.exit(1)
      }

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

      const parseEmails = (str: string) =>
        str.split(',').map((e) => e.trim()).filter(Boolean).map((email) => ({ email }))

      const { email, client } = await getClient(options.account)

      const result = await client.sendMessage({
        to: parseEmails(options.to),
        subject: options.subject,
        body,
        cc: options.cc ? parseEmails(options.cc) : undefined,
        bcc: options.bcc ? parseEmails(options.bcc) : undefined,
        fromEmail: options.from,
      })

      await cache.invalidateThreadLists(email)

      out.printYaml(result)
      out.success(`Sent to ${options.to}`)
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
    .action(async (threadId, options) => {
      const { email, client } = await getClient(options.account)

      const thread = await client.getThread({ threadId })
      if (thread.messages.length === 0) {
        out.error('No messages in thread')
        process.exit(1)
      }

      const lastMsg = thread.messages[thread.messages.length - 1]!

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

      const replyTo = lastMsg.replyTo ?? lastMsg.from.email
      const to = [{ email: replyTo }]

      let cc: Array<{ email: string }> | undefined
      if (options.all) {
        const profile = await client.getProfile()
        const myEmail = profile.emailAddress.toLowerCase()

        const allRecipients = [
          ...lastMsg.to.map((r) => r.email),
          ...(lastMsg.cc?.map((r) => r.email) ?? []),
        ]
          .filter((e) => e.toLowerCase() !== myEmail)
          .filter((e) => e.toLowerCase() !== replyTo.toLowerCase())

        if (allRecipients.length > 0) {
          cc = allRecipients.map((e) => ({ email: e }))
        }
      }

      if (options.cc) {
        const extra = options.cc
          .split(',')
          .map((e: string) => ({ email: e.trim() }))
          .filter((e: { email: string }) => e.email)
        cc = [...(cc ?? []), ...extra]
      }

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

      await cache.invalidateThread(email, threadId)
      await cache.invalidateThreadLists(email)

      out.printYaml(result)
      out.success('Reply sent')
    })

  // =========================================================================
  // mail forward
  // =========================================================================

  cli
    .command('mail forward <threadId>', 'Forward an email thread')
    .option('--to <to>', z.string().describe('Forward recipient(s), comma-separated'))
    .option('--body <body>', z.string().describe('Optional message to prepend'))
    .option('--from <from>', z.string().describe('Send-as alias email'))
    .action(async (threadId, options) => {
      if (!options.to) {
        out.error('--to is required')
        process.exit(1)
      }

      const { email, client } = await getClient(options.account)

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

      const recipients = options.to
        .split(',')
        .map((e: string) => ({ email: e.trim() }))
        .filter((e: { email: string }) => e.email)

      const result = await client.sendMessage({
        to: recipients,
        subject: `Fwd: ${lastMsg.subject}`,
        body: fullBody,
        fromEmail: options.from,
      })

      await cache.invalidateThreadLists(email)

      out.printYaml(result)
      out.success(`Forwarded to ${options.to}`)
    })
}

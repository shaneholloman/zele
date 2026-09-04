// Shared mail SDK used by the CLI and by apps that import `zele`.
// Commands stay thin: they print YAML. This module talks to Gmail/IMAP.

import { getClient, getClients, type ClientEntry } from './auth.js'
import type { ParsedMessage, ThreadData, ThreadListItem, ThreadListResult } from './gmail-client.js'
import { renderEmailBody, replyParser } from './output.js'

export const MAIL_FOLDERS = [
  'inbox',
  'sent',
  'starred',
  'drafts',
  'archive',
  'spam',
  'trash',
  'all',
] as const

export type MailFolder = (typeof MAIL_FOLDERS)[number]

export type ListedThread = ThreadListItem & { account: string }

export type ReadThread = ThreadData & { account: string }

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

async function loadClients(accounts?: string[]): Promise<ClientEntry[] | Error> {
  try {
    return await getClients(accounts)
  } catch (err) {
    return asError(err)
  }
}

async function loadClient(account?: string): Promise<ClientEntry | Error> {
  try {
    return await getClient(account ? [account] : undefined)
  } catch (err) {
    return asError(err)
  }
}

// One list per mailbox. Do not call this from search keystrokes.
export async function listMailThreads({
  accounts,
  folder = 'inbox',
  query,
  limit = 20,
  pageToken,
}: {
  accounts?: string[]
  folder?: string
  query?: string
  limit?: number
  pageToken?: string
} = {}): Promise<{ threads: ListedThread[]; nextPageToken: string | null } | Error> {
  const clients = await loadClients(accounts)
  if (clients instanceof Error) return clients

  if (pageToken && clients.length > 1) {
    return new Error('page tokens are per-account; pass a single account')
  }

  const results = await Promise.all(
    clients.map(async ({ email, client }) => {
      const result = await client.listThreads({
        folder,
        maxResults: limit,
        pageToken,
        query,
      })
      if (result instanceof Error) return result
      return { email, result }
    }),
  )

  const ok: Array<{ email: string; result: ThreadListResult }> = []
  const failed: Error[] = []
  for (const result of results) {
    if (result instanceof Error) failed.push(result)
    else ok.push(result)
  }
  if (ok.length === 0) return failed[0] ?? new Error('No threads found')

  const merged = ok
    .flatMap(({ email, result }) => result.threads.map((thread) => ({ ...thread, account: email })))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit)

  return {
    threads: merged,
    nextPageToken: ok.length === 1 ? ok[0]!.result.nextPageToken : null,
  }
}

export async function readMailThread({
  threadId,
  account,
  skipCache = false,
}: {
  threadId: string
  account?: string
  skipCache?: boolean
}): Promise<ReadThread | Error> {
  const entry = await loadClient(account)
  if (entry instanceof Error) return entry
  const result = await entry.client.getThread({ threadId, skipCache })
  if (result instanceof Error) return result
  return { ...result.parsed, account: entry.email }
}

export function messageToMarkdown(message: ParsedMessage): string {
  if (message.textBody) return replyParser.parseReply(message.textBody)
  return renderEmailBody(message.body, message.mimeType)
}

async function withClient<T>(
  account: string | undefined,
  fn: (entry: ClientEntry) => Promise<T | Error>,
): Promise<T | Error> {
  const entry = await loadClient(account)
  if (entry instanceof Error) return entry
  try {
    return await fn(entry)
  } catch (err) {
    return asError(err)
  }
}

export async function archiveMail({
  threadIds,
  account,
}: {
  threadIds: string[]
  account?: string
}): Promise<void | Error> {
  return withClient(account, (entry) => entry.client.archive({ threadIds }))
}

export async function starMail({
  threadIds,
  account,
}: {
  threadIds: string[]
  account?: string
}): Promise<void | Error> {
  return withClient(account, (entry) => entry.client.star({ threadIds }))
}

export async function unstarMail({
  threadIds,
  account,
}: {
  threadIds: string[]
  account?: string
}): Promise<void | Error> {
  return withClient(account, (entry) => entry.client.unstar({ threadIds }))
}

export async function trashMail({
  threadId,
  account,
}: {
  threadId: string
  account?: string
}): Promise<void | Error> {
  return withClient(account, (entry) => entry.client.trash({ threadId }))
}

export async function markMailRead({
  threadIds,
  account,
}: {
  threadIds: string[]
  account?: string
}): Promise<void | Error> {
  return withClient(account, (entry) => entry.client.markAsRead({ threadIds }))
}

export async function markMailUnread({
  threadIds,
  account,
}: {
  threadIds: string[]
  account?: string
}): Promise<void | Error> {
  return withClient(account, (entry) => entry.client.markAsUnread({ threadIds }))
}

export async function replyMail({
  threadId,
  account,
  body,
  to,
  seenMessageId,
}: {
  threadId: string
  account?: string
  body: string
  to?: Array<{ name?: string; email: string }>
  seenMessageId?: string | null
}): Promise<Error | Awaited<ReturnType<ClientEntry['client']['sendInThread']>>> {
  return withClient(account, (entry) =>
    entry.client.sendInThread({
      threadId,
      body,
      to,
      seenMessageId,
    }),
  )
}

export async function getMailAttachment({
  messageId,
  attachmentId,
  account,
}: {
  messageId: string
  attachmentId: string
  account?: string
}): Promise<string | Error> {
  return withClient(account, async (entry) => {
    const data = await entry.client.getAttachment({ messageId, attachmentId })
    if (data instanceof Error) return data
    return data
  })
}

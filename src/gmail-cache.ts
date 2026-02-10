// Prisma-based cache for Gmail API responses.
// Each cache entry is scoped to an (email, appId) pair. TTL-based expiry is
// checked at read time. All methods are async (Prisma is async).
// Single SQLite DB shared across all accounts via the Prisma singleton.

import { getPrisma } from './db.js'
import type { AccountId } from './auth.js'

// TTL constants in milliseconds
export const TTL = {
  THREAD_LIST: 5 * 60 * 1000, // 5 minutes
  THREAD: 30 * 60 * 1000, // 30 minutes
  LABELS: 30 * 60 * 1000, // 30 minutes
  PROFILE: 24 * 60 * 60 * 1000, // 24 hours
  LABEL_COUNTS: 2 * 60 * 1000, // 2 minutes
  CALENDAR_LIST: 30 * 60 * 1000, // 30 minutes
  CALENDAR_EVENTS: 5 * 60 * 1000, // 5 minutes
} as const

function isExpired(createdAt: Date, ttlMs: number): boolean {
  return createdAt.getTime() + ttlMs < Date.now()
}

// ---------------------------------------------------------------------------
// Thread list cache
// ---------------------------------------------------------------------------

export async function cacheThreadList(
  account: AccountId,
  params: { folder?: string; query?: string; maxResults?: number; labelIds?: string[]; pageToken?: string },
  data: unknown,
): Promise<void> {
  const prisma = await getPrisma()
  const where = {
    email: account.email,
    appId: account.appId,
    folder: params.folder ?? '',
    query: params.query ?? '',
    labelIds: params.labelIds?.join(',') ?? '',
    pageToken: params.pageToken ?? '',
    maxResults: params.maxResults ?? 0,
  }

  await prisma.threadList.upsert({
    where: { email_appId_folder_query_labelIds_pageToken_maxResults: where },
    create: { ...where, data: JSON.stringify(data), ttlMs: TTL.THREAD_LIST, createdAt: new Date() },
    update: { data: JSON.stringify(data), ttlMs: TTL.THREAD_LIST, createdAt: new Date() },
  })
}

export async function getCachedThreadList<T = unknown>(
  account: AccountId,
  params: { folder?: string; query?: string; maxResults?: number; labelIds?: string[]; pageToken?: string },
): Promise<T | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.threadList.findUnique({
    where: {
      email_appId_folder_query_labelIds_pageToken_maxResults: {
        email: account.email,
        appId: account.appId,
        folder: params.folder ?? '',
        query: params.query ?? '',
        labelIds: params.labelIds?.join(',') ?? '',
        pageToken: params.pageToken ?? '',
        maxResults: params.maxResults ?? 0,
      },
    },
  })

  if (!row || isExpired(row.createdAt, row.ttlMs)) return undefined
  return JSON.parse(row.data) as T
}

export async function invalidateThreadLists(account: AccountId): Promise<void> {
  const prisma = await getPrisma()
  await prisma.threadList.deleteMany({ where: { email: account.email, appId: account.appId } })
}

// ---------------------------------------------------------------------------
// Individual thread cache
// ---------------------------------------------------------------------------

export async function cacheThread(
  account: AccountId,
  threadId: string,
  data: unknown,
): Promise<void> {
  const prisma = await getPrisma()
  await prisma.thread.upsert({
    where: { email_appId_threadId: { email: account.email, appId: account.appId, threadId } },
    create: { email: account.email, appId: account.appId, threadId, data: JSON.stringify(data), ttlMs: TTL.THREAD, createdAt: new Date() },
    update: { data: JSON.stringify(data), ttlMs: TTL.THREAD, createdAt: new Date() },
  })
}

export async function getCachedThread<T = unknown>(
  account: AccountId,
  threadId: string,
): Promise<T | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.thread.findUnique({
    where: { email_appId_threadId: { email: account.email, appId: account.appId, threadId } },
  })

  if (!row || isExpired(row.createdAt, row.ttlMs)) return undefined
  return JSON.parse(row.data) as T
}

export async function invalidateThread(account: AccountId, threadId: string): Promise<void> {
  const prisma = await getPrisma()
  await prisma.thread.deleteMany({ where: { email: account.email, appId: account.appId, threadId } })
}

export async function invalidateThreads(account: AccountId, threadIds: string[]): Promise<void> {
  const prisma = await getPrisma()
  await prisma.thread.deleteMany({ where: { email: account.email, appId: account.appId, threadId: { in: threadIds } } })
}

// ---------------------------------------------------------------------------
// Labels cache
// ---------------------------------------------------------------------------

export async function cacheLabels(account: AccountId, data: unknown): Promise<void> {
  const prisma = await getPrisma()
  await prisma.label.upsert({
    where: { email_appId: { email: account.email, appId: account.appId } },
    create: { email: account.email, appId: account.appId, data: JSON.stringify(data), ttlMs: TTL.LABELS, createdAt: new Date() },
    update: { data: JSON.stringify(data), ttlMs: TTL.LABELS, createdAt: new Date() },
  })
}

export async function getCachedLabels<T = unknown>(account: AccountId): Promise<T | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.label.findUnique({ where: { email_appId: { email: account.email, appId: account.appId } } })
  if (!row || isExpired(row.createdAt, row.ttlMs)) return undefined
  return JSON.parse(row.data) as T
}

export async function invalidateLabels(account: AccountId): Promise<void> {
  const prisma = await getPrisma()
  await prisma.label.deleteMany({ where: { email: account.email, appId: account.appId } })
}

// ---------------------------------------------------------------------------
// Label counts cache
// ---------------------------------------------------------------------------

export async function cacheLabelCounts(account: AccountId, data: unknown): Promise<void> {
  const prisma = await getPrisma()
  await prisma.labelCount.upsert({
    where: { email_appId: { email: account.email, appId: account.appId } },
    create: { email: account.email, appId: account.appId, data: JSON.stringify(data), ttlMs: TTL.LABEL_COUNTS, createdAt: new Date() },
    update: { data: JSON.stringify(data), ttlMs: TTL.LABEL_COUNTS, createdAt: new Date() },
  })
}

export async function getCachedLabelCounts<T = unknown>(account: AccountId): Promise<T | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.labelCount.findUnique({ where: { email_appId: { email: account.email, appId: account.appId } } })
  if (!row || isExpired(row.createdAt, row.ttlMs)) return undefined
  return JSON.parse(row.data) as T
}

export async function invalidateLabelCounts(account: AccountId): Promise<void> {
  const prisma = await getPrisma()
  await prisma.labelCount.deleteMany({ where: { email: account.email, appId: account.appId } })
}

// ---------------------------------------------------------------------------
// Profile cache
// ---------------------------------------------------------------------------

export async function cacheProfile(account: AccountId, data: unknown): Promise<void> {
  const prisma = await getPrisma()
  await prisma.profile.upsert({
    where: { email_appId: { email: account.email, appId: account.appId } },
    create: { email: account.email, appId: account.appId, data: JSON.stringify(data), ttlMs: TTL.PROFILE, createdAt: new Date() },
    update: { data: JSON.stringify(data), ttlMs: TTL.PROFILE, createdAt: new Date() },
  })
}

export async function getCachedProfile<T = unknown>(account: AccountId): Promise<T | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.profile.findUnique({ where: { email_appId: { email: account.email, appId: account.appId } } })
  if (!row || isExpired(row.createdAt, row.ttlMs)) return undefined
  return JSON.parse(row.data) as T
}

// ---------------------------------------------------------------------------
// Sync state (persistent, no TTL)
// ---------------------------------------------------------------------------

export async function getLastHistoryId(account: AccountId): Promise<string | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.syncState.findUnique({
    where: { email_appId_key: { email: account.email, appId: account.appId, key: 'history_id' } },
  })
  return row?.value
}

export async function setLastHistoryId(account: AccountId, historyId: string): Promise<void> {
  const prisma = await getPrisma()
  await prisma.syncState.upsert({
    where: { email_appId_key: { email: account.email, appId: account.appId, key: 'history_id' } },
    create: { email: account.email, appId: account.appId, key: 'history_id', value: historyId },
    update: { value: historyId },
  })
}

// ---------------------------------------------------------------------------
// Calendar list cache
// ---------------------------------------------------------------------------

export async function cacheCalendarList(account: AccountId, data: unknown): Promise<void> {
  const prisma = await getPrisma()
  await prisma.calendarList.upsert({
    where: { email_appId: { email: account.email, appId: account.appId } },
    create: { email: account.email, appId: account.appId, data: JSON.stringify(data), ttlMs: TTL.CALENDAR_LIST, createdAt: new Date() },
    update: { data: JSON.stringify(data), ttlMs: TTL.CALENDAR_LIST, createdAt: new Date() },
  })
}

export async function getCachedCalendarList<T = unknown>(account: AccountId): Promise<T | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.calendarList.findUnique({ where: { email_appId: { email: account.email, appId: account.appId } } })
  if (!row || isExpired(row.createdAt, row.ttlMs)) return undefined
  return JSON.parse(row.data) as T
}

export async function invalidateCalendarLists(account: AccountId): Promise<void> {
  const prisma = await getPrisma()
  await prisma.calendarList.deleteMany({ where: { email: account.email, appId: account.appId } })
}

// ---------------------------------------------------------------------------
// Calendar events cache
// ---------------------------------------------------------------------------

export async function cacheCalendarEvents(
  account: AccountId,
  params: { calendarId?: string; timeMin?: string; timeMax?: string; query?: string; maxResults?: number; pageToken?: string },
  data: unknown,
): Promise<void> {
  const prisma = await getPrisma()
  const where = {
    email: account.email,
    appId: account.appId,
    calendarId: params.calendarId ?? '',
    timeMin: params.timeMin ?? '',
    timeMax: params.timeMax ?? '',
    query: params.query ?? '',
    maxResults: params.maxResults ?? 0,
    pageToken: params.pageToken ?? '',
  }

  await prisma.calendarEvent.upsert({
    where: { email_appId_calendarId_timeMin_timeMax_query_maxResults_pageToken: where },
    create: { ...where, data: JSON.stringify(data), ttlMs: TTL.CALENDAR_EVENTS, createdAt: new Date() },
    update: { data: JSON.stringify(data), ttlMs: TTL.CALENDAR_EVENTS, createdAt: new Date() },
  })
}

export async function getCachedCalendarEvents<T = unknown>(
  account: AccountId,
  params: { calendarId?: string; timeMin?: string; timeMax?: string; query?: string; maxResults?: number; pageToken?: string },
): Promise<T | undefined> {
  const prisma = await getPrisma()
  const row = await prisma.calendarEvent.findUnique({
    where: {
      email_appId_calendarId_timeMin_timeMax_query_maxResults_pageToken: {
        email: account.email,
        appId: account.appId,
        calendarId: params.calendarId ?? '',
        timeMin: params.timeMin ?? '',
        timeMax: params.timeMax ?? '',
        query: params.query ?? '',
        maxResults: params.maxResults ?? 0,
        pageToken: params.pageToken ?? '',
      },
    },
  })

  if (!row || isExpired(row.createdAt, row.ttlMs)) return undefined
  return JSON.parse(row.data) as T
}

export async function invalidateCalendarEvents(account: AccountId, calendarId?: string): Promise<void> {
  const prisma = await getPrisma()
  if (calendarId) {
    await prisma.calendarEvent.deleteMany({ where: { email: account.email, appId: account.appId, calendarId } })
  } else {
    await prisma.calendarEvent.deleteMany({ where: { email: account.email, appId: account.appId } })
  }
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

export async function clearExpired(): Promise<void> {
  const prisma = await getPrisma()
  const now = Date.now()
  // Use raw SQL for the timestamp arithmetic across all cache tables.
  // Column/table names match the Prisma schema (camelCase columns, PascalCase tables).
  await prisma.$executeRawUnsafe(
    `DELETE FROM "ThreadList" WHERE (strftime('%s', "createdAt") * 1000 + "ttlMs") < ?`,
    now,
  )
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Thread" WHERE (strftime('%s', "createdAt") * 1000 + "ttlMs") < ?`,
    now,
  )
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Label" WHERE (strftime('%s', "createdAt") * 1000 + "ttlMs") < ?`,
    now,
  )
  await prisma.$executeRawUnsafe(
    `DELETE FROM "LabelCount" WHERE (strftime('%s', "createdAt") * 1000 + "ttlMs") < ?`,
    now,
  )
  await prisma.$executeRawUnsafe(
    `DELETE FROM "Profile" WHERE (strftime('%s', "createdAt") * 1000 + "ttlMs") < ?`,
    now,
  )
  await prisma.$executeRawUnsafe(
    `DELETE FROM "CalendarList" WHERE (strftime('%s', "createdAt") * 1000 + "ttlMs") < ?`,
    now,
  )
  await prisma.$executeRawUnsafe(
    `DELETE FROM "CalendarEvent" WHERE (strftime('%s', "createdAt") * 1000 + "ttlMs") < ?`,
    now,
  )
}

export async function clearAll(account: AccountId): Promise<void> {
  const prisma = await getPrisma()
  const where = { email: account.email, appId: account.appId }
  await prisma.threadList.deleteMany({ where })
  await prisma.thread.deleteMany({ where })
  await prisma.label.deleteMany({ where })
  await prisma.labelCount.deleteMany({ where })
  await prisma.profile.deleteMany({ where })
  await prisma.syncState.deleteMany({ where })
  await prisma.calendarList.deleteMany({ where })
  await prisma.calendarEvent.deleteMany({ where })
}

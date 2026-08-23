// SQLite tables for ~/.zele/sqlite.db.
// Column names match the existing Prisma-created file. Do not rename them.

import { defineRelations } from 'drizzle-orm'
import * as s from 'drizzle-orm/sqlite-core'

/** Prisma stored DateTime as ISO text. Keep that so the live DB still reads. */
const isoDate = s.customType<{ data: Date; driverParam: string }>({
  dataType() {
    return 'text'
  },
  toDriver(value: Date): string {
    return value.toISOString()
  },
  fromDriver(value: unknown): Date {
    if (value instanceof Date) return value
    if (typeof value === 'string' || typeof value === 'number') return new Date(value)
    throw new Error('isoDate expected string, number, or Date', { cause: value })
  },
})

export const account = s.sqliteTable(
  'Account',
  {
    email: s.text('email').notNull(),
    appId: s.text('appId').notNull(),
    accountType: s.text('accountType').notNull().default('google'),
    capabilities: s.text('capabilities').notNull().default(''),
    accountStatus: s.text('accountStatus', { enum: ['active', 'disabled'] }).notNull(),
    tokens: s.text('tokens').notNull(),
    createdAt: isoDate('createdAt').notNull(),
    updatedAt: isoDate('updatedAt').notNull(),
  },
  (table) => [s.primaryKey({ columns: [table.email, table.appId] })],
)

export const thread = s.sqliteTable(
  'Thread',
  {
    id: s.integer('id').primaryKey({ autoIncrement: true }),
    email: s.text('email').notNull(),
    appId: s.text('appId').notNull(),
    threadId: s.text('threadId').notNull(),
    subject: s.text('subject').notNull(),
    snippet: s.text('snippet').notNull(),
    fromEmail: s.text('fromEmail').notNull(),
    fromName: s.text('fromName').notNull(),
    date: s.text('date').notNull(),
    labelIds: s.text('labelIds').notNull(),
    hasUnread: s.integer('hasUnread', { mode: 'boolean' }).notNull(),
    msgCount: s.integer('msgCount').notNull(),
    historyId: s.text('historyId'),
    rawData: s.text('rawData').notNull(),
    ttlMs: s.integer('ttlMs').notNull(),
    createdAt: isoDate('createdAt').notNull(),
  },
  (table) => [
    s
      .foreignKey({
        name: 'Thread_email_appId_fkey',
        columns: [table.email, table.appId],
        foreignColumns: [account.email, account.appId],
      })
      .onDelete('cascade')
      .onUpdate('cascade'),
    s.uniqueIndex('Thread_email_appId_threadId_key').on(table.email, table.appId, table.threadId),
  ],
)

export const label = s.sqliteTable(
  'Label',
  {
    email: s.text('email').notNull(),
    appId: s.text('appId').notNull(),
    rawData: s.text('rawData').notNull(),
    ttlMs: s.integer('ttlMs').notNull(),
    createdAt: isoDate('createdAt').notNull(),
  },
  (table) => [
    s.primaryKey({ columns: [table.email, table.appId] }),
    s
      .foreignKey({
        name: 'Label_email_appId_fkey',
        columns: [table.email, table.appId],
        foreignColumns: [account.email, account.appId],
      })
      .onDelete('cascade')
      .onUpdate('cascade'),
  ],
)

export const profile = s.sqliteTable(
  'Profile',
  {
    email: s.text('email').notNull(),
    appId: s.text('appId').notNull(),
    emailAddress: s.text('emailAddress').notNull(),
    messagesTotal: s.integer('messagesTotal').notNull(),
    threadsTotal: s.integer('threadsTotal').notNull(),
    historyId: s.text('historyId').notNull(),
    ttlMs: s.integer('ttlMs').notNull(),
    createdAt: isoDate('createdAt').notNull(),
  },
  (table) => [
    s.primaryKey({ columns: [table.email, table.appId] }),
    s
      .foreignKey({
        name: 'Profile_email_appId_fkey',
        columns: [table.email, table.appId],
        foreignColumns: [account.email, account.appId],
      })
      .onDelete('cascade')
      .onUpdate('cascade'),
  ],
)

export const calendarList = s.sqliteTable(
  'CalendarList',
  {
    email: s.text('email').notNull(),
    appId: s.text('appId').notNull(),
    rawData: s.text('rawData').notNull(),
    ttlMs: s.integer('ttlMs').notNull(),
    createdAt: isoDate('createdAt').notNull(),
  },
  (table) => [
    s.primaryKey({ columns: [table.email, table.appId] }),
    s
      .foreignKey({
        name: 'CalendarList_email_appId_fkey',
        columns: [table.email, table.appId],
        foreignColumns: [account.email, account.appId],
      })
      .onDelete('cascade')
      .onUpdate('cascade'),
  ],
)

export const threadRead = s.sqliteTable(
  'ThreadRead',
  {
    email: s.text('email').notNull(),
    appId: s.text('appId').notNull(),
    threadId: s.text('threadId').notNull(),
    messageId: s.text('messageId').notNull(),
    seenAt: isoDate('seenAt').notNull(),
  },
  (table) => [
    s.primaryKey({ columns: [table.email, table.appId, table.threadId] }),
    s
      .foreignKey({
        name: 'ThreadRead_email_appId_fkey',
        columns: [table.email, table.appId],
        foreignColumns: [account.email, account.appId],
      })
      .onDelete('cascade')
      .onUpdate('cascade'),
  ],
)

export const syncState = s.sqliteTable(
  'SyncState',
  {
    email: s.text('email').notNull(),
    appId: s.text('appId').notNull(),
    key: s.text('key').notNull(),
    value: s.text('value').notNull(),
  },
  (table) => [
    s.primaryKey({ columns: [table.email, table.appId, table.key] }),
    s
      .foreignKey({
        name: 'SyncState_email_appId_fkey',
        columns: [table.email, table.appId],
        foreignColumns: [account.email, account.appId],
      })
      .onDelete('cascade')
      .onUpdate('cascade'),
  ],
)

export const relations = defineRelations(
  { account, thread, label, profile, calendarList, threadRead, syncState },
  (r) => ({
    account: {
      threads: r.many.thread(),
      labels: r.many.label(),
      profiles: r.many.profile(),
      calendarLists: r.many.calendarList(),
      threadReads: r.many.threadRead(),
      syncStates: r.many.syncState(),
    },
    thread: {
      account: r.one.account({
        from: [r.thread.email, r.thread.appId],
        to: [r.account.email, r.account.appId],
      }),
    },
    label: {
      account: r.one.account({
        from: [r.label.email, r.label.appId],
        to: [r.account.email, r.account.appId],
      }),
    },
    profile: {
      account: r.one.account({
        from: [r.profile.email, r.profile.appId],
        to: [r.account.email, r.account.appId],
      }),
    },
    calendarList: {
      account: r.one.account({
        from: [r.calendarList.email, r.calendarList.appId],
        to: [r.account.email, r.account.appId],
      }),
    },
    threadRead: {
      account: r.one.account({
        from: [r.threadRead.email, r.threadRead.appId],
        to: [r.account.email, r.account.appId],
      }),
    },
    syncState: {
      account: r.one.account({
        from: [r.syncState.email, r.syncState.appId],
        to: [r.account.email, r.account.appId],
      }),
    },
  }),
)

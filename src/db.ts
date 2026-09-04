// Drizzle + node:sqlite for ~/.zele/sqlite.db.
// One sync handle for schema init and queries. Do not use libsql or Prisma:
// their local-file adapters can leave writes in a zombie transaction that
// rolls back on process exit (prisma/prisma#30028, libsql-client-ts#350).
// node:sqlite is not built with SQLITE_ENABLE_UPDATE_DELETE_LIMIT. Never
// add .limit(1) on drizzle update/delete. Node throws. Bun hides it.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/node-sqlite'
import * as errore from 'errore'
import { DbError } from './api-utils.js'
import * as schema from './schema.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ZELE_DIR = path.join(os.homedir(), '.zele')
const DB_PATH = path.join(ZELE_DIR, 'sqlite.db')

export { schema }

export type ZeleDb = ReturnType<typeof createDb>

let sqliteInstance: DatabaseSync | null = null
let dbInstance: ZeleDb | null = null

function createDb(client: DatabaseSync) {
  return drizzle({ client, relations: schema.relations })
}

/** Get the singleton Drizzle client. Creates ~/.zele and applies schema.sql on first call. */
export function getDb(): ZeleDb {
  if (dbInstance) return dbInstance

  if (!fs.existsSync(ZELE_DIR)) {
    fs.mkdirSync(ZELE_DIR, { recursive: true, mode: 0o700 })
  } else {
    fs.chmodSync(ZELE_DIR, 0o700)
  }

  const sqlite = new DatabaseSync(DB_PATH)
  sqlite.exec('PRAGMA busy_timeout = 15000')
  sqlite.exec('PRAGMA journal_mode = WAL')
  sqlite.exec('PRAGMA synchronous = FULL')
  sqlite.exec('PRAGMA foreign_keys = ON')
  applySchemaAndMigrate(sqlite)
  secureDatabase()

  sqliteInstance = sqlite
  dbInstance = createDb(sqlite)
  return dbInstance
}

function applySchemaAndMigrate(sqlite: DatabaseSync): void {
  let schemaPath = path.join(__dirname, 'schema.sql')
  if (!fs.existsSync(schemaPath)) {
    schemaPath = path.join(__dirname, '..', 'src', 'schema.sql')
  }

  const sql = fs.readFileSync(schemaPath, 'utf-8')
  const statements = sql
    .split(';')
    .map((s) =>
      s
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((s) => s.length > 0 && !/^CREATE\s+TABLE\s+["']?sqlite_sequence["']?\s*\(/i.test(s))
    .map((s) =>
      s
        .replace(/^CREATE\s+UNIQUE\s+INDEX\b(?!\s+IF)/i, 'CREATE UNIQUE INDEX IF NOT EXISTS')
        .replace(/^CREATE\s+INDEX\b(?!\s+IF)/i, 'CREATE INDEX IF NOT EXISTS'),
    )

  sqlite.exec('BEGIN IMMEDIATE')
  try {
    for (const statement of statements) {
      sqlite.exec(statement)
    }

    const cols = sqlite.prepare('PRAGMA table_info("Account")').all()
    const colNames = new Set(
      cols.flatMap((r) => (typeof r.name === 'string' ? [r.name] : [])),
    )

    if (!colNames.has('accountType')) {
      sqlite.exec(`ALTER TABLE "Account" ADD COLUMN "accountType" TEXT NOT NULL DEFAULT 'google'`)
    }
    if (!colNames.has('capabilities')) {
      sqlite.exec(`ALTER TABLE "Account" ADD COLUMN "capabilities" TEXT NOT NULL DEFAULT ''`)
    }

    sqlite.exec(`
      UPDATE "Account"
      SET "capabilities" = 'gmail,calendar,smtp'
      WHERE "accountType" = 'google' AND ("capabilities" = '' OR "capabilities" IS NULL)
    `)

    sqlite.exec('COMMIT')
  } catch (err) {
    sqlite.exec('ROLLBACK')
    throw err
  }
}

function secureDatabase(): void {
  const filesToSecure = [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]
  for (const filePath of filesToSecure) {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, 0o600)
    }
  }
}

function dbBoundary<T>(fn: () => T) {
  return errore.tryAsync({
    try: async () => fn(),
    catch: (err) => new DbError({ reason: String(err), cause: err }),
  })
}

/** Last message id shown by `mail read` for this thread, or null if never read. */
export async function getThreadSeenMessageId({
  email,
  appId,
  threadId,
}: {
  email: string
  appId: string
  threadId: string
}) {
  const row = await dbBoundary(() => {
    return getDb().query.threadRead.findFirst({
      where: { email, appId, threadId },
    }).sync()
  })
  if (row instanceof Error) return row
  return row?.messageId ?? null
}

/** Record that `mail read` (or a Gmail send we just made) showed this message. */
export async function setThreadSeenMessageId({
  email,
  appId,
  threadId,
  messageId,
}: {
  email: string
  appId: string
  threadId: string
  messageId: string
}) {
  const seenAt = new Date()
  return dbBoundary(() => {
    const db = getDb()
    db.insert(schema.threadRead)
      .values({ email, appId, threadId, messageId, seenAt })
      .onConflictDoUpdate({
        target: [schema.threadRead.email, schema.threadRead.appId, schema.threadRead.threadId],
        set: { messageId, seenAt },
      })
      .run()
  })
}

/** Close the SQLite handle. Safe to call when no DB was opened. */
export function closeDb(): void {
  if (!sqliteInstance) return
  sqliteInstance.close()
  sqliteInstance = null
  dbInstance = null
}

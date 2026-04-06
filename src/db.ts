// Prisma singleton for zele.
// Manages a single SQLite database at ~/.zele/sqlite.db for all state:
// accounts (OAuth tokens), cache (threads, labels, profiles), and sync state.
// Runs idempotent schema setup on every startup using src/schema.sql.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaClient } from './generated/client.js'

export { PrismaClient }

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const ZELE_DIR = path.join(os.homedir(), '.zele')
const DB_PATH = path.join(ZELE_DIR, 'sqlite.db')

let prismaInstance: PrismaClient | null = null
let initPromise: Promise<PrismaClient> | null = null

/**
 * Get the singleton Prisma client instance.
 * Initializes the database on first call, running schema setup if needed.
 */
export function getPrisma(): Promise<PrismaClient> {
  if (prismaInstance) {
    return Promise.resolve(prismaInstance)
  }
  if (initPromise) {
    return initPromise
  }
  initPromise = initializePrisma()
  return initPromise
}

async function initializePrisma(): Promise<PrismaClient> {
  // Create directory with restrictive permissions (owner only)
  if (!fs.existsSync(ZELE_DIR)) {
    fs.mkdirSync(ZELE_DIR, { recursive: true, mode: 0o700 })
  } else {
    // Ensure existing directory has correct permissions
    fs.chmodSync(ZELE_DIR, 0o700)
  }

  const adapter = new PrismaLibSql({ url: `file:${DB_PATH}` })
  const prisma = new PrismaClient({ adapter })

  // WAL mode: allows concurrent readers + single writer, persists on the DB file.
  // busy_timeout: wait up to 5s for locks to clear instead of failing instantly.
  // Prevents "database is locked" errors when multiple processes (TUI, watch, CLI)
  // access the DB, or after macOS sleep/wake leaves stale locks.
  await prisma.$executeRawUnsafe('PRAGMA journal_mode = WAL')
  await prisma.$executeRawUnsafe('PRAGMA busy_timeout = 5000')

  // Run schema.sql — uses CREATE TABLE IF NOT EXISTS so it's idempotent
  await applySchema(prisma)

  // Add new columns to existing Account tables (idempotent migration).
  // CREATE TABLE IF NOT EXISTS doesn't add columns to pre-existing tables.
  await migrateAccountColumns(prisma)

  // Secure database files (owner read/write only)
  secureDatabase()

  prismaInstance = prisma
  return prisma
}

async function applySchema(prisma: PrismaClient): Promise<void> {
  // When running from source (tsx), __dirname is src/
  // When running from dist, __dirname is dist/ and schema.sql is at ../src/schema.sql
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
    // Make CREATE INDEX idempotent
    .map((s) => s.replace(/^CREATE\s+UNIQUE\s+INDEX\b(?!\s+IF)/i, 'CREATE UNIQUE INDEX IF NOT EXISTS')
                 .replace(/^CREATE\s+INDEX\b(?!\s+IF)/i, 'CREATE INDEX IF NOT EXISTS'))

  for (const statement of statements) {
    await prisma.$executeRawUnsafe(statement)
  }
}

/**
 * Idempotent migration: add accountType and capabilities columns to Account
 * if they don't already exist (for DBs created before IMAP/SMTP support).
 * Also backfill existing Google accounts with their default capabilities.
 */
async function migrateAccountColumns(prisma: PrismaClient): Promise<void> {
  const cols = await prisma.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("Account")`)
  const colNames = new Set(cols.map((c) => c.name))

  if (!colNames.has('accountType')) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "Account" ADD COLUMN "accountType" TEXT NOT NULL DEFAULT 'google'`)
  }
  if (!colNames.has('capabilities')) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "Account" ADD COLUMN "capabilities" TEXT NOT NULL DEFAULT ''`)
  }

  // Backfill: existing Google accounts should have capabilities set
  await prisma.$executeRawUnsafe(`
    UPDATE "Account"
    SET "capabilities" = 'gmail,calendar,smtp'
    WHERE "accountType" = 'google' AND ("capabilities" = '' OR "capabilities" IS NULL)
  `)
}

/**
 * Set restrictive permissions on database files.
 * SQLite WAL mode creates additional -wal and -shm files that also need protection.
 */
function secureDatabase(): void {
  const filesToSecure = [
    DB_PATH,
    `${DB_PATH}-wal`,
    `${DB_PATH}-shm`,
  ]

  for (const filePath of filesToSecure) {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, 0o600)
    }
  }
}

/**
 * Close the Prisma connection.
 */
export async function closePrisma(): Promise<void> {
  if (prismaInstance) {
    await prismaInstance.$disconnect()
    prismaInstance = null
    initPromise = null
  }
}

// SQLite-based cache for Gmail API responses.
// Uses better-sqlite3 for synchronous reads (instant cache hits) and TTL-based expiry.
// Stores JSON blobs keyed by operation + params hash. Two tables: `cache` for TTL data,
// `sync_state` for persistent values like history ID watermark.

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const DEFAULT_DB_DIR = path.join(os.homedir(), '.gtui')
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'cache.db')

// Row shapes for typed .prepare() queries
interface CacheRow { value: string; ttl_ms: number; created_at: number }
interface SyncRow { value: string }

// TTL constants in milliseconds
export const TTL = {
  THREAD_LIST: 5 * 60 * 1000, // 5 minutes
  THREAD: 30 * 60 * 1000, // 30 minutes
  LABELS: 30 * 60 * 1000, // 30 minutes
  PROFILE: 24 * 60 * 60 * 1000, // 24 hours
  LABEL_COUNTS: 2 * 60 * 1000, // 2 minutes
} as const

export class GmailCache {
  private db: Database.Database

  constructor({ dbPath }: { dbPath?: string } = {}) {
    const resolvedPath = dbPath ?? DEFAULT_DB_PATH
    const dir = path.dirname(resolvedPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    this.db = new Database(resolvedPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.init()
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        ttl_ms     INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  }

  // ---------------------------------------------------------------------------
  // Generic cache operations
  // ---------------------------------------------------------------------------

  private cacheKey(prefix: string, params?: Record<string, unknown>) {
    if (!params || Object.keys(params).length === 0) return prefix
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(params))
      .digest('hex')
      .slice(0, 16)
    return `${prefix}:${hash}`
  }

  private get<T>(key: string): T | undefined {
    const row = this.db
      .prepare<[string], CacheRow>('SELECT value, ttl_ms, created_at FROM cache WHERE key = ?')
      .get(key)

    if (!row) return undefined

    const expired = row.created_at + row.ttl_ms < Date.now()
    if (expired) {
      this.db.prepare('DELETE FROM cache WHERE key = ?').run(key)
      return undefined
    }

    return JSON.parse(row.value) as T
  }

  private set(key: string, value: unknown, ttlMs: number) {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO cache (key, value, ttl_ms, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(key, JSON.stringify(value), ttlMs, Date.now())
  }

  private invalidateByPrefix(prefix: string) {
    this.db.prepare("DELETE FROM cache WHERE key LIKE ? || '%'").run(prefix)
  }

  // ---------------------------------------------------------------------------
  // Thread list cache
  // ---------------------------------------------------------------------------

  cacheThreadList(
    params: { folder?: string; query?: string; labelIds?: string[]; pageToken?: string },
    data: unknown,
  ) {
    const key = this.cacheKey('thread-list', params)
    this.set(key, data, TTL.THREAD_LIST)
  }

  getCachedThreadList<T = unknown>(params: {
    folder?: string
    query?: string
    labelIds?: string[]
    pageToken?: string
  }) {
    const key = this.cacheKey('thread-list', params)
    return this.get<T>(key)
  }

  invalidateThreadLists() {
    this.invalidateByPrefix('thread-list')
  }

  // ---------------------------------------------------------------------------
  // Individual thread cache
  // ---------------------------------------------------------------------------

  cacheThread(threadId: string, data: unknown) {
    this.set(`thread:${threadId}`, data, TTL.THREAD)
  }

  getCachedThread<T = unknown>(threadId: string) {
    return this.get<T>(`thread:${threadId}`)
  }

  invalidateThread(threadId: string) {
    this.db.prepare('DELETE FROM cache WHERE key = ?').run(`thread:${threadId}`)
  }

  invalidateThreads(threadIds: string[]) {
    const del = this.db.prepare('DELETE FROM cache WHERE key = ?')
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        del.run(`thread:${id}`)
      }
    })
    tx(threadIds)
  }

  // ---------------------------------------------------------------------------
  // Labels cache
  // ---------------------------------------------------------------------------

  cacheLabels(labels: unknown) {
    this.set('labels', labels, TTL.LABELS)
  }

  getCachedLabels<T = unknown>() {
    return this.get<T>('labels')
  }

  invalidateLabels() {
    this.db.prepare('DELETE FROM cache WHERE key = ?').run('labels')
  }

  // ---------------------------------------------------------------------------
  // Label counts cache
  // ---------------------------------------------------------------------------

  cacheLabelCounts(counts: unknown) {
    this.set('label-counts', counts, TTL.LABEL_COUNTS)
  }

  getCachedLabelCounts<T = unknown>() {
    return this.get<T>('label-counts')
  }

  invalidateLabelCounts() {
    this.db.prepare('DELETE FROM cache WHERE key = ?').run('label-counts')
  }

  // ---------------------------------------------------------------------------
  // Profile cache
  // ---------------------------------------------------------------------------

  cacheProfile(profile: unknown) {
    this.set('profile', profile, TTL.PROFILE)
  }

  getCachedProfile<T = unknown>() {
    return this.get<T>('profile')
  }

  // ---------------------------------------------------------------------------
  // Sync state (persistent, no TTL)
  // ---------------------------------------------------------------------------

  getLastHistoryId() {
    const row = this.db
      .prepare<[string], SyncRow>('SELECT value FROM sync_state WHERE key = ?')
      .get('history_id')
    return row?.value
  }

  setLastHistoryId(historyId: string) {
    this.db
      .prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)')
      .run('history_id', historyId)
  }

  // ---------------------------------------------------------------------------
  // Housekeeping
  // ---------------------------------------------------------------------------

  clearExpired() {
    this.db
      .prepare('DELETE FROM cache WHERE created_at + ttl_ms < ?')
      .run(Date.now())
  }

  clearAll() {
    this.db.exec('DELETE FROM cache; DELETE FROM sync_state;')
  }

  close() {
    this.db.close()
  }
}

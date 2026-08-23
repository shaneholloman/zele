---
'zele': patch
---

Replace Prisma with Drizzle and `node:sqlite` for the local CLI database.

Prisma + `@prisma/adapter-libsql` could acknowledge writes in the same process and then roll them back on exit. That made `mail reply` fail with "latest message was not read" after `mail read`, and it dropped refreshed OAuth tokens.

The CLI now uses a single sync `DatabaseSync` handle. A write is committed when the statement returns.

CLI commands now need **Node.js 22.16+** (`node:sqlite`). Existing `~/.zele/sqlite.db` files keep working. Table and column names are unchanged.

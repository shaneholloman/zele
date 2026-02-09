# Changelog

## 0.3.0

- **Mail:** Add `mail watch` command for polling new emails using Gmail History API (incremental sync)
- **Mail:** Add support for Gmail search operators in `watch --query` (e.g., `from:github`, `is:unread`)
- **Mail:** Show sender email address in `from` fields for better clarity
- **Fixes:** Improve query parsing and handle server-only operators correctly

## 0.2.0

- **Calendar:** Add comprehensive calendar commands (`cal list`, `events`, `get`, `create`, `update`, `delete`, `respond`, `freebusy`)
- **Calendar:** Use CalDAV protocol instead of Google REST API for better compatibility and efficiency
- **Calendar:** Add local caching for calendar lists and events
- **Auth:** Breaking change: `auth` namespace removed. Use `zele login`, `zele logout`, `zele whoami` directly
- **Docs:** Add comprehensive README with install, setup, and command reference
- **Fixes:** Improved error logging with stack traces
- **Internal:** Remove focus/ooo commands (use `cal create` instead)


## 0.1.3

- Add CHANGELOG.md
- Add changelog guidance to AGENTS.md

## 0.1.2

- Replace monolithic `googleapis` with scoped `@googleapis/gmail` for smaller install size

## 0.1.1

- Rename package from `gtui` to `zele`
- Rename config directory `~/.gtui` to `~/.zele`, database `gtui.db` to `zele.db`
- Rename env vars `GTUI_CLIENT_ID`/`GTUI_CLIENT_SECRET` to `ZELE_CLIENT_ID`/`ZELE_CLIENT_SECRET`
- Style login flow with picocolors (bold steps, cyan URL, dim hints, yellow warnings)

## 0.1.0

- Initial release as `gtui`
- Multi-account Gmail CLI with OAuth2 authentication
- Commands: mail (list, search, read, send, reply, forward), drafts, labels, attachments, profile
- Prisma-backed SQLite cache with TTL-based expiry
- YAML output with TTY-aware coloring

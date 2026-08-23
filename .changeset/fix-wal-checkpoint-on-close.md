---
'zele': patch
---

Fix `mail reply` failing with "latest message was not read" right after `mail read`.

Prisma writes (the ThreadRead row, refreshed OAuth tokens, thread cache) were visible in the same process but discarded when the CLI exited. `closePrisma()` now checkpoints the SQLite WAL before disconnect, and the CLI always closes the database when a command finishes.

```bash
zele mail read 18f3b7c9d2a1e4f0
zele mail reply 18f3b7c9d2a1e4f0 --body "sounds good"
```

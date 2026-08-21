---
'zele': minor
---

Refuse `mail reply` and `mail send --thread-id` unless `mail read` already showed the live last message in that thread.

Agents can no longer send a reply from a stale view after someone else answers. If the latest message changed since the last `mail read`, the command fails with `UnseenLatestError` and tells you to read again:

```bash
zele mail read 18f3b7c9d2a1e4f0
zele mail reply 18f3b7c9d2a1e4f0 --body "sounds good"
```

`--dry-run` still works without a prior read because it does not send. Pass `--force` to skip the check.

`mail watch` and `mail list` do not count as a read. The TUI is unchanged.

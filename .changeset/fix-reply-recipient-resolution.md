---
'zele': minor
---

Fix `mail reply` sending replies to your own address

Reply recipients used to be "the sender of the last message in the thread". Whenever the last message was one you sent, that resolved to your own address and the reply went back to your inbox instead of the person you were talking to. Drafts made it worse: a trailing draft became the anchor, so the reply targeted you *and* lost its `In-Reply-To` header.

Recipient resolution now lives in one place (`resolveReplyRecipients`) shared by the Gmail and IMAP clients:

- the anchor message is the last **non-draft** message
- `Reply-To` is parsed as an address list instead of being used as a raw header string, so `Reply-To: Paul <paul@acme.com>` and multi-address `Reply-To` work
- when the anchor was sent by you, the reply goes to **its recipients**; if it was self-addressed, zele walks back to the last message from someone else
- send-as aliases and plus-tagged variants count as you; Gmail dotted variants do too

New flags on `zele mail reply`:

```bash
zele mail reply <thread-id> --dry-run                      # print all recipients/sender/threading headers, send nothing
zele mail reply <thread-id> --to paul@acme.com --body "…"  # override the inferred recipient
zele mail reply <thread-id> --bcc ops@acme.com --body "…"
zele mail reply <thread-id> --allow-self --body "…"        # deliberate note to self
```

If a reply would only reach your own address it is now **refused** with `SelfRecipientError` instead of being sent silently. `mail reply` also prints the resolved recipients on success.

New `zele mail send --thread-id <thread-id>` sends a message into an existing thread with correct `In-Reply-To`/`References` headers (and Gmail's `threadId`), so you no longer have to choose between correct recipients and correct threading.

Internals: `getThread` and `sendMessage` now return errors as values instead of throwing, matching the rest of the codebase.

---
'zele': minor
---

Add Microsoft OAuth login for Outlook, Hotmail, and Microsoft 365.

Outlook.com disabled password IMAP (`AUTH=XOAUTH2` only). `zele login microsoft` opens a browser, uses Thunderbird's public Microsoft client ID with a localhost callback, then stores XOAUTH2 tokens for IMAP and SMTP.

```bash
zele login microsoft
zele login microsoft --email you@outlook.com
zele login --method microsoft
```

Outlook accounts show as `imap_smtp` in `zele whoami`. Google-only features (labels, filters, calendar) stay unavailable.

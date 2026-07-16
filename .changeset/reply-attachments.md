---
'zele': minor
---

Add attachment support to `zele mail reply`, including draft replies.

```bash
zele mail reply <threadId> --body "See attached" --attach report.pdf
zele mail reply <threadId> --body "Multiple files" --attach a.pdf --attach b.png
zele mail reply <threadId> --body "Draft with attachment" --attach doc.pdf --draft
```

Works with both Gmail and IMAP/SMTP accounts. The `--attach` flag is repeatable,
matching the existing `mail send --attach` behavior.

Closes #14

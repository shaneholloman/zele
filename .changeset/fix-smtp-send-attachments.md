---
'zele': patch
---

Keep file attachments on IMAP/SMTP `mail send`.

`--attach` already reached nodemailer, but the Sent-folder copy fell back to a plain-text RFC 822 body because `MailComposer` is not a public nodemailer export. Zele now compiles one MIME buffer with `nodemailer/lib/mail-composer` and uses that buffer for both SMTP DATA and IMAP Sent APPEND.

```sh
zele mail send --account you@example.com --to peer@example.com \
  --subject 'Invoice' --body 'Attached.' --attach ./invoice.pdf
```

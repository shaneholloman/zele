---
'zele': patch
---

Refresh Outlook XOAUTH2 tokens on every IMAP and SMTP call, so `zele mail watch` keeps working after the 1-hour access token expires.

Expired or revoked Microsoft tokens now surface as auth errors with `zele login microsoft`. Login uses the email in the id_token, not `--email`, if the account picker does not match.

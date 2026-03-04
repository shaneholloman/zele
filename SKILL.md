# zele — Gmail & Google Calendar CLI

A multi-account Gmail and Google Calendar client. Output is YAML, pipe-friendly.

## Setup

```bash
# install (requires bun)
bun install -g zele

# authenticate (opens browser, supports multiple accounts)
zele login
```

**Remote/headless login:** `zele login` prints an authorization URL. Open it in any browser, complete consent, then paste the `localhost` redirect URL back into the terminal. Works over SSH, tmux, etc.

## Important

**Always run `zele --help` before using.** The help output is the source of truth for all commands, options, and syntax. Run `zele <command> --help` for subcommand details (e.g. `zele mail send --help`).

Running `zele` with no subcommand launches a human-friendly TUI for browsing email. **Agents should not use the TUI** — always use the CLI subcommands (`zele mail list`, `zele cal events`, etc.) which output structured YAML.

## Capabilities

- **Mail:** list, search, read, send, reply, forward, star, archive, trash, label, watch for new emails
- **Drafts:** list, create, get, send, delete
- **Calendar:** list calendars, list/search events, create/update/delete events, RSVP, free/busy
- **Labels:** list, create, delete, unread counts
- **Attachments:** list per thread, download
- **Multi-account:** all commands support `--account <email>` to filter; list/search merge across accounts

## Examples

```bash
# list inbox
zele mail list

# search mail
zele mail search "from:github subject:review"

# read a thread (thread IDs come from list/search output)
zele mail read <threadId>

# send an email with attachment
zele mail send --to alice@example.com --subject "Report" --body "See attached" --attach report.pdf

# reply all
zele mail reply <threadId> --body "Thanks!" --all

# watch inbox for new mail (polls every 15s)
zele mail watch

# today's calendar events across all accounts
zele cal events --today --all

# create a meeting with Google Meet
zele cal create --summary "Standup" --from tomorrow --to +30m --meet --attendees bob@example.com

# check free/busy
zele cal freebusy --from today --to +8h
```

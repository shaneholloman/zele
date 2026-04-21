# gogcli Gmail Implementation Reference

Reference for reimplementing gogcli's Gmail commands in TypeScript using Google JS APIs.

Source: `github.com/steipete/gogcli` (Go, v0.9.0)
JS equivalent: `googleapis` npm package (`google.gmail('v1')`)


## Architecture Overview

```
CLI args
  |
  v
Command struct (flags/args via kong parser)
  |
  v
cmd.Run(ctx, flags)
  |
  v
newGmailService(ctx, account)
  |  reads OAuth creds from keyring
  |  creates oauth2.TokenSource (auto-refresh)
  |  wraps HTTP transport with RetryTransport
  |  returns *gmail.Service
  v
svc.Users.{Resource}.{Method}("me", ...).Do()
  |  (official Google Go API client)
  v
Output: --json -> JSON to stdout | text -> tab-separated table
```

Key design: every command follows the same pattern:
1. Validate args/flags
2. Get authenticated Gmail service
3. Call Google API
4. Format output (JSON or text)


## Auth & Service Creation

**Go implementation** (`googleapi/gmail.go`, `googleapi/client.go`):

```
NewGmail(ctx, email)
  -> optionsForAccount(ctx, ServiceGmail, email)
    -> resolve OAuth client name for email
    -> read client credentials (clientID, clientSecret) from config
    -> load refresh token from keyring/secrets store
    -> create oauth2.TokenSource with auto-refresh
    -> wrap in RetryTransport (handles 429 + 5xx)
    -> return []option.ClientOption with authenticated HTTP client
  -> gmail.NewService(ctx, opts...)
```

**JS equivalent**:
```ts
import { google } from 'googleapis';

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
oauth2Client.setCredentials({ refresh_token: refreshToken });
const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
```

The Go version uses a package-level `var newGmailService` that can be swapped in tests.
In JS, use dependency injection or a factory function.


## Retry & Error Handling

**RetryTransport** (`googleapi/transport.go`):
- Wraps HTTP transport at the `RoundTrip` level
- **429 (rate limit)**: up to 3 retries, exponential backoff (1s base) with jitter, respects `Retry-After` header
- **5xx (server error)**: up to 1 retry, 1s delay
- **Circuit breaker**: stops all requests if too many consecutive failures
- Request bodies are buffered for replay on retry

**JS equivalent**: use `axios-retry` or `gaxios` retry config, or implement manually:
```ts
const backoff = (attempt: number) => {
  const base = 1000 * Math.pow(2, attempt);
  const jitter = Math.random() * base / 2;
  return base + jitter;
};
```

**Error types** (`googleapi/errors.go`):
- `AuthRequiredError` - no token found, need to re-auth
- `RateLimitError` - 429 exceeded after retries
- `CircuitBreakerError` - too many failures
- `QuotaExceededError` - API quota hit
- `NotFoundError` - resource not found
- `PermissionDeniedError` - insufficient scopes


## Output System

**Two modes** (`outfmt/outfmt.go`):
- `--json`: `outfmt.WriteJSON(os.Stdout, payload)` - pretty-printed JSON, no HTML escaping
- `--plain`: raw TSV output (no alignment)
- Default: aligned tab-separated table via `tabwriter`

**Pattern in every command**:
```go
if outfmt.IsJSON(ctx) {
    return outfmt.WriteJSON(os.Stdout, map[string]any{
        "threads":       items,
        "nextPageToken": resp.NextPageToken,
    })
}
// else: print table
w, flush := tableWriter(ctx)
defer flush()
fmt.Fprintln(w, "ID\tDATE\tFROM\tSUBJECT")
for _, it := range items {
    fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", it.ID, it.Date, it.From, it.Subject)
}
```


## Pagination

**Pattern used everywhere**:
- `--limit`: passed as `MaxResults(n)` to the API call
- `--page`: passed as `PageToken(token)` to the API call
- Response includes `NextPageToken`
- In JSON mode: `nextPageToken` field in output
- In text mode: hint printed to stderr: `# Next page: --page <token>`

**Go implementation** (`output_helpers.go`):
```go
func printNextPageHint(u *ui.UI, nextPageToken string) {
    if nextPageToken == "" { return }
    u.Err().Printf("# Next page: --page %s", nextPageToken)
}
```

**JS equivalent**: The Google JS API supports the same pattern:
```ts
const res = await gmail.users.threads.list({
  userId: 'me', q: query, maxResults: max, pageToken: page
});
// res.data.nextPageToken
```

The CLI does NOT auto-paginate. It returns one page and tells the user how to get the next one.


## Concurrent Fetching

Search endpoints only return IDs. The CLI fetches details concurrently.

**Pattern** (`gmail.go:fetchThreadDetails`, `gmail_messages.go:fetchMessageDetails`):
```go
const maxConcurrency = 10
sem := make(chan struct{}, maxConcurrency)

for i, t := range threads {
    go func(idx int, threadID string) {
        sem <- struct{}{}        // acquire
        defer func() { <-sem }() // release

        thread, err := svc.Users.Threads.Get("me", threadID).
            Format("metadata").
            MetadataHeaders("From", "Subject", "Date").
            Do()
        // ...
    }(i, t.Id)
}
```

- Bounded to 10 concurrent requests to avoid rate limiting
- Results collected in order (indexed array)
- On error: re-runs sequentially to find first error

**JS equivalent**: use `Promise.all` with a concurrency limiter like `p-limit`:
```ts
import pLimit from 'p-limit';
const limit = pLimit(10);
const details = await Promise.all(
  threadIds.map(id => limit(() => gmail.users.threads.get({
    userId: 'me', id, format: 'metadata',
    metadataHeaders: ['From', 'Subject', 'Date']
  })))
);
```


## Label Resolution

Labels are referenced by name or ID. The CLI resolves names to IDs before API calls.

**Two helper maps**:
- `fetchLabelNameToID(svc)` - for modifying labels (name -> ID)
- `fetchLabelIDToName(svc)` - for display (ID -> name)

Both call `svc.Users.Labels.List("me")` and build maps.
Name lookups are case-insensitive (`strings.ToLower`).

**JS equivalent**:
```ts
const labelsRes = await gmail.users.labels.list({ userId: 'me' });
const nameToId = new Map(
  labelsRes.data.labels.map(l => [l.name.toLowerCase(), l.id])
);
```


## Command-by-Command Breakdown


### gmail search

**API**: `GET /gmail/v1/users/me/threads?q={query}&maxResults={max}&pageToken={page}`

**Go call**: `svc.Users.Threads.List("me").Q(query).MaxResults(max).PageToken(page).Do()`

**Then**: For each thread in response, concurrently fetch:
`svc.Users.Threads.Get("me", threadID).Format("metadata").MetadataHeaders("From", "Subject", "Date").Do()`

**Output fields**: `id`, `date`, `from`, `subject`, `labels`, `messageCount`

**Flags**:
| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `query` | arg[] | required | Gmail search query (joined with spaces) |
| `--limit` | int | 10 | Max results per page |
| `--page` | string | - | Page token for next page |
| `--oldest` | bool | false | Show first message date instead of last |
| `--timezone` | string | local | IANA timezone for dates |
| `--local` | bool | false | Force local timezone |

**Date handling**: Dates parsed with `net/mail.ParseDate()`, formatted as `2006-01-02 15:04` in the output timezone.


### gmail messages search

**API**: `GET /gmail/v1/users/me/messages?q={query}&maxResults={max}&pageToken={page}`

**Go call**: `svc.Users.Messages.List("me").Q(query).MaxResults(max).PageToken(page).Fields("messages(id,threadId),nextPageToken").Do()`

**Then**: For each message, concurrently fetch:
- Without body: `svc.Users.Messages.Get("me", id).Format("metadata").MetadataHeaders("From", "Subject", "Date").Fields("id,threadId,labelIds,payload(headers)").Do()`
- With body (`--include-body`): `svc.Users.Messages.Get("me", id).Format("full").Do()`

**Output fields**: `id`, `threadId`, `date`, `from`, `subject`, `labels`, `body` (optional)

**Extra flags**:
| Flag | Description |
|------|-------------|
| `--include-body` | Include decoded message body (truncated to 200 chars in text mode) |


### gmail get

**API**: `GET /gmail/v1/users/me/messages/{messageId}?format={format}`

**Go call**: `svc.Users.Messages.Get("me", messageID).Format(format).Do()`

**Formats**:
- `full` (default): full message with body + attachments
- `metadata`: headers only (default headers: From, To, Subject, Date, List-Unsubscribe)
- `raw`: base64url-encoded RFC822

**JSON output includes**:
- `message` - raw API response
- `headers` - flattened map: `{from, to, cc, bcc, subject, date}`
- `body` - decoded body text (full format only)
- `attachments` - list of `{filename, size, sizeHuman, mimeType, attachmentId}`
- `unsubscribe` - best unsubscribe link from `List-Unsubscribe` header

**Body extraction** (`gmail_thread.go`): walks MIME tree, prefers `text/plain` over `text/html`, decodes base64/quoted-printable, handles charset conversion.

**Unsubscribe link parsing**: extracts `<url>` from `List-Unsubscribe` header, prefers HTTPS > HTTP > mailto.


### gmail send

**API**: `POST /gmail/v1/users/me/messages/send` with `{raw: base64url(RFC822)}`

**Go call**: `svc.Users.Messages.Send("me", &gmail.Message{Raw: encoded, ThreadId: threadID}).Do()`

**RFC822 construction** (`gmail_mime.go`):
- Built from scratch, no external mail library
- Handles: From, To, Cc, Bcc, Reply-To, Subject, Date, Message-ID, MIME-Version
- Reply headers: In-Reply-To, References (from `fetchReplyInfo`)
- Body: `text/plain` | `text/html` | `multipart/alternative` (both)
- Attachments: `multipart/mixed` wrapping `multipart/alternative` + attachment parts
- Encoding: 7bit for text, base64 for attachments
- Subject encoding: RFC 2047 `=?UTF-8?B?...?=` when non-ASCII

**Reply flow**:
1. If `--reply-to-message-id`: fetch original message metadata (Message-ID, References, From, To, Cc, Reply-To)
2. If `--thread-id`: fetch thread, pick latest message
3. Set `In-Reply-To` and `References` headers
4. Set `ThreadId` on the sent message
5. If `--reply-all`: auto-populate To/Cc from original (RFC 5322: Reply-To > From)

**Send-as alias validation**: `svc.Users.Settings.SendAs.Get("me", fromEmail).Do()` - checks `verificationStatus == "accepted"`

**Tracking**: injects 1x1 pixel `<img>` before `</body>` in HTML body, generates encrypted tracking ID

**Flags**:
| Flag | Type | Description |
|------|------|-------------|
| `--to` | string | Recipients (comma-separated) |
| `--cc` | string | CC recipients |
| `--bcc` | string | BCC recipients |
| `--subject` | string | Subject (required) |
| `--body` | string | Plain text body |
| `--body-file` | string | Body from file (`-` for stdin) |
| `--body-html` | string | HTML body |
| `--reply-to-message-id` | string | Reply to message ID |
| `--thread-id` | string | Reply within thread |
| `--reply-all` | bool | Auto-populate recipients from original |
| `--reply-to` | string | Reply-To header |
| `--attach` | string[] | File paths (repeatable) |
| `--from` | string | Send-as alias |
| `--track` | bool | Enable open tracking |
| `--track-split` | bool | Separate sends per recipient for tracking |


### gmail thread get

**API**: `GET /gmail/v1/users/me/threads/{threadId}?format=full`

**Go call**: `svc.Users.Threads.Get("me", threadID).Format("full").Do()`

**Displays**: all messages in thread with headers, body (truncated to 500 chars unless `--full`), attachments

**Optional download**: for each message with attachments, calls:
`svc.Users.Messages.Attachments.Get("me", messageId, attachmentId).Do()`

**Attachment caching**: checks if file already exists at destination with matching size before downloading.

**Flags**:
| Flag | Description |
|------|-------------|
| `--download` | Download all attachments |
| `--full` | Show full message bodies (no truncation) |
| `--out-dir` | Output directory for attachments (default: current dir) |


### gmail thread modify

**API**: `POST /gmail/v1/users/me/threads/{threadId}/modify` with `{addLabelIds, removeLabelIds}`

**Go call**: `svc.Users.Threads.Modify("me", tid, &gmail.ModifyThreadRequest{AddLabelIds: addIDs, RemoveLabelIds: removeIDs}).Do()`

Labels are resolved from names to IDs first via `fetchLabelNameToID`.


### gmail labels list

**API**: `GET /gmail/v1/users/me/labels`

**Go call**: `svc.Users.Labels.List("me").Do()`

**Output**: `id`, `name`, `type` for each label. No pagination (returns all labels).


### gmail labels get

**API**: `GET /gmail/v1/users/me/labels/{labelId}`

**Go call**: `svc.Users.Labels.Get("me", id).Do()`

Resolves name to ID first if needed. Output includes message/thread counts.


### gmail labels create

**API**: `POST /gmail/v1/users/me/labels` with `{name, labelListVisibility: "labelShow", messageListVisibility: "show"}`

**Go call**: `svc.Users.Labels.Create("me", &gmail.Label{...}).Do()`

Pre-checks for duplicate names. Maps 409 Conflict errors to user-friendly messages.


### gmail labels modify

**API**: `POST /gmail/v1/users/me/threads/{threadId}/modify` (per thread)

Iterates over multiple thread IDs, modifying labels on each. Reports per-thread success/failure.


### gmail attachment

**API**: `GET /gmail/v1/users/me/messages/{messageId}/attachments/{attachmentId}`

**Go call**: `svc.Users.Messages.Attachments.Get("me", messageID, attachmentID).Do()`

Returns base64url-encoded data. Decoded and written to file.
Caches: skips download if file exists with matching size.

**Filename**: `{messageId}_{attachmentId[:8]}_{filename}` in attachments dir.


### gmail history

**API**: `GET /gmail/v1/users/me/history?startHistoryId={id}&maxResults={max}&historyTypes=messageAdded`

**Go call**: `svc.Users.History.List("me").StartHistoryId(id).MaxResults(max).HistoryTypes("messageAdded").Do()`

Returns message IDs that were added since the given history ID.


### gmail batch delete

**API**: `POST /gmail/v1/users/me/messages/batchDelete` with `{ids: [...]}`

**Go call**: `svc.Users.Messages.BatchDelete("me", &gmail.BatchDeleteMessagesRequest{Ids: ids}).Do()`

Single API call for multiple message IDs. Permanently deletes (not trash).


### gmail batch modify

**API**: `POST /gmail/v1/users/me/messages/batchModify` with `{ids, addLabelIds, removeLabelIds}`

**Go call**: `svc.Users.Messages.BatchModify("me", &gmail.BatchModifyMessagesRequest{...}).Do()`

Single API call. Resolves label names to IDs first.


### gmail drafts list

**API**: `GET /gmail/v1/users/me/drafts?maxResults={max}&pageToken={page}`

**Go call**: `svc.Users.Drafts.List("me").MaxResults(max).PageToken(page).Do()`

**Output**: `id`, `messageId`, `threadId` per draft. Supports pagination.


### gmail drafts get

**API**: `GET /gmail/v1/users/me/drafts/{draftId}?format=full`

**Go call**: `svc.Users.Drafts.Get("me", draftID).Format("full").Do()`

Shows headers, body, attachments. Optional `--download` for attachments.


### gmail drafts create

**API**: `POST /gmail/v1/users/me/drafts` with `{message: {raw: base64url(RFC822)}}`

**Go call**: `svc.Users.Drafts.Create("me", &gmail.Draft{Message: msg}).Do()`

Same RFC822 building as `send`, but `To` is optional (`allowMissingTo: true`).


### gmail drafts update

**API**: `PUT /gmail/v1/users/me/drafts/{draftId}` with `{id, message: {raw: base64url(RFC822)}}`

**Go call**: `svc.Users.Drafts.Update("me", draftID, &gmail.Draft{Id: draftID, Message: msg}).Do()`

Fetches existing draft first to preserve thread ID and To if not explicitly set.


### gmail drafts delete

**API**: `DELETE /gmail/v1/users/me/drafts/{draftId}`

**Go call**: `svc.Users.Drafts.Delete("me", draftID).Do()`

Requires confirmation (unless `--force`).


### gmail drafts send

**API**: `POST /gmail/v1/users/me/drafts/send` with `{id: draftId}`

**Go call**: `svc.Users.Drafts.Send("me", &gmail.Draft{Id: draftID}).Do()`


### gmail url

**API**: none (computed locally)

**Format**: `https://mail.google.com/mail/u/0/#inbox/{threadId}`


### gmail settings filters list/get/create/delete

**APIs**:
- `GET /gmail/v1/users/me/settings/filters`
- `GET /gmail/v1/users/me/settings/filters/{filterId}`
- `POST /gmail/v1/users/me/settings/filters`
- `DELETE /gmail/v1/users/me/settings/filters/{filterId}`

Create takes criteria (from, to, subject, query, hasAttachment) and actions (addLabel, removeLabel, archive, markRead, star, forward, trash, neverSpam, important).


### gmail settings delegates list/get/add/remove

**APIs**:
- `GET /gmail/v1/users/me/settings/delegates`
- `GET /gmail/v1/users/me/settings/delegates/{delegateEmail}`
- `POST /gmail/v1/users/me/settings/delegates`
- `DELETE /gmail/v1/users/me/settings/delegates/{delegateEmail}`


### gmail settings forwarding list/get/create/delete

**APIs**:
- `GET /gmail/v1/users/me/settings/forwardingAddresses`
- `GET /gmail/v1/users/me/settings/forwardingAddresses/{email}`
- `POST /gmail/v1/users/me/settings/forwardingAddresses`
- `DELETE /gmail/v1/users/me/settings/forwardingAddresses/{email}`


### gmail settings autoforward get/update

**APIs**:
- `GET /gmail/v1/users/me/settings/autoForwarding`
- `PUT /gmail/v1/users/me/settings/autoForwarding`

Update takes: enabled, emailAddress, disposition (leaveInInbox, archive, trash, markRead).


### gmail settings sendas list/get/create/verify/delete/update

**APIs**:
- `GET /gmail/v1/users/me/settings/sendAs`
- `GET /gmail/v1/users/me/settings/sendAs/{email}`
- `POST /gmail/v1/users/me/settings/sendAs`
- `POST /gmail/v1/users/me/settings/sendAs/{email}/verify`
- `DELETE /gmail/v1/users/me/settings/sendAs/{email}`
- `PUT /gmail/v1/users/me/settings/sendAs/{email}`


### gmail settings vacation get/update

**APIs**:
- `GET /gmail/v1/users/me/settings/vacation`
- `PUT /gmail/v1/users/me/settings/vacation`

Update takes: enableAutoReply, responseSubject, responseBodyHtml/PlainText, startTime, endTime, restrictToContacts, restrictToDomain.


### gmail settings watch start/status/renew/stop/serve

**APIs**:
- `POST /gmail/v1/users/me/watch` (start)
- `POST /gmail/v1/users/me/stop` (stop)
- Watch status stored locally in config file

**Serve** starts a local HTTP server that receives Pub/Sub push notifications. Decodes the notification, fetches new messages via History API, and optionally forwards to a webhook URL.


## Helpers to Reimplement

### Body extraction
Walk the MIME part tree recursively. Prefer `text/plain` > `text/html`. Decode `base64` / `quoted-printable`. Handle charset via `Content-Type; charset=...`.

### Attachment collection
Walk MIME parts. Any part with `body.attachmentId` is an attachment.

### Date formatting
Parse RFC 2822 dates, convert to target timezone, format as `YYYY-MM-DD HH:mm`.

### Email address parsing
Use `mail.ParseAddressList()` (Go) / `email-addresses` npm package. Fallback: manual comma-split + `<email>` extraction.

### CSV splitting
`splitCSV(s)`: split on comma, trim whitespace, filter empty strings.


## Testing Strategy

The Go tests use:
1. `httptest.NewServer` - fake HTTP server returning canned JSON
2. Real Google API client pointed at fake server (`option.WithEndpoint(srv.URL)`)
3. Service constructor swapped via package-level var
4. `captureStdout(t, fn)` to capture output
5. No mock libraries

**JS equivalent**:
```ts
// Use nock or msw to intercept HTTP requests
import nock from 'nock';
nock('https://gmail.googleapis.com')
  .get('/gmail/v1/users/me/threads')
  .query({ q: 'test', maxResults: '10' })
  .reply(200, { threads: [...], nextPageToken: 'abc' });
```


## Key Differences for JS Implementation

1. **No goroutines**: Use `Promise.all` + `p-limit` for concurrent fetching
2. **No tabwriter**: Use a table formatting library or simple string padding
3. **RFC822 building**: Use `nodemailer` or `mailcomposer` instead of building manually
4. **OAuth**: `googleapis` handles token refresh automatically with `OAuth2Client`
5. **Retry**: Use `gaxios` retry config or wrap with custom retry logic
6. **Body parsing**: `gmail` API returns base64url in JS too; use `Buffer.from(data, 'base64url')`
7. **Keyring**: Use `keytar` or OS-specific credential storage

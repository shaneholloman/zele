// Tests for reply recipient resolution.
// Fixtures are real-shaped Gmail API thread payloads run through the real
// GmailClient.parseThread(), so header parsing (Reply-To display names, address
// lists, draft labels) is exercised end to end. No mocks, no network.

import { OAuth2Client } from 'google-auth-library'
import { describe, expect, test } from 'vitest'
import { AmbiguousRecipientError, SelfRecipientError, UnseenLatestError } from './api-utils.js'
import { checkThreadLatestSeen, resolveReplyRecipients, threadAnchor } from './email-utils.js'
import { GmailClient } from './gmail-client.js'
import { ImapSmtpClient } from './imap-smtp-client.js'

const client = new GmailClient({ auth: new OAuth2Client() })

const ME = 'tommy@unframer.co'
const PEER = 'paul@terashift.net'

interface FixtureMessage {
  from: string
  to: string
  cc?: string
  replyTo?: string
  messageId?: string
  references?: string
  labelIds?: string[]
  subject?: string
}

/** Build a Gmail API thread payload from terse message descriptions. */
function thread(messages: FixtureMessage[]) {
  return {
    id: 'thread_1',
    messages: messages.map((m, i) => ({
      id: `msg_${i}`,
      threadId: 'thread_1',
      labelIds: m.labelIds ?? ['INBOX'],
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'subject', value: m.subject ?? 'Pricing question' },
          { name: 'from', value: m.from },
          { name: 'to', value: m.to },
          ...(m.cc ? [{ name: 'cc', value: m.cc }] : []),
          ...(m.replyTo ? [{ name: 'reply-to', value: m.replyTo }] : []),
          { name: 'message-id', value: m.messageId ?? `<msg-${i}@mail.example>` },
          ...(m.references ? [{ name: 'references', value: m.references }] : []),
          { name: 'date', value: `Tue, 10 Feb 2026 1${i}:00:00 +0000` },
        ],
      },
    })),
  }
}

function resolve(
  messages: FixtureMessage[],
  opts: {
    replyAll?: boolean
    explicitTo?: Array<{ email: string }>
    extraCc?: Array<{ email: string }>
    allowSelf?: boolean
    selfAddresses?: string[]
  } = {},
) {
  const parsed = client.parseThread(thread(messages) as any)
  return resolveReplyRecipients({
    messages: parsed.messages,
    selfAddresses: opts.selfAddresses ?? [ME],
    threadId: 'thread_1',
    replyAll: opts.replyAll,
    explicitTo: opts.explicitTo,
    extraCc: opts.extraCc,
    allowSelf: opts.allowSelf,
  })
}

/** Compact view for snapshots: source, recipients, and the threading anchor. */
function summarize(r: ReturnType<typeof resolve>) {
  if (r instanceof Error) return `${r.name}: ${r.message}`
  return {
    source: r.source,
    to: r.to.map((a) => a.email),
    cc: r.cc.map((a) => a.email),
    anchorMessageId: r.anchor.messageId,
    anchorFrom: r.anchor.from.email,
  }
}

describe('resolveReplyRecipients', () => {
  test('normal case: last message is from the peer', () => {
    const r = resolve([
      { from: `Me <${ME}>`, to: PEER },
      { from: `Paul <${PEER}>`, to: ME },
    ])
    expect(summarize(r)).toMatchInlineSnapshot(`
      {
        "anchorFrom": "paul@terashift.net",
        "anchorMessageId": "<msg-1@mail.example>",
        "cc": [],
        "source": "from",
        "to": [
          "paul@terashift.net",
        ],
      }
    `)
  })

  test('last message is one I sent to the peer: replies to the peer, not me', () => {
    const r = resolve([
      { from: `Paul <${PEER}>`, to: ME },
      { from: `Me <${ME}>`, to: `Paul <${PEER}>`, labelIds: ['SENT'] },
    ])
    expect(summarize(r)).toMatchInlineSnapshot(`
      {
        "anchorFrom": "tommy@unframer.co",
        "anchorMessageId": "<msg-1@mail.example>",
        "cc": [],
        "source": "recipients",
        "to": [
          "paul@terashift.net",
        ],
      }
    `)
  })

  test('last message is one I sent addressed to myself: falls back to previous sender', () => {
    const r = resolve([
      { from: `Paul <${PEER}>`, to: ME },
      { from: `Me <${ME}>`, to: `Me <${ME}>`, labelIds: ['SENT'] },
    ])
    expect(summarize(r)).toMatchInlineSnapshot(`
      {
        "anchorFrom": "tommy@unframer.co",
        "anchorMessageId": "<msg-1@mail.example>",
        "cc": [],
        "source": "previous-sender",
        "to": [
          "paul@terashift.net",
        ],
      }
    `)
  })

  test('thread with only my own self-addressed messages is refused', () => {
    const r = resolve([{ from: `Me <${ME}>`, to: ME, labelIds: ['SENT'] }])
    expect(r).toBeInstanceOf(SelfRecipientError)
    expect(summarize(r)).toMatchInlineSnapshot(`"SelfRecipientError: Refusing to reply: resolved recipient tommy@unframer.co is the sending account tommy@unframer.co. Pass --to <email> to override, or --allow-self to send anyway."`)
  })

  test('allow-self opts back into replying to my own address', () => {
    const r = resolve([{ from: `Me <${ME}>`, to: ME, labelIds: ['SENT'] }], { allowSelf: true })
    expect(summarize(r)).toMatchInlineSnapshot(`
      {
        "anchorFrom": "tommy@unframer.co",
        "anchorMessageId": "<msg-0@mail.example>",
        "cc": [],
        "source": "from",
        "to": [
          "tommy@unframer.co",
        ],
      }
    `)
  })

  test('allow-self does not override a resolvable external recipient', () => {
    const r = resolve([
      { from: `Paul <${PEER}>`, to: ME },
      { from: `Me <${ME}>`, to: PEER, labelIds: ['SENT'] },
    ], { allowSelf: true })
    expect(summarize(r)).toMatchInlineSnapshot(`
      {
        "anchorFrom": "tommy@unframer.co",
        "anchorMessageId": "<msg-1@mail.example>",
        "cc": [],
        "source": "recipients",
        "to": [
          "paul@terashift.net",
        ],
      }
    `)
  })

  test('allow-self never adds my address to inferred reply-all CC', () => {
    const r = resolve([
      { from: `Paul <${PEER}>`, to: `${ME}, dana@terashift.net`, cc: ME },
    ], { allowSelf: true, replyAll: true })
    expect(summarize(r)).toMatchInlineSnapshot(`
      {
        "anchorFrom": "paul@terashift.net",
        "anchorMessageId": "<msg-0@mail.example>",
        "cc": [
          "dana@terashift.net",
        ],
        "source": "from",
        "to": [
          "paul@terashift.net",
        ],
      }
    `)
  })

  test('Reply-To with a display name yields a bare address, not the raw header', () => {
    const r = resolve([{ from: `Notifications <noreply@terashift.net>`, to: ME, replyTo: `Paul Smith <${PEER}>` }])
    expect(summarize(r)).toMatchInlineSnapshot(`
      {
        "anchorFrom": "noreply@terashift.net",
        "anchorMessageId": "<msg-0@mail.example>",
        "cc": [],
        "source": "reply-to",
        "to": [
          "paul@terashift.net",
        ],
      }
    `)
  })

  test('multi-address Reply-To is split into separate recipients', () => {
    const r = resolve([
      { from: `noreply@terashift.net`, to: ME, replyTo: `${PEER}, sales@terashift.net` },
    ])
    expect(summarize(r)).toMatchInlineSnapshot(`
      {
        "anchorFrom": "noreply@terashift.net",
        "anchorMessageId": "<msg-0@mail.example>",
        "cc": [],
        "source": "reply-to",
        "to": [
          "paul@terashift.net",
          "sales@terashift.net",
        ],
      }
    `)
  })

  test('Reply-To pointing back at me is ignored in favour of the real recipients', () => {
    const r = resolve([
      { from: `Paul <${PEER}>`, to: ME },
      { from: `Me <${ME}>`, to: `Paul <${PEER}>`, replyTo: ME, labelIds: ['SENT'] },
    ])
    expect(summarize(r)).toMatchInlineSnapshot(`
      {
        "anchorFrom": "tommy@unframer.co",
        "anchorMessageId": "<msg-1@mail.example>",
        "cc": [],
        "source": "recipients",
        "to": [
          "paul@terashift.net",
        ],
      }
    `)
  })

  test('trailing draft never becomes the anchor', () => {
    const r = resolve([
      { from: `Paul <${PEER}>`, to: ME, messageId: '<real@mail.example>' },
      { from: `Me <${ME}>`, to: '', messageId: '', labelIds: ['DRAFT'] },
    ])
    expect(summarize(r)).toMatchInlineSnapshot(`
      {
        "anchorFrom": "paul@terashift.net",
        "anchorMessageId": "<real@mail.example>",
        "cc": [],
        "source": "from",
        "to": [
          "paul@terashift.net",
        ],
      }
    `)
  })

  test('reply-all CCs the other participants, excluding me and the To', () => {
    const r = resolve(
      [
        {
          from: `Paul <${PEER}>`,
          to: `${ME}, dana@terashift.net`,
          cc: `sam@acme.com, ${ME}`,
        },
      ],
      { replyAll: true },
    )
    expect(summarize(r)).toMatchInlineSnapshot(`
      {
        "anchorFrom": "paul@terashift.net",
        "anchorMessageId": "<msg-0@mail.example>",
        "cc": [
          "dana@terashift.net",
          "sam@acme.com",
        ],
        "source": "from",
        "to": [
          "paul@terashift.net",
        ],
      }
    `)
  })

  test('reply-all on a message I sent CCs the other recipients only', () => {
    const r = resolve(
      [
        { from: `Paul <${PEER}>`, to: ME },
        { from: `Me <${ME}>`, to: `${PEER}, dana@terashift.net`, labelIds: ['SENT'] },
      ],
      { replyAll: true },
    )
    expect(summarize(r)).toMatchInlineSnapshot(`
      {
        "anchorFrom": "tommy@unframer.co",
        "anchorMessageId": "<msg-1@mail.example>",
        "cc": [],
        "source": "recipients",
        "to": [
          "paul@terashift.net",
          "dana@terashift.net",
        ],
      }
    `)
  })

  test('explicit --to overrides inference and bypasses the self guard', () => {
    const r = resolve([{ from: `Me <${ME}>`, to: ME, labelIds: ['SENT'] }], {
      explicitTo: [{ email: PEER }],
    })
    expect(summarize(r)).toMatchInlineSnapshot(`
      {
        "anchorFrom": "tommy@unframer.co",
        "anchorMessageId": "<msg-0@mail.example>",
        "cc": [],
        "source": "explicit",
        "to": [
          "paul@terashift.net",
        ],
      }
    `)
  })

  test('explicit --cc is honored without --all', () => {
    const r = resolve([{ from: `Paul <${PEER}>`, to: `${ME}, dana@terashift.net` }], {
      extraCc: [{ email: 'sam@acme.com' }],
    })
    expect(summarize(r)).toMatchInlineSnapshot(`
      {
        "anchorFrom": "paul@terashift.net",
        "anchorMessageId": "<msg-0@mail.example>",
        "cc": [
          "sam@acme.com",
        ],
        "source": "from",
        "to": [
          "paul@terashift.net",
        ],
      }
    `)
  })

  test('send-as aliases count as me', () => {
    const r = resolve(
      [
        { from: `Paul <${PEER}>`, to: 'alias@unframer.co' },
        { from: `Alias <alias@unframer.co>`, to: `Paul <${PEER}>`, labelIds: ['SENT'] },
      ],
      { selfAddresses: [ME, 'alias@unframer.co'] },
    )
    expect(summarize(r)).toMatchInlineSnapshot(`
      {
        "anchorFrom": "alias@unframer.co",
        "anchorMessageId": "<msg-1@mail.example>",
        "cc": [],
        "source": "recipients",
        "to": [
          "paul@terashift.net",
        ],
      }
    `)
  })

  test('plus-aliases are treated as me by the safety guard', () => {
    const r = resolve([
      { from: `Paul <${PEER}>`, to: ME },
      { from: `Me <${ME}>`, to: 'tommy+prospects@unframer.co', labelIds: ['SENT'] },
    ])
    expect(summarize(r)).toMatchInlineSnapshot(`
      {
        "anchorFrom": "tommy@unframer.co",
        "anchorMessageId": "<msg-1@mail.example>",
        "cc": [],
        "source": "previous-sender",
        "to": [
          "paul@terashift.net",
        ],
      }
    `)
  })

  test('Gmail dotted variants are treated as me by the safety guard', () => {
    const r = resolve([
      { from: `Paul <${PEER}>`, to: 'tommy.dr@gmail.com' },
      { from: 'Me <tommy.dr@gmail.com>', to: 't.o.m.m.y.d.r+followup@googlemail.com', labelIds: ['SENT'] },
    ], { selfAddresses: ['tommydr@gmail.com'] })
    expect(summarize(r)).toMatchInlineSnapshot(`
      {
        "anchorFrom": "tommy.dr@gmail.com",
        "anchorMessageId": "<msg-1@mail.example>",
        "cc": [],
        "source": "previous-sender",
        "to": [
          "paul@terashift.net",
        ],
      }
    `)
  })

  test('draft-only thread has no reply anchor', () => {
    const parsed = client.parseThread(thread([
      { from: `Me <${ME}>`, to: PEER, messageId: '', labelIds: ['DRAFT'] },
    ]) as any)
    expect(threadAnchor(parsed.messages)).toBeUndefined()
  })

  test('IMAP preserves every Reply-To address and marks sent messages', () => {
    const imap = new ImapSmtpClient({
      credentials: {},
      account: {
        email: ME,
        appId: 'imap_smtp',
        accountType: 'imap_smtp',
        capabilities: [],
      },
    })
    const parsed = imap.parseImapMessage({
      message: {
        uid: 42,
        envelope: {
          from: [{ name: 'Alias', address: 'alias@unframer.co' }],
          to: [{ name: 'Paul', address: PEER }],
          replyTo: [
            { name: 'Paul', address: PEER },
            { name: 'Sales', address: 'sales@terashift.net' },
          ],
          messageId: '<imap-message@example.com>',
          subject: 'Pricing question',
        },
        flags: new Set(),
      } as any,
      folder: 'Sent',
      isSent: true,
    })

    const r = resolveReplyRecipients({
      messages: [parsed],
      selfAddresses: [ME, parsed.from.email],
      threadId: parsed.threadId,
    })
    expect({
      replyTo: parsed.replyTo,
      labels: parsed.labelIds,
      resolved: summarize(r),
    }).toMatchInlineSnapshot(`
      {
        "labels": [
          "SENT",
        ],
        "replyTo": ""Paul" <paul@terashift.net>, "Sales" <sales@terashift.net>",
        "resolved": {
          "anchorFrom": "alias@unframer.co",
          "anchorMessageId": "<imap-message@example.com>",
          "cc": [],
          "source": "reply-to",
          "to": [
            "paul@terashift.net",
            "sales@terashift.net",
          ],
        },
      }
    `)
  })

  test('empty-ish thread with no usable address is ambiguous', () => {
    const parsed = client.parseThread(thread([{ from: `Me <${ME}>`, to: ME }]) as any)
    const r = resolveReplyRecipients({
      messages: parsed.messages.map((m) => ({ ...m, from: { email: '' }, to: [] })),
      selfAddresses: [ME],
      threadId: 'thread_1',
    })
    expect(r).toBeInstanceOf(AmbiguousRecipientError)
  })
})

describe('checkThreadLatestSeen', () => {
  test('allows reply when the seen id matches the live last message', () => {
    const result = checkThreadLatestSeen({
      threadId: 'thread_1',
      lastMessageId: 'msg_2',
      seenMessageId: 'msg_2',
    })
    expect(result).toBeNull()
  })

  test('refuses reply when the thread was never read', () => {
    const result = checkThreadLatestSeen({
      threadId: 'thread_1',
      lastMessageId: 'msg_2',
      seenMessageId: null,
    })
    expect(result).toBeInstanceOf(UnseenLatestError)
    expect(result instanceof Error ? result.message : result).toMatchInlineSnapshot(`"Cannot reply to thread thread_1: latest message msg_2 was not read. Run: zele mail read thread_1"`)
  })

  test('refuses reply when a newer message arrived after the last read', () => {
    const result = checkThreadLatestSeen({
      threadId: 'thread_1',
      lastMessageId: 'msg_3',
      seenMessageId: 'msg_2',
    })
    expect(result).toBeInstanceOf(UnseenLatestError)
    expect(result instanceof Error ? result.message : result).toMatchInlineSnapshot(`"Cannot reply to thread thread_1: latest message msg_3 was not read. Run: zele mail read thread_1"`)
  })

  test('uses the last non-draft message id as the live latest', () => {
    const parsed = client.parseThread(thread([
      { from: `Paul <${PEER}>`, to: ME },
      { from: `Me <${ME}>`, to: PEER, labelIds: ['DRAFT'] },
    ]) as any)
    const last = threadAnchor(parsed.messages)
    expect(last?.id).toBe('msg_0')
    expect(checkThreadLatestSeen({
      threadId: parsed.id,
      lastMessageId: last!.id,
      seenMessageId: 'msg_0',
    })).toBeNull()
    expect(checkThreadLatestSeen({
      threadId: parsed.id,
      lastMessageId: last!.id,
      seenMessageId: 'msg_1',
    })).toBeInstanceOf(UnseenLatestError)
  })
})

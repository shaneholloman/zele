// Tests for GmailClient parsing behavior used by TUI previews.
// Captures entity/encoding regressions in snippet fields from Gmail metadata responses.

import { expect, test, describe } from 'vitest'
import { OAuth2Client } from 'google-auth-library'
import { GmailClient, parseAuthResults } from './gmail-client.js'

// Create a real client instance for testing (no account context needed for parsing tests)
const auth = new OAuth2Client()
const client = new GmailClient({ auth })

test('thread list snippet decodes HTML entities for TUI preview', () => {
  const rawThread = {
    id: 'thread_1',
    messages: [
      {
        snippet: 'It&#39;s ready &amp; waiting',
        payload: { headers: [{ name: 'subject', value: 'Status update' }, { name: 'from', value: 'News <news@example.com>' }, { name: 'date', value: 'Tue, 10 Feb 2026 12:00:00 +0000' }] },
        labelIds: ['INBOX'],
      },
    ],
  }

  const parsed = client.parseThreadListItem(rawThread as any)
  expect(parsed.snippet).toBe("It's ready & waiting")
})

test('message snippet decodes HTML entities for detail preview', () => {
  const rawMessage = {
    id: 'msg_1',
    threadId: 'thread_1',
    snippet: 'Built with Opus [4.6](https://4.6): you&#39;re in',
    payload: {
      headers: [
        { name: 'subject', value: 'Event update' },
        { name: 'from', value: 'Events <events@example.com>' },
        { name: 'to', value: 'user@example.com' },
        { name: 'date', value: 'Tue, 10 Feb 2026 12:00:00 +0000' },
      ],
      mimeType: 'text/plain',
      body: { data: Buffer.from('hello').toString('base64url') },
    },
    labelIds: ['INBOX'],
  }

  const parsed = client.parseMessage(rawMessage as any)
  expect(parsed.snippet).toBe("Built with Opus [4.6](https://4.6): you're in")
})

test('thread list snippet strips zero-width and preheader garbage', () => {
  const rawThread = {
    id: 'thread_2',
    messages: [
      {
        snippet: 'A host sent you a message\u034F\u200B\u200D\uFEFF',
        payload: { headers: [{ name: 'subject', value: 'Ping' }, { name: 'from', value: 'Host <host@example.com>' }, { name: 'date', value: 'Tue, 10 Feb 2026 12:00:00 +0000' }] },
        labelIds: ['INBOX'],
      },
    ],
  }

  const parsed = client.parseThreadListItem(rawThread as any)
  expect(parsed.snippet).toBe('A host sent you a message')
})

// ---------------------------------------------------------------------------
// parseAuthResults
// ---------------------------------------------------------------------------

describe('parseAuthResults', () => {
  test('parses standard Gmail Authentication-Results header', () => {
    const header = `mx.google.com;
       dkim=pass header.i=@example.com header.s=selector1;
       spf=pass (google.com: domain of user@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=user@example.com;
       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com`
    const result = parseAuthResults(header)
    expect(result).toMatchInlineSnapshot(`
      {
        "authentic": true,
        "dkim": "pass",
        "dmarc": "pass",
        "raw": "mx.google.com;
             dkim=pass header.i=@example.com header.s=selector1;
             spf=pass (google.com: domain of user@example.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=user@example.com;
             dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com",
        "spf": "pass",
      }
    `)
  })

  test('detects failed authentication', () => {
    const header = `mx.google.com;
       dkim=fail (bad signature) header.i=@spoofed.com;
       spf=softfail (google.com: domain transitioning) smtp.mailfrom=other.com;
       dmarc=fail (p=REJECT) header.from=spoofed.com`
    const result = parseAuthResults(header)
    expect(result).toMatchInlineSnapshot(`
      {
        "authentic": false,
        "dkim": "fail",
        "dmarc": "fail",
        "raw": "mx.google.com;
             dkim=fail (bad signature) header.i=@spoofed.com;
             spf=softfail (google.com: domain transitioning) smtp.mailfrom=other.com;
             dmarc=fail (p=REJECT) header.from=spoofed.com",
        "spf": "softfail",
      }
    `)
  })

  test('handles missing protocols gracefully', () => {
    const header = `mx.google.com; spf=pass smtp.mailfrom=user@example.com`
    const result = parseAuthResults(header)
    expect(result).toMatchInlineSnapshot(`
      {
        "authentic": false,
        "dkim": "none",
        "dmarc": "none",
        "raw": "mx.google.com; spf=pass smtp.mailfrom=user@example.com",
        "spf": "pass",
      }
    `)
  })

  test('handles bestguesspass for DMARC', () => {
    const header = `mx.google.com; dkim=pass header.i=@example.com; spf=pass; dmarc=bestguesspass header.from=example.com`
    const result = parseAuthResults(header)
    expect(result).toMatchInlineSnapshot(`
      {
        "authentic": false,
        "dkim": "pass",
        "dmarc": "bestguesspass",
        "raw": "mx.google.com; dkim=pass header.i=@example.com; spf=pass; dmarc=bestguesspass header.from=example.com",
        "spf": "pass",
      }
    `)
  })

  test('parseMessage includes auth for received messages', () => {
    const rawMessage = {
      id: 'msg_auth_1',
      threadId: 'thread_auth_1',
      snippet: 'Test',
      payload: {
        headers: [
          { name: 'Subject', value: 'Auth test' },
          { name: 'From', value: 'sender@example.com' },
          { name: 'To', value: 'me@example.com' },
          { name: 'Date', value: 'Wed, 25 Mar 2026 10:00:00 +0000' },
          { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@example.com; spf=pass; dmarc=pass (p=REJECT) header.from=example.com' },
        ],
        mimeType: 'text/plain',
        body: { data: Buffer.from('hello').toString('base64url') },
      },
      labelIds: ['INBOX'],
    }
    const parsed = client.parseMessage(rawMessage as any)
    expect(parsed.auth).toMatchInlineSnapshot(`
      {
        "authentic": true,
        "dkim": "pass",
        "dmarc": "pass",
        "raw": "mx.google.com; dkim=pass header.i=@example.com; spf=pass; dmarc=pass (p=REJECT) header.from=example.com",
        "spf": "pass",
      }
    `)
  })

  test('parseMessage prefers Gmail trusted header over upstream headers', () => {
    const rawMessage = {
      id: 'msg_multi_auth',
      threadId: 'thread_multi_auth',
      snippet: 'Multi-header',
      payload: {
        headers: [
          { name: 'Subject', value: 'Forwarded' },
          { name: 'From', value: 'sender@example.com' },
          { name: 'To', value: 'me@example.com' },
          { name: 'Date', value: 'Wed, 25 Mar 2026 10:00:00 +0000' },
          // Upstream relay header (untrusted, appears first)
          { name: 'Authentication-Results', value: 'relay.untrusted.com; dkim=fail; spf=fail; dmarc=fail' },
          // Gmail's trusted header (should be preferred)
          { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@example.com; spf=pass; dmarc=pass (p=REJECT)' },
        ],
        mimeType: 'text/plain',
        body: { data: Buffer.from('hello').toString('base64url') },
      },
      labelIds: ['INBOX'],
    }
    const parsed = client.parseMessage(rawMessage as any)
    expect(parsed.auth?.authentic).toBe(true)
    expect(parsed.auth?.spf).toBe('pass')
    expect(parsed.auth?.dkim).toBe('pass')
    expect(parsed.auth?.dmarc).toBe('pass')
  })

  test('parseMessage returns null auth for sent messages', () => {
    const rawMessage = {
      id: 'msg_sent_1',
      threadId: 'thread_sent_1',
      snippet: 'Sent',
      payload: {
        headers: [
          { name: 'Subject', value: 'Outgoing' },
          { name: 'From', value: 'me@example.com' },
          { name: 'To', value: 'other@example.com' },
          { name: 'Date', value: 'Wed, 25 Mar 2026 10:00:00 +0000' },
        ],
        mimeType: 'text/plain',
        body: { data: Buffer.from('hello').toString('base64url') },
      },
      labelIds: ['SENT'],
    }
    const parsed = client.parseMessage(rawMessage as any)
    expect(parsed.auth).toBeNull()
  })
})

// Tests for List-Unsubscribe / List-Unsubscribe-Post parsing and planning.
// Covers RFC 2369 header parsing, RFC 6068 mailto: decoding, and RFC 8058
// one-click detection. All tests are pure: no network, no mocks, no fixtures.

import { describe, expect, test } from 'vitest'
import {
  parseListUnsubscribeEntries,
  parseMailto,
  parseListUnsubscribePost,
  planUnsubscribe,
} from './unsubscribe.js'

describe('parseListUnsubscribeEntries', () => {
  test('single mailto', () => {
    expect(parseListUnsubscribeEntries('<mailto:unsub@example.com>')).toMatchInlineSnapshot(`
      [
        "mailto:unsub@example.com",
      ]
    `)
  })

  test('single https', () => {
    expect(parseListUnsubscribeEntries('<https://example.com/u/abc>')).toMatchInlineSnapshot(`
      [
        "https://example.com/u/abc",
      ]
    `)
  })

  test('RFC 8058 §8.2 complex example', () => {
    const header = `<mailto:listrequest@example.com?subject=unsubscribe>,
       <https://example.com/unsubscribe.html?opaque=123456789>`
    expect(parseListUnsubscribeEntries(header)).toMatchInlineSnapshot(`
      [
        "mailto:listrequest@example.com?subject=unsubscribe",
        "https://example.com/unsubscribe.html?opaque=123456789",
      ]
    `)
  })

  test('header with internal whitespace is tolerated', () => {
    const header = '<mailto:\n  a@b.com\n  >, <https://c.example/x>'
    expect(parseListUnsubscribeEntries(header)).toMatchInlineSnapshot(`
      [
        "mailto:a@b.com",
        "https://c.example/x",
      ]
    `)
  })

  test('malformed entries without angle brackets are dropped', () => {
    expect(parseListUnsubscribeEntries('mailto:a@b.com, <https://c/x>')).toMatchInlineSnapshot(`
      [
        "https://c/x",
      ]
    `)
  })

  test('empty header returns empty', () => {
    expect(parseListUnsubscribeEntries('')).toMatchInlineSnapshot(`[]`)
  })

  test('comma inside mailto query does not split', () => {
    const header = '<mailto:a@b.com?cc=x@y.com,z@w.com&subject=bye>'
    expect(parseListUnsubscribeEntries(header)).toMatchInlineSnapshot(`
      [
        "mailto:a@b.com?cc=x@y.com,z@w.com&subject=bye",
      ]
    `)
  })
})

describe('parseMailto', () => {
  test('plain mailto', () => {
    expect(parseMailto('mailto:unsub@example.com')).toMatchInlineSnapshot(`
      {
        "to": "unsub@example.com",
      }
    `)
  })

  test('mailto with subject', () => {
    expect(parseMailto('mailto:list@x.com?subject=unsubscribe')).toMatchInlineSnapshot(`
      {
        "subject": "unsubscribe",
        "to": "list@x.com",
      }
    `)
  })

  test('mailto with percent-encoded subject and body', () => {
    expect(
      parseMailto('mailto:list@x.com?subject=please%20remove&body=unsubscribe%20me'),
    ).toMatchInlineSnapshot(`
      {
        "body": "unsubscribe me",
        "subject": "please remove",
        "to": "list@x.com",
      }
    `)
  })

  test('mailto with cc list', () => {
    expect(parseMailto('mailto:a@b.com?cc=c@d.com,e@f.com')).toMatchInlineSnapshot(`
      {
        "cc": [
          "c@d.com",
          "e@f.com",
        ],
        "to": "a@b.com",
      }
    `)
  })

  test('mailto with plus-as-space in query', () => {
    expect(parseMailto('mailto:list@x.com?subject=please+remove')).toMatchInlineSnapshot(`
      {
        "subject": "please remove",
        "to": "list@x.com",
      }
    `)
  })

  test('non-mailto returns null', () => {
    expect(parseMailto('https://example.com')).toMatchInlineSnapshot(`null`)
  })

  test('mailto without target returns null', () => {
    expect(parseMailto('mailto:')).toMatchInlineSnapshot(`null`)
  })
})

describe('parseListUnsubscribePost', () => {
  test('canonical value', () => {
    expect(parseListUnsubscribePost('List-Unsubscribe=One-Click')).toMatchInlineSnapshot(`true`)
  })

  test('extra whitespace tolerated', () => {
    expect(parseListUnsubscribePost('  List-Unsubscribe = One-Click  ')).toMatchInlineSnapshot(
      `true`,
    )
  })

  test('case insensitive', () => {
    expect(parseListUnsubscribePost('list-unsubscribe=one-click')).toMatchInlineSnapshot(`true`)
  })

  test('wrong value', () => {
    expect(parseListUnsubscribePost('List-Unsubscribe=Two-Click')).toMatchInlineSnapshot(`false`)
  })

  test('undefined', () => {
    expect(parseListUnsubscribePost(undefined)).toMatchInlineSnapshot(`false`)
  })
})

describe('planUnsubscribe', () => {
  test('RFC 8058 §8.1 simple one-click', () => {
    const plan = planUnsubscribe({
      listUnsubscribe: '<https://example.com/unsubscribe/opaquepart>',
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
      dkimAuthentic: true,
    })
    expect(plan).toMatchInlineSnapshot(`
      {
        "dkimAuthentic": true,
        "hasOneClick": true,
        "mechanisms": [
          {
            "kind": "one-click",
            "url": "https://example.com/unsubscribe/opaquepart",
          },
        ],
        "warnings": [],
      }
    `)
  })

  test('RFC 8058 §8.2 complex: one-click + mailto', () => {
    const plan = planUnsubscribe({
      listUnsubscribe: `<mailto:listrequest@example.com?subject=unsubscribe>,
        <https://example.com/unsubscribe.html?opaque=123456789>`,
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
      dkimAuthentic: true,
    })
    expect(plan).toMatchInlineSnapshot(`
      {
        "dkimAuthentic": true,
        "hasOneClick": true,
        "mechanisms": [
          {
            "kind": "one-click",
            "url": "https://example.com/unsubscribe.html?opaque=123456789",
          },
          {
            "kind": "mailto",
            "mailto": {
              "subject": "unsubscribe",
              "to": "listrequest@example.com",
            },
          },
        ],
        "warnings": [],
      }
    `)
  })

  test('mailto only (no one-click)', () => {
    const plan = planUnsubscribe({
      listUnsubscribe: '<mailto:unsub@list.example.com?subject=unsubscribe>',
      listUnsubscribePost: undefined,
      dkimAuthentic: true,
    })
    expect(plan).toMatchInlineSnapshot(`
      {
        "dkimAuthentic": true,
        "hasOneClick": false,
        "mechanisms": [
          {
            "kind": "mailto",
            "mailto": {
              "subject": "unsubscribe",
              "to": "unsub@list.example.com",
            },
          },
        ],
        "warnings": [],
      }
    `)
  })

  test('legacy https landing page only (no Post header)', () => {
    const plan = planUnsubscribe({
      listUnsubscribe: '<https://example.com/unsubscribe?id=abc>',
      listUnsubscribePost: undefined,
      dkimAuthentic: true,
    })
    expect(plan).toMatchInlineSnapshot(`
      {
        "dkimAuthentic": true,
        "hasOneClick": false,
        "mechanisms": [
          {
            "kind": "url",
            "url": "https://example.com/unsubscribe?id=abc",
          },
        ],
        "warnings": [],
      }
    `)
  })

  test('no headers at all → empty plan', () => {
    const plan = planUnsubscribe({
      listUnsubscribe: undefined,
      listUnsubscribePost: undefined,
      dkimAuthentic: true,
    })
    expect(plan).toMatchInlineSnapshot(`
      {
        "dkimAuthentic": true,
        "hasOneClick": false,
        "mechanisms": [],
        "warnings": [],
      }
    `)
  })

  test('DKIM failed with one-click emits warning', () => {
    const plan = planUnsubscribe({
      listUnsubscribe: '<https://example.com/u/abc>',
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
      dkimAuthentic: false,
    })
    expect(plan).toMatchInlineSnapshot(`
      {
        "dkimAuthentic": false,
        "hasOneClick": true,
        "mechanisms": [
          {
            "kind": "one-click",
            "url": "https://example.com/u/abc",
          },
        ],
        "warnings": [
          "DKIM did not pass; one-click may be spoofed by an attacker",
        ],
      }
    `)
  })

  test('DKIM unknown with one-click emits warning', () => {
    const plan = planUnsubscribe({
      listUnsubscribe: '<https://example.com/u/abc>',
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
      dkimAuthentic: null,
    })
    expect(plan).toMatchInlineSnapshot(`
      {
        "dkimAuthentic": null,
        "hasOneClick": true,
        "mechanisms": [
          {
            "kind": "one-click",
            "url": "https://example.com/u/abc",
          },
        ],
        "warnings": [
          "DKIM status unknown (no authentication info on this message)",
        ],
      }
    `)
  })

  test('one-click Post header present but only http URL (no https)', () => {
    const plan = planUnsubscribe({
      listUnsubscribe: '<http://example.com/u/abc>',
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
      dkimAuthentic: true,
    })
    expect(plan).toMatchInlineSnapshot(`
      {
        "dkimAuthentic": true,
        "hasOneClick": false,
        "mechanisms": [
          {
            "kind": "url",
            "url": "http://example.com/u/abc",
          },
        ],
        "warnings": [
          "List-Unsubscribe-Post is present but no https URL (only http); RFC 8058 requires https",
        ],
      }
    `)
  })

  test('one-click with multiple https URLs (all are candidates)', () => {
    const plan = planUnsubscribe({
      listUnsubscribe: '<https://a.example/u>, <https://b.example/u>',
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
      dkimAuthentic: true,
    })
    expect(plan).toMatchInlineSnapshot(`
      {
        "dkimAuthentic": true,
        "hasOneClick": true,
        "mechanisms": [
          {
            "kind": "one-click",
            "url": "https://a.example/u",
          },
          {
            "kind": "one-click",
            "url": "https://b.example/u",
          },
        ],
        "warnings": [],
      }
    `)
  })
})

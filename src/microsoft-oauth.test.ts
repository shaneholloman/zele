// Microsoft OAuth helpers used for Outlook IMAP XOAUTH2.
// No network. Token parsing uses a hand-built JWT payload.

import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  MICROSOFT_CLIENT_ID,
  MICROSOFT_SCOPES,
  buildMicrosoftAuthUrl,
  createPkce,
  emailFromIdToken,
} from './microsoft-oauth.js'

function b64url(json: object) {
  return Buffer.from(JSON.stringify(json)).toString('base64url')
}

describe('createPkce', () => {
  test('verifier is S256 of challenge', () => {
    const { verifier, challenge } = createPkce()
    expect(verifier.length).toBeGreaterThanOrEqual(43)
    const expected = createHash('sha256').update(verifier).digest('base64url').replace(/=+$/, '')
    expect(challenge).toBe(expected)
  })
})

describe('buildMicrosoftAuthUrl', () => {
  test('includes Thunderbird client, IMAP SMTP scopes, and PKCE', () => {
    const url = new URL(
      buildMicrosoftAuthUrl({
        challenge: 'abc',
        redirectUri: 'http://localhost:8089',
        loginHint: 'atrox@outlook.it',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect(url.searchParams.get('client_id')).toBe(MICROSOFT_CLIENT_ID)
    expect(url.searchParams.get('code_challenge')).toBe('abc')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8089')
    expect(url.searchParams.get('login_hint')).toBe('atrox@outlook.it')
    const scope = url.searchParams.get('scope') ?? ''
    for (const item of MICROSOFT_SCOPES) {
      expect(scope).toContain(item)
    }
  })
})

describe('emailFromIdToken', () => {
  test('reads preferred_username', () => {
    const token = `e30.${b64url({ preferred_username: 'atrox@outlook.it' })}.sig`
    expect(emailFromIdToken(token)).toBe('atrox@outlook.it')
  })

  test('falls back to email then upn', () => {
    expect(emailFromIdToken(`e30.${b64url({ email: 'a@b.com' })}.sig`)).toBe('a@b.com')
    expect(emailFromIdToken(`e30.${b64url({ upn: 'c@d.com' })}.sig`)).toBe('c@d.com')
  })
})

import { describe, expect, test } from 'vitest'
import { extractCodeFromInput } from './oauth-callback-server.js'

describe('extractCodeFromInput', () => {
  test('reads code from a redirect URL', () => {
    expect(extractCodeFromInput('http://localhost:8089/?code=abc123def456&session_state=x')).toBe('abc123def456')
  })

  test('accepts a bare code with no spaces', () => {
    expect(extractCodeFromInput('  abc123def456  ')).toBe('abc123def456')
  })

  test('rejects short or spaced input', () => {
    expect(extractCodeFromInput('short')).toBeNull()
    expect(extractCodeFromInput('not a code string')).toBeNull()
  })
})

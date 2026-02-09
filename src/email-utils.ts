// Email address parsing utilities.
// Wraps the `email-addresses` package (RFC 5322 parser) with simpler return types.
// Ported from Zero's apps/server/src/lib/email-utils.ts.

import { parseFrom as _parseFrom, parseAddressList as _parseAddressList } from 'email-addresses'

export interface Sender {
  name?: string
  email: string
}

const FALLBACK_SENDER: Sender = {
  name: '',
  email: 'no-sender@unknown',
}

/**
 * Parse an RFC 5322 "From" header into a { name, email } object.
 * Handles edge cases like group addresses and missing names.
 */
export function parseFrom(fromHeader: string): Sender {
  const parsed = _parseFrom(fromHeader)
  if (!parsed) return FALLBACK_SENDER

  const first = parsed[0]
  if (!first) return FALLBACK_SENDER

  if (first.type === 'group') {
    const name = first.name || FALLBACK_SENDER.name
    const email = first.addresses?.[0]?.address || FALLBACK_SENDER.email
    return { name, email }
  }

  return {
    name: first.name || first.address,
    email: first.address || FALLBACK_SENDER.email,
  }
}

/**
 * Parse an RFC 5322 address list header (To, Cc, Bcc) into an array of { name, email }.
 * Handles group addresses by flattening them.
 * Returns empty array if the header cannot be parsed (never leaks fallback addresses).
 */
export function parseAddressList(header: string): Sender[] {
  const parsed = _parseAddressList(header)
  if (!parsed) return []

  return parsed.flatMap((address) => {
    if (address.type === 'group') {
      return (address.addresses || []).map((a) => ({
        name: a.name || FALLBACK_SENDER.name,
        email: a.address || FALLBACK_SENDER.email,
      }))
    }

    return {
      name: address.name || FALLBACK_SENDER.name,
      email: address.address || FALLBACK_SENDER.email,
    }
  })
}

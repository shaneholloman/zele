// Shared API utilities for Gmail and Calendar clients.
// Retry logic for rate limit errors and bounded concurrency helper.
// Extracted from gmail-client.ts to be reused across API clients.

const MAX_CONCURRENCY = 10

/** Run promises with bounded concurrency */
export async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency = MAX_CONCURRENCY,
): Promise<R[]> {
  const results: R[] = []
  let index = 0

  async function worker() {
    while (index < items.length) {
      const i = index++
      results[i] = await fn(items[i]!)
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

/** Simple retry for rate limit errors (429 and 403 quota errors).
 *  Matches Zero's gmail-rate-limit.ts schedule: up to 10 attempts, 60s base delay. */
export async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 10, delayMs = 60000): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err: any) {
      if (!isRateLimitError(err) || attempt === maxAttempts) throw err
      const wait = delayMs * Math.pow(2, attempt - 1)
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw new Error('unreachable')
}

export function isRateLimitError(err: any): boolean {
  const status = err?.code ?? err?.status ?? err?.response?.status
  if (status === 429) return true
  if (status === 403) {
    const errors = err?.errors ?? err?.response?.data?.error?.errors ?? []
    return errors.some((e: any) =>
      [
        'userRateLimitExceeded',
        'rateLimitExceeded',
        'quotaExceeded',
        'dailyLimitExceeded',
        'limitExceeded',
        'backendError',
      ].includes(e.reason),
    )
  }
  return false
}

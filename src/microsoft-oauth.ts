// Microsoft OAuth for Outlook.com / Hotmail / Microsoft 365 IMAP+SMTP.
// Consumer Outlook IMAP only accepts AUTH=XOAUTH2 (LOGIN is disabled).
// Client ID is Thunderbird's public desktop app, same pattern as Google login.

import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import fkill from 'fkill'
import { colors as pc } from 'goke'
import * as errore from 'errore'

export const MICROSOFT_CLIENT_ID = '9e5f94bc-e8a4-4e73-b8be-63364c29d753'
export const MICROSOFT_AUTH_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
export const MICROSOFT_TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
export const MICROSOFT_REDIRECT_PORT = 8089
export const MICROSOFT_SCOPES = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send',
  'offline_access',
  'openid',
  'email',
]

export interface MicrosoftOAuthTokens {
  accessToken: string
  refreshToken: string
  expiry: number
  clientId: string
  idToken?: string
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url').replace(/=+$/, '')
  return { verifier, challenge }
}

export function buildMicrosoftAuthUrl(opts: {
  challenge: string
  redirectUri: string
  loginHint?: string
}): string {
  const params = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    response_type: 'code',
    redirect_uri: opts.redirectUri,
    scope: MICROSOFT_SCOPES.join(' '),
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
    response_mode: 'query',
    prompt: 'select_account',
  })
  if (opts.loginHint) params.set('login_hint', opts.loginHint)
  return `${MICROSOFT_AUTH_ENDPOINT}?${params}`
}

export function emailFromIdToken(idToken: string): string | undefined {
  const payload = idToken.split('.')[1]
  if (!payload) return
  const parsed = errore.tryFn((): { preferred_username?: string; email?: string; upn?: string } =>
    JSON.parse(Buffer.from(payload, 'base64url').toString()),
  )
  if (parsed instanceof Error) return
  const value = parsed.preferred_username ?? parsed.email ?? parsed.upn
  return typeof value === 'string' ? value : undefined
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
  error?: string
  error_description?: string
}

function tokensFromResponse(json: TokenResponse, fallbackRefreshToken?: string): MicrosoftOAuthTokens | Error {
  if (json.error) {
    return new Error(json.error_description ?? json.error)
  }
  if (!json.access_token) {
    return new Error('Microsoft token response missing access token')
  }
  const refreshToken = json.refresh_token ?? fallbackRefreshToken
  if (!refreshToken) {
    return new Error('Microsoft token response missing refresh token')
  }
  return {
    accessToken: json.access_token,
    refreshToken,
    expiry: Date.now() + (json.expires_in ?? 3600) * 1000,
    clientId: MICROSOFT_CLIENT_ID,
    idToken: json.id_token,
  }
}

async function postToken(body: Record<string, string>): Promise<MicrosoftOAuthTokens | Error> {
  const res = await errore.tryAsync({
    try: () =>
      fetch(MICROSOFT_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
      }),
    catch: (err) => new Error('Microsoft token request failed', { cause: err }),
  })
  if (res instanceof Error) return res

  const json = await errore.tryAsync({
    try: async (): Promise<TokenResponse> => await res.json(),
    catch: (err) => new Error('Microsoft token response was not JSON', { cause: err }),
  })
  if (json instanceof Error) return json
  return tokensFromResponse(json, body.refresh_token)
}

export async function exchangeMicrosoftCode(opts: {
  code: string
  verifier: string
  redirectUri: string
}): Promise<MicrosoftOAuthTokens | Error> {
  return postToken({
    client_id: MICROSOFT_CLIENT_ID,
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
    scope: MICROSOFT_SCOPES.join(' '),
  })
}

export async function refreshMicrosoftToken(refreshToken: string): Promise<MicrosoftOAuthTokens | Error> {
  return postToken({
    client_id: MICROSOFT_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: MICROSOFT_SCOPES.join(' '),
  })
}

function openUrlInBrowser(url: string): Error | void {
  const command = process.platform === 'darwin'
    ? { bin: 'open', args: [url] }
    : process.platform === 'win32'
      ? { bin: 'cmd', args: ['/c', 'start', '', url] }
      : { bin: 'xdg-open', args: [url] }

  const child = errore.tryFn(() =>
    spawn(command.bin, command.args, { detached: true, stdio: 'ignore' }),
  )
  if (child instanceof Error) {
    return new Error(`Failed to open browser with ${command.bin}`, { cause: child })
  }
  child.unref()
}

export async function getMicrosoftAuthCode(opts: {
  authUrl: string
  port: number
  openBrowser?: boolean
}): Promise<string | Error> {
  const openBrowser = opts.openBrowser ?? true
  await fkill(`:${opts.port}`, { force: true, silent: true }).catch(() => {})

  console.error('\n' + pc.bold('1.') + ' Open this URL to authorize:\n')
  console.error('   ' + pc.cyan(pc.underline(opts.authUrl)) + '\n')
  console.error(pc.bold('2.') + ' If running locally, the browser will redirect automatically.')
  console.error(pc.dim('   If running remotely, copy the URL from the address bar and paste it below.') + '\n')

  if (openBrowser) {
    const openResult = openUrlInBrowser(opts.authUrl)
    if (openResult instanceof Error) {
      console.error(pc.yellow(`Could not auto-open browser: ${openResult.message}`))
    }
  }

  return new Promise((resolve) => {
    let resolved = false
    let server: http.Server | null = null
    let rl: readline.Interface | null = null

    function finish(value: string | Error) {
      if (resolved) return
      resolved = true
      if (server) {
        server.closeAllConnections()
        server.close()
      }
      if (rl) {
        rl.close()
        process.stdin.unref()
      }
      resolve(value)
    }

    server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${opts.port}`)
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' })
        res.end(`Authorization failed: ${error}`)
        finish(new Error(url.searchParams.get('error_description') ?? error))
        return
      }
      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('Login complete. You can close this tab.')
        finish(code)
        return
      }
      res.writeHead(400, { 'Content-Type': 'text/plain' })
      res.end('No authorization code received')
    })

    server.listen(opts.port)
    server.on('error', (err) => {
      finish(new Error(`Failed to start local auth callback server on port ${opts.port}`, { cause: err }))
    })

    if (process.stdin.isTTY) {
      rl = readline.createInterface({ input: process.stdin, output: process.stderr })
      rl.question(pc.dim('Paste redirect URL here (or wait for auto-redirect): '), (answer) => {
        const trimmed = answer.trim()
        const fromUrl = errore.tryFn(() => new URL(trimmed).searchParams.get('code'))
        const code = fromUrl instanceof Error ? (trimmed.length > 10 ? trimmed : null) : fromUrl
        if (code) finish(code)
        else console.error(pc.yellow('Could not extract authorization code from input.'))
      })
    }
  })
}

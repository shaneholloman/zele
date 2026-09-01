// Localhost OAuth callback server shared by Google and Microsoft login.
// Prints the authorize URL, opens a browser, and waits for ?code= on localhost.

import http from 'node:http'
import readline from 'node:readline'
import fkill from 'fkill'
import { colors as pc, openInBrowser } from 'goke'
import * as errore from 'errore'

export interface BrowserAuthOptions {
  openBrowser?: boolean
  allowManualCodeEntry?: boolean
  showInstructions?: boolean
  onAuthorizationUrl?: (url: string) => void
}

export function extractCodeFromInput(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const url = errore.tryFn(() => new URL(trimmed))
  if (!(url instanceof Error)) {
    const code = url.searchParams.get('code')
    if (code) return code
  }

  if (trimmed.length > 10 && !trimmed.includes(' ')) {
    return trimmed
  }

  return null
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function authCallbackHtml(options: {
  title: string
  message: string
  status: 'success' | 'error' | 'neutral'
  sectionTitle: string
  commands: Array<{ comment: string; command: string }>
}): string {
  const statusLabel = options.status === 'success'
    ? 'OK'
    : options.status === 'error'
      ? 'ERROR'
      : 'INFO'

  const commandsHtml = options.commands
    .map((c) =>
      `<span class="comment"># ${escapeHtml(c.comment)}</span>\n${escapeHtml(c.command)}`,
    )
    .join('\n\n')

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${escapeHtml(options.title)}</title>
    <style>
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }
      :root {
        --bg: #fff;
        --fg: #111;
        --muted: #444;
        --panel: #fafafa;
        --chip: #f5f5f5;
        --border: #eee;
        --comment: #888;
        --accent: #2563eb;
      }
      body {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
          'Helvetica Neue', Arial, sans-serif;
        background: radial-gradient(1200px 600px at 50% -10%, rgba(37, 99, 235, 0.08), transparent 60%),
          var(--bg);
        color: var(--fg);
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1.25rem;
        line-height: 1.6;
      }
      .container {
        max-width: 560px;
        width: 100%;
        text-align: center;
      }
      .status {
        display: inline-flex;
        gap: 0.5rem;
        align-items: center;
        justify-content: center;
        font-family: 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace;
        font-size: 0.75rem;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--muted);
        background: var(--chip);
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 0.25rem 0.6rem;
        margin: 0 auto 0.9rem;
        width: fit-content;
      }
      .dot {
        width: 8px;
        height: 8px;
        border-radius: 999px;
        background: var(--accent);
      }
      h1 {
        font-size: 1.6rem;
        font-weight: 650;
        margin-bottom: 0.75rem;
        letter-spacing: -0.02em;
      }
      p {
        color: var(--muted);
        margin-bottom: 1.25rem;
      }
      .section {
        margin-top: 1.75rem;
        padding-top: 1.75rem;
        border-top: 1px solid var(--border);
      }
      .section-title {
        font-size: 0.75rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #888;
        margin-bottom: 1rem;
      }
      pre {
        font-family: 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace;
        font-size: 0.8125rem;
        background: var(--panel);
        margin-left: -1rem;
        margin-right: -1rem;
        padding: 0.85rem 1rem;
        overflow-x: auto;
        line-height: 1.75;
        text-align: left;
        border-radius: 12px;
        border: 1px solid var(--border);
      }
      code {
        font-family: inherit;
      }
      .comment {
        color: var(--comment);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0f0f10;
          --fg: #eee;
          --muted: #aaa;
          --panel: #171718;
          --chip: #1b1b1c;
          --border: #2a2a2b;
          --comment: #666;
          --accent: #60a5fa;
        }
        body {
          background: radial-gradient(1200px 600px at 50% -10%, rgba(96, 165, 250, 0.16), transparent 60%),
            var(--bg);
        }
        .section-title {
          color: #777;
        }
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="status"><span class="dot"></span>${escapeHtml(statusLabel)}</div>
      <h1>${escapeHtml(options.title)}</h1>
      <p>${escapeHtml(options.message)}</p>
      <div class="section">
        <div class="section-title">${escapeHtml(options.sectionTitle)}</div>
        <pre><code>${commandsHtml}</code></pre>
      </div>
    </div>
  </body>
</html>`
}

export async function waitForOAuthCode(opts: {
  authUrl: string
  port: number
  loginCommand: string
  provider: string
  openBrowser?: boolean
  allowManualCodeEntry?: boolean
  showInstructions?: boolean
  onAuthorizationUrl?: (url: string) => void
}): Promise<string | Error> {
  const openBrowser = opts.openBrowser ?? true
  const allowManualCodeEntry = opts.allowManualCodeEntry ?? true
  const showInstructions = opts.showInstructions ?? true

  await fkill(`:${opts.port}`, { force: true, silent: true }).catch(() => {})
  opts.onAuthorizationUrl?.(opts.authUrl)

  if (showInstructions) {
    console.error('\n' + pc.bold('1.') + ' Open this URL to authorize:\n')
    console.error('   ' + pc.cyan(pc.underline(opts.authUrl)) + '\n')
    console.error(pc.bold('2.') + ' If running locally, the browser will redirect automatically.')
    console.error(pc.dim('   If running remotely, the redirect page won\'t load — that\'s fine.'))
    console.error(pc.dim('   Just copy the URL from your browser\'s address bar and paste it below.') + '\n')
  }

  if (openBrowser) await openInBrowser(opts.authUrl)

  return new Promise((resolve) => {
    let resolved = false
    let server: http.Server | null = null
    let rl: readline.Interface | null = null

    function closeServer() {
      if (server) {
        server.closeAllConnections()
        server.close()
      }
    }

    function finish(code: string) {
      if (resolved) return
      resolved = true
      closeServer()
      if (rl) {
        rl.close()
        process.stdin.unref()
      }
      resolve(code)
    }

    function fail(err: Error) {
      if (resolved) return
      resolved = true
      closeServer()
      rl?.close()
      resolve(err)
    }

    server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${opts.port}`)
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(
          authCallbackHtml({
            title: 'Authorization failed',
            message: `${opts.provider} returned: ${error}`,
            status: 'error',
            sectionTitle: 'Try again',
            commands: [
              { comment: 'Start login again', command: opts.loginCommand },
              {
                comment: 'If running remotely, copy the full redirect URL',
                command: '# ...and paste it into the terminal prompt',
              },
            ],
          }),
        )
        fail(new Error(url.searchParams.get('error_description') ?? error))
        return
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          authCallbackHtml({
            title: 'Login complete',
            message: 'You can close this tab and go back to the terminal.',
            status: 'success',
            sectionTitle: 'Next steps',
            commands: [
              { comment: 'Plan: open the TUI to read your emails', command: 'zele' },
              { comment: 'Plan: list your latest threads', command: 'zele mail list' },
              { comment: 'Plan: search mail', command: 'zele mail search "from:github"' },
            ],
          }),
        )
        finish(code)
        return
      }

      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end(
        authCallbackHtml({
          title: 'No authorization code received',
          message: 'This page was opened without the OAuth "code" parameter.',
          status: 'neutral',
          sectionTitle: 'What to do',
          commands: [
            { comment: 'Restart login and try again', command: opts.loginCommand },
            {
              comment: 'If the browser can’t reach localhost, that’s fine',
              command: '# Copy the redirect URL from the address bar and paste it into the terminal',
            },
          ],
        }),
      )
    })

    server.listen(opts.port)
    server.on('error', (err) => {
      fail(new Error(`Failed to start local auth callback server on port ${opts.port}`, { cause: err }))
    })

    if (allowManualCodeEntry && process.stdin.isTTY) {
      rl = readline.createInterface({ input: process.stdin, output: process.stderr })
      rl.question(pc.dim('Paste redirect URL here (or wait for auto-redirect): '), (answer) => {
        const code = extractCodeFromInput(answer)
        if (code) {
          finish(code)
        } else {
          console.error(pc.yellow('Could not extract authorization code from input.'))
          console.error(pc.dim('Waiting for browser redirect...'))
        }
      })
    }
  })
}

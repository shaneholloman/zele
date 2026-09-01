import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import * as errore from 'errore'
import { extractCodeFromInput } from './oauth-callback-server.js'

const execFileAsync = promisify(execFile)
const cleanupPids: number[] = []
const cleanupDirs: string[] = []

afterEach(() => {
  for (const pid of cleanupPids.splice(0)) {
    errore.tryFn(() => process.kill(pid, 'SIGTERM'))
  }
  for (const directory of cleanupDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('agent login prints the OAuth URL before returning', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zele-agent-login-'))
  cleanupDirs.push(home)

  const result = await execFileAsync('bun', ['src/cli.ts', 'login', '--method', 'microsoft'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: { ...process.env, HOME: home, AI_AGENT: 'opencode' },
    timeout: 15_000,
  })

  expect(result.stderr).toContain('Open this URL to authorize:')
  expect(result.stderr).toContain('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?')
  expect(result.stderr).toContain('Login running in background.')

  const pidFile = path.join(home, '.config', 'goke', 'daemons', 'zele--login.pid.json')
  const daemon = JSON.parse(fs.readFileSync(pidFile, 'utf8')) as { pid: number }
  cleanupPids.push(daemon.pid)
  expect(errore.tryFn(() => process.kill(daemon.pid, 0))).toBe(true)
})

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

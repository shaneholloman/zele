// E2E test for the mail TUI mailbox folder switching.
// Uses tuistory to launch the TUI via termcast dev and verify folder filter actions.

import path from 'path'
import { test, expect, afterEach } from 'vitest'
import { launchTerminal, type TerminalSession } from 'tuistory'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')

let session: TerminalSession

afterEach(() => {
  session?.close()
})

/**
 * Navigate down in the actions panel until the cursor line contains the target text.
 * Returns true if found, false if we hit maxSteps without finding it.
 */
async function navigateToAction(
  session: TerminalSession,
  target: string,
  maxSteps = 25,
): Promise<boolean> {
  for (let i = 0; i < maxSteps; i++) {
    const text = await session.text({ trimEnd: true })
    // tuistory renders the cursor line with › prefix
    const lines = text.split('\n')
    const cursorLine = lines.find((l) => l.includes('›') && l.includes(target))
    if (cursorLine) return true
    await session.press('down')
  }
  return false
}

/**
 * Extract just the visible portion of the actions panel overlay from a terminal snapshot.
 * Strips the background list content and returns only action items.
 */
function extractActionsPanel(text: string): string {
  const lines = text.split('\n')
  const panelLines: string[] = []
  let inPanel = false
  for (const line of lines) {
    if (line.includes('Actions') && line.includes('esc')) inPanel = true
    if (inPanel) {
      // Extract the content between the box-drawing borders
      const match = line.match(/│\s*(.*?)\s*│/)
      if (match) {
        panelLines.push(match[1]!.trimEnd())
      }
    }
    if (inPanel && line.includes('╰')) break
  }
  return panelLines.filter((l) => l.length > 0).join('\n')
}

test('mailbox folder filter switches between folders', async () => {
  session = await launchTerminal({
    command: 'termcast',
    args: ['dev'],
    cols: 120,
    rows: 36,
    cwd: PROJECT_ROOT,
  })

  // Wait for the TUI to render with inbox
  await session.waitForText('Search', { timeout: 20000 })
  const initialScreen = await session.text({ trimEnd: true })
  expect(initialScreen).toContain('Search Inbox...')

  // Open actions panel and navigate to "Sent" action
  await session.press(['ctrl', 'k'])
  await session.waitForText('Actions', { timeout: 5000 })

  const foundSent = await navigateToAction(session, 'Sent')
  expect(foundSent).toBe(true)

  // Snapshot the actions panel with cursor on Sent
  const actionsWithSent = extractActionsPanel(await session.text({ trimEnd: true }))
  expect(actionsWithSent).toMatchInlineSnapshot(`
    "Actions                                                          esc
    > Search actions...
    Copy Thread ID
    Copy Subject
    Copy Sender Email
    ⌧ Trash                                                 ⌃BACKSPACE
    Mailbox                                                             ▀
    ✓ Inbox
    ›○ Sent
    ○ Starred
    ○ Drafts
    ↵ select   ↑↓ navigate"
  `)

  await session.press('enter')

  // Verify the screen updated to Sent folder
  await session.waitForText('Search Sent', { timeout: 15000 })
  const sentScreen = await session.text({ trimEnd: true })
  expect(sentScreen).toContain('Search Sent...')

  // Now switch back to Inbox via actions panel
  await session.press(['ctrl', 'k'])
  await session.waitForText('Actions', { timeout: 5000 })

  const foundInbox = await navigateToAction(session, 'Inbox')
  expect(foundInbox).toBe(true)

  // Snapshot the actions panel with cursor on Inbox (should show checkmark on Sent now)
  const actionsWithInbox = extractActionsPanel(await session.text({ trimEnd: true }))
  expect(actionsWithInbox).toMatchInlineSnapshot(`
    "Actions                                                          esc
    > Search actions...
    Copy Thread ID
    Copy Subject
    Copy Sender Email
    ⌧ Trash                                                 ⌃BACKSPACE
    Mailbox                                                             ▀
    ›○ Inbox
    ✓ Sent
    ○ Starred
    ○ Drafts
    ↵ select   ↑↓ navigate"
  `)

  await session.press('enter')

  // Verify switched back to Inbox
  await session.waitForText('Search Inbox', { timeout: 15000 })
  const inboxScreen = await session.text({ trimEnd: true })
  expect(inboxScreen).toContain('Search Inbox...')
}, 60000)

test('actions panel lists mailbox folder options', async () => {
  session = await launchTerminal({
    command: 'termcast',
    args: ['dev'],
    cols: 120,
    rows: 36,
    cwd: PROJECT_ROOT,
  })

  await session.waitForText('Search', { timeout: 20000 })

  // Open actions panel
  await session.press(['ctrl', 'k'])
  await session.waitForText('Actions', { timeout: 5000 })

  // Navigate down to Mailbox section
  const foundStarred = await navigateToAction(session, 'Starred')
  expect(foundStarred).toBe(true)

  // Snapshot the Mailbox section visible in the actions panel
  const actionsText = extractActionsPanel(await session.text({ trimEnd: true }))
  expect(actionsText).toMatchInlineSnapshot(`
    "Actions                                                          esc
    > Search actions...
    Copy Thread ID
    Copy Subject
    Copy Sender Email
    ⌧ Trash                                                 ⌃BACKSPACE
    Mailbox                                                             ▀
    ✓ Inbox
    ○ Sent
    ›○ Starred
    ○ Drafts
    ↵ select   ↑↓ navigate"
  `)
}, 30000)

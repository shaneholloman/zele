// Attachment commands: list, get (download).
// Lists attachments for a message and downloads them to disk.
// Skips re-download if file already exists with same size (like gogcli).

import type { Goke } from 'goke'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import { getClient } from '../auth.js'
import { GmailClient } from '../gmail-client.js'
import * as out from '../output.js'
import { handleCommandError } from '../output.js'

export function registerAttachmentCommands(cli: Goke) {
  // =========================================================================
  // attachment list
  // =========================================================================

  cli
    .command('attachment list <messageId>', 'List attachments for a message')
    .action(async (messageId, options) => {
      const { client } = await getClient(options.account)

      const msg = await client.getMessage({ messageId })
      if (msg instanceof Error) return handleCommandError(msg)
      if ('raw' in msg) {
        out.error('Cannot list attachments for raw messages')
        process.exit(1)
      }

      const attachments = msg.attachments

      if (attachments.length === 0) {
        out.hint('No attachments')
        return
      }

      out.printList(
        attachments.map((a) => ({
          attachment_id: a.attachmentId,
          filename: a.filename,
          type: a.mimeType,
          size: formatSize(a.size),
        })),
      )

      out.hint(`${attachments.length} attachment(s)`)
    })

  // =========================================================================
  // attachment get
  // =========================================================================

  cli
    .command('attachment get <messageId> <attachmentId>', 'Download an attachment')
    .option('--out-dir <outDir>', z.string().default('.').describe('Output directory'))
    .option('--filename <filename>', z.string().describe('Override filename'))
    .action(async (messageId, attachmentId, options) => {
      const { client } = await getClient(options.account)

      // Get attachment metadata first
      const msg = await client.getMessage({ messageId })
      if (msg instanceof Error) return handleCommandError(msg)
      if ('raw' in msg) {
        out.error('Cannot get attachments for raw messages')
        process.exit(1)
      }

      const meta = msg.attachments.find((a) => a.attachmentId === attachmentId)
      const filename = options.filename ?? meta?.filename ?? `${messageId}_${attachmentId.slice(0, 8)}`

      const outPath = path.resolve(options.outDir, filename)

      // Check if file already exists with same size (skip re-download)
      if (fs.existsSync(outPath) && meta) {
        const stat = fs.statSync(outPath)
        if (stat.size === meta.size) {
          out.printYaml({ path: outPath, cached: true, size: stat.size })
          out.hint(`Cached: ${outPath}`)
          return
        }
      }

      // Download
      const base64Data = await client.getAttachment({ messageId, attachmentId })
      const buffer = Buffer.from(base64Data, 'base64')

      // Ensure output directory exists
      const dir = path.dirname(outPath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }

      fs.writeFileSync(outPath, buffer)

      out.printYaml({ path: outPath, cached: false, size: buffer.length })
      out.success(`Saved: ${outPath} (${formatSize(buffer.length)})`)
    })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

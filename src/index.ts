// Library entry for zele. The CLI stays in cli.ts.
// Apps import this module for accounts, threads, markdown bodies, and mutations.

export {
  listAccounts,
  getClients,
  getClient,
  login,
  logout,
  type AccountId,
  type AccountType,
  type AccountCapability,
  type ClientEntry,
  type AuthStatus,
  getAuthStatuses,
} from './auth.js'

export {
  GmailClient,
  type ThreadListItem,
  type ThreadData,
  type ThreadListResult,
  type ParsedMessage,
  type AttachmentMeta,
  type Sender,
} from './gmail-client.js'

export { ImapSmtpClient } from './imap-smtp-client.js'

export {
  htmlToMarkdown,
  renderEmailBody,
  formatDate,
  formatSender,
  replyParser,
} from './output.js'

export { getThreadSeenMessageId, setThreadSeenMessageId, closeDb } from './db.js'

export {
  MAIL_FOLDERS,
  listMailThreads,
  readMailThread,
  messageToMarkdown,
  archiveMail,
  starMail,
  unstarMail,
  trashMail,
  markMailRead,
  markMailUnread,
  replyMail,
  getMailAttachment,
  type MailFolder,
  type ListedThread,
  type ReadThread,
} from './mail-api.js'

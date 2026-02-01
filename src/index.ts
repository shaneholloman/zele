import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { OAuth2Client } from 'google-auth-library'
import { google } from 'googleapis'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const CONFIG = {
  clientId: '406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com',
  clientSecret: 'kSmqreRr0qwBWJgbf5Y-PjSU',
  redirectPort: 8089,
  scope: 'https://mail.google.com/',
  tokensFile: path.join(__dirname, '..', 'tokens.json'),
}

function createOAuth2Client(): OAuth2Client {
  return new OAuth2Client({
    clientId: CONFIG.clientId,
    clientSecret: CONFIG.clientSecret,
    redirectUri: `http://localhost:${CONFIG.redirectPort}`,
  })
}

async function getAuthCodeFromBrowser(oauth2Client: OAuth2Client): Promise<string> {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [CONFIG.scope],
    prompt: 'consent', // force refresh token
  })

  console.log('\nOpen this URL to authorize:\n')
  console.log(authUrl)
  console.log('\nWaiting for authorization...\n')

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${CONFIG.redirectPort}`)
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(`<h1>Error: ${error}</h1>`)
        server.close()
        reject(new Error(error))
        return
      }

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<h1>Success! You can close this window.</h1>')
        server.close()
        resolve(code)
        return
      }

      res.writeHead(400, { 'Content-Type': 'text/html' })
      res.end('<h1>No authorization code received</h1>')
    })

    server.listen(CONFIG.redirectPort, () => {
      console.log(`Listening on http://localhost:${CONFIG.redirectPort}`)
    })

    server.on('error', reject)
  })
}

function saveTokens(tokens: object): void {
  fs.writeFileSync(CONFIG.tokensFile, JSON.stringify(tokens, null, 2))
  console.log('Tokens saved to', CONFIG.tokensFile)
}

function loadTokens(): object | null {
  if (fs.existsSync(CONFIG.tokensFile)) {
    const data = fs.readFileSync(CONFIG.tokensFile, 'utf-8')
    return JSON.parse(data)
  }
  return null
}

async function authenticate(): Promise<OAuth2Client> {
  const oauth2Client = createOAuth2Client()

  const existingTokens = loadTokens()
  if (existingTokens) {
    console.log('Using existing tokens from', CONFIG.tokensFile)
    oauth2Client.setCredentials(existingTokens)

    // refresh if expired
    const tokenInfo = oauth2Client.credentials
    if (tokenInfo.expiry_date && tokenInfo.expiry_date < Date.now()) {
      console.log('Token expired, refreshing...')
      const { credentials } = await oauth2Client.refreshAccessToken()
      oauth2Client.setCredentials(credentials)
      saveTokens(credentials)
    }

    return oauth2Client
  }

  // no tokens, start OAuth flow
  const code = await getAuthCodeFromBrowser(oauth2Client)
  console.log('Got authorization code, exchanging for tokens...')

  const { tokens } = await oauth2Client.getToken(code)
  oauth2Client.setCredentials(tokens)
  saveTokens(tokens)

  return oauth2Client
}

async function listEmails(auth: OAuth2Client): Promise<void> {
  const gmail = google.gmail({ version: 'v1', auth })

  console.log('\nFetching emails...\n')

  const res = await gmail.users.messages.list({
    userId: 'me',
    maxResults: 10,
  })

  const messages = res.data.messages || []

  if (messages.length === 0) {
    console.log('No messages found.')
    return
  }

  console.log(`Found ${messages.length} messages:\n`)

  for (const msg of messages) {
    const detail = await gmail.users.messages.get({
      userId: 'me',
      id: msg.id!,
      format: 'metadata',
      metadataHeaders: ['Subject', 'From', 'Date'],
    })

    const headers = detail.data.payload?.headers || []
    const subject = headers.find((h) => h.name === 'Subject')?.value || '(no subject)'
    const from = headers.find((h) => h.name === 'From')?.value || '(unknown)'
    const date = headers.find((h) => h.name === 'Date')?.value || ''

    console.log(`- ${subject}`)
    console.log(`  From: ${from}`)
    console.log(`  Date: ${date}`)
    console.log()
  }
}

async function main(): Promise<void> {
  try {
    const auth = await authenticate()
    await listEmails(auth)
  } catch (error) {
    console.error('Error:', error)
    process.exit(1)
  }
}

main()

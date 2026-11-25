// Test setup: a separate database (buysun_test), a fake Bitrix24 and a fake
// mail transport. Needs the dev Postgres: docker compose -f docker-compose.dev.yml up -d
const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { loadConfig } = require('../src/config')
const { createApp } = require('../src/app')
const { createPrisma } = require('../src/services/prisma')
const { createStorage } = require('../src/services/storage')
const { createBitrix } = require('../src/services/bitrix')
const { createMailer } = require('../src/services/mailer')
const { createDelivery } = require('../src/services/delivery')
const { createGoogleDrive } = require('../src/services/googleDrive')

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL || 'postgresql://buysun:buysun@localhost:5433/postgres'
const TEST_URL = process.env.TEST_DATABASE_URL || 'postgresql://buysun:buysun@localhost:5433/buysun_test'
const SITE = 'https://buysun.kz'

let prepared = false
async function prepareDatabase() {
  if (prepared) return
  const admin = createPrisma(ADMIN_URL)
  const exists = await admin.$queryRaw`SELECT 1 FROM pg_database WHERE datname = 'buysun_test'`
  if (exists.length === 0) await admin.$executeRawUnsafe('CREATE DATABASE buysun_test')
  await admin.$disconnect()
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATABASE_URL: TEST_URL },
    stdio: 'pipe',
  })
  prepared = true
}

// Fake Bitrix24: records every call; `handlers[method]` can override answers
function startFakeBitrix() {
  const calls = []
  const handlers = {}
  let nextLeadId = 100
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      const method = req.url.split('/').pop().replace(/\.json$/, '')
      const params = JSON.parse(body || '{}')
      calls.push({ method, params })
      const custom = await handlers[method]?.(params) // may wait, like a slow Bitrix24
      const answer = custom || (
        method === 'crm.lead.add' ? { status: 200, body: { result: nextLeadId++ } }
          : method === 'crm.duplicate.findbycomm' ? { status: 200, body: { result: [] } }
            : { status: 200, body: { result: true } })
      res.writeHead(answer.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(answer.body))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}/rest/1/secret`, calls, handlers, close: () => server.close() })
  }))
}

// Fake Google: OAuth (token, userinfo, revoke) and the Drive calls the site
// makes. `files` is the Drive; deleting from it plays a manager who deleted a
// folder by hand. `fail.refresh` answers invalid_grant (access revoked).
function startFakeGoogle() {
  const files = new Map()
  const calls = []
  const fail = { refresh: false }
  let next = 1
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const url = new URL(req.url, 'http://x')
      const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
      calls.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || '' })
      if (url.pathname === '/token') {
        const form = new URLSearchParams(body.toString())
        if (form.get('grant_type') === 'authorization_code') {
          if (form.get('code') !== 'good-code') return send(400, { error: 'invalid_grant' })
          return send(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, scope: 'openid email https://www.googleapis.com/auth/drive.file' })
        }
        if (fail.refresh) return send(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
        return send(200, { access_token: `access-${next++}`, expires_in: 3600 })
      }
      if (url.pathname === '/userinfo') return send(200, { email: 'buysun@gmail.com' })
      if (url.pathname === '/revoke') return send(200, {})
      const missing = (id) => id && !files.has(id)
      if (url.pathname === '/api/files' && req.method === 'POST') {
        const meta = JSON.parse(body.toString())
        if (missing(meta.parents?.[0])) return send(404, { error: { message: 'File not found' } })
        const id = `f${next++}`
        files.set(id, { ...meta, folder: true })
        return send(200, { id })
      }
      const upload = /^\/upload\/files(?:\/(\w+))?$/.exec(url.pathname)
      if (upload) {
        const boundary = /boundary=(\S+)/.exec(req.headers['content-type'])[1]
        const text = body.toString('latin1')
        const parts = text.split(`--${boundary}`).slice(1, -1)
        const meta = JSON.parse(Buffer.from(parts[0].split('\r\n\r\n')[1].trim(), 'latin1').toString('utf8'))
        const mime = /Content-Type: (\S+)/.exec(parts[1])[1]
        const size = Buffer.from(parts[1].split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''), 'latin1').length
        if (upload[1]) {
          if (missing(upload[1])) return send(404, { error: { message: 'File not found' } })
          files.set(upload[1], { ...files.get(upload[1]), name: meta.name, mime, size, updated: true })
          return send(200, { id: upload[1] })
        }
        if (missing(meta.parents?.[0])) return send(404, { error: { message: 'File not found' } })
        const id = `f${next++}`
        files.set(id, { ...meta, mime, size })
        return send(200, { id })
      }
      send(404, { error: { message: `no ${req.method} ${url.pathname}` } })
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`
    const urls = { auth: 'https://accounts.google.test/auth', token: `${base}/token`, revoke: `${base}/revoke`, userinfo: `${base}/userinfo`, api: `${base}/api`, upload: `${base}/upload` }
    // Everything inside a folder, as the Drive shows it
    const inFolder = (id) => [...files.entries()].filter(([, f]) => f.parents?.[0] === id).map(([fid, f]) => ({ id: fid, ...f }))
    const removeFolder = (id) => { for (const f of inFolder(id)) removeFolder(f.id); files.delete(id) }
    resolve({ urls, files, calls, fail, inFolder, removeFolder, close: () => server.close() })
  }))
}

async function startTestApp({ env = {}, bitrixEnabled = true, mailEnabled = true, google = false } = {}) {
  await prepareDatabase()
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buysun-uploads-'))
  const bitrixServer = await startFakeBitrix()
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_URL,
    UPLOAD_DIR: uploadDir,
    FRONTEND_URL: SITE,
    BITRIX_WEBHOOK_URL: bitrixEnabled ? bitrixServer.url : '',
    SMTP_HOST: mailEnabled ? 'smtp.test' : '',
    LEADS_EMAIL_TO: 'leads@buysun.test',
    MAIL_FROM: 'site@buysun.test',
    ...env,
  })
  const prisma = createPrisma(TEST_URL)
  await prisma.$executeRawUnsafe('TRUNCATE leads, lead_files, lead_events, sessions, users, partner_templates, google_drive RESTART IDENTITY CASCADE')
  const storage = createStorage(config.uploadDir)

  const mails = []
  const mailBehaviour = { fail: false }
  const transporter = {
    sendMail: async (message) => {
      if (mailBehaviour.fail) throw new Error('SMTP down')
      mails.push(message)
    },
  }
  const bitrix = config.bitrix ? createBitrix(config.bitrix) : null
  const mailer = config.mail?.to ? createMailer(config.mail, { transporter }) : null

  const googleServer = google ? await startFakeGoogle() : null
  const drive = googleServer
    ? createGoogleDrive({ prisma, clientId: 'client-1', clientSecret: 'secret-1', redirectUri: `${SITE}/api/admin/google/callback`, urls: googleServer.urls })
    : null
  const delivery = createDelivery({ prisma, storage, bitrix, mailer, drive })

  const app = createApp({ config, prisma, storage, delivery, drive })
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`

  const post = async (url, body, headers = {}) => {
    const response = await fetch(base + url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: SITE, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }

  // Waits until every lead sent so far went to Bitrix24 and email
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 20))
    await delivery.idle()
  }

  // A browser of the cabinet: keeps the session cookie, sends the cabinet header
  const cabinet = () => {
    let cookie = ''
    const call = async (method, url, body, { header = true, redirect = 'follow' } = {}) => {
      const headers = { Origin: SITE }
      if (cookie) headers.Cookie = cookie
      if (header) headers['X-Requested-With'] = 'buysun-admin'
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      const response = await fetch(base + url, { method, headers, redirect, body: body === undefined ? undefined : JSON.stringify(body) })
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0].endsWith('=') ? '' : setCookie.split(';')[0]
      const type = response.headers.get('content-type') || ''
      return {
        status: response.status,
        headers: response.headers,
        body: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()),
      }
    }
    return { call, get cookie() { return cookie } }
  }

  return {
    config, prisma, storage, uploadDir, bitrixServer, googleServer, mails, mailBehaviour, post, settle, delivery, cabinet, base,
    async close() {
      await new Promise((resolve) => server.close(resolve))
      bitrixServer.close()
      googleServer?.close()
      await prisma.$disconnect()
      fs.rmSync(uploadDir, { recursive: true, force: true })
    },
  }
}

// Smallest files that pass the signature checks
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z', 'base64')
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n')
const dataUrl = (mime, buffer) => `data:${mime};base64,${buffer.toString('base64')}`

const anketaPayload = (overrides = {}) => ({
  answers: {
    firstName: 'Ivan',
    lastName: 'Petrov',
    phone: '+7 777 123 45 67',
    email: 'ivan@example.com',
    city: 'Алматы',
    desiredPosition: 'waiter',
    gender: 'male',
    birthDate: '1999-05-15',
    startMonth: '05',
    startDay: '15',
    endMonth: '10',
    endDay: '30',
    position1: 'Waiter',
    company1: 'Rixos',
    country1: 'Turkey',
    workStart1: '2023',
    workEnd1: '2024',
    readyToWorkPermanently: true,
    source: 'social',
    hobbies: 'Чтение',
    ...overrides.answers,
  },
  consent: true,
  utm: { utm_source: 'instagram', utm_campaign: 'season2027' },
  files: {
    pdf: dataUrl('application/pdf', PDF),
    selfie: dataUrl('image/jpeg', JPEG),
    full_body: dataUrl('image/jpeg', JPEG),
    ...overrides.files,
  },
  ...overrides.top,
})

module.exports = { startTestApp, anketaPayload, dataUrl, JPEG, PDF, SITE }

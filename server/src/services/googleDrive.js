const crypto = require('crypto')
const { logger } = require('../utils/logger')

// Copies of anketas in the agency's Google Drive.
//
// A manager connects the agency's Google account once from the cabinet
// (OAuth, scope drive.file): the site then sees only the files it made itself,
// never the rest of the Drive. Every anketa gets its own folder inside
// "BUY SUN — анкеты с сайта" with the PDF and the photos; an anketa edited in
// the cabinet updates the same files there.
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.file']
const FOLDER = 'application/vnd.google-apps.folder'
const ROOT_NAME = 'BUY SUN — анкеты с сайта'
const STATE_MS = 10 * 60 * 1000

const GOOGLE = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
  api: 'https://www.googleapis.com/drive/v3',
  upload: 'https://www.googleapis.com/upload/drive/v3',
}

class DriveError extends Error {
  constructor(message, status, code) {
    super(message)
    this.status = status
    this.code = code // Google's own error code, e.g. invalid_grant
  }
}

const folderUrl = (id) => `https://drive.google.com/drive/folders/${id}`

function createGoogleDrive({ prisma, clientId, clientSecret, redirectUri, urls = GOOGLE }) {
  // state → who started the connection; the answer from Google comes back
  // without the cabinet cookie, so the state is what ties it to a manager
  const states = new Map()
  let access = null // { token, until }

  async function call(url, { method = 'GET', token, json, body, headers = {} } = {}) {
    const response = await fetch(url, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: json ? JSON.stringify(json) : body,
      signal: AbortSignal.timeout(60000),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      const reason = data?.error_description || data?.error?.message || data?.error || `HTTP ${response.status}`
      throw new DriveError(`Google: ${reason}`, response.status, typeof data?.error === 'string' ? data.error : undefined)
    }
    return data
  }

  const form = (fields) => ({
    body: new URLSearchParams(fields).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })

  async function accessToken(row) {
    if (access && access.until > Date.now() + 60000 && access.for === row.refresh_token) return access.token
    try {
      const data = await call(urls.token, {
        method: 'POST',
        ...form({ client_id: clientId, client_secret: clientSecret, refresh_token: row.refresh_token, grant_type: 'refresh_token' }),
      })
      access = { token: data.access_token, until: Date.now() + data.expires_in * 1000, for: row.refresh_token }
      return access.token
    } catch (err) {
      if (err.code === 'invalid_grant') {
        throw new DriveError('Доступ к Google Диску отозван. Подключите его в кабинете заново.', 401)
      }
      throw err
    }
  }

  const createFolder = (token, name, parent) => call(`${urls.api}/files?fields=id`, {
    method: 'POST',
    token,
    json: { name, mimeType: FOLDER, ...(parent ? { parents: [parent] } : {}) },
  }).then((d) => d.id)

  // One request with the name and the content (multipart/related)
  function upload(token, { id, name, parent, mime, buffer }) {
    const boundary = `buysun${crypto.randomBytes(12).toString('hex')}`
    const meta = id ? { name } : { name, parents: [parent] }
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}--`),
    ])
    const url = id ? `${urls.upload}/files/${id}?uploadType=multipart&fields=id` : `${urls.upload}/files?uploadType=multipart&fields=id`
    return call(url, { method: id ? 'PATCH' : 'POST', token, body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } })
      .then((d) => d.id)
  }

  const connection = () => prisma.googleDrive.findUnique({ where: { id: 1 } })

  return {
    configured: Boolean(clientId && clientSecret),

    async status() {
      const row = await connection()
      return row ? { connected: true, email: row.email, folder_url: folderUrl(row.folder_id) } : { connected: false }
    },

    // Where the manager goes to allow access; the state lives 10 minutes
    authUrl(userId) {
      const now = Date.now()
      for (const [key, value] of states) if (value.until < now) states.delete(key)
      const state = crypto.randomBytes(24).toString('base64url')
      states.set(state, { userId, until: now + STATE_MS })
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        access_type: 'offline',
        prompt: 'consent', // always gives a refresh token, also on a second connection
        include_granted_scopes: 'true',
        state,
      })
      return `${urls.auth}?${params}`
    },

    // Google sent the manager back: the code becomes a lasting permission
    async finish({ code, state }) {
      const started = states.get(state)
      states.delete(state)
      if (!started || started.until < Date.now()) throw new DriveError('Ссылка устарела. Нажмите «Подключить Google Диск» ещё раз.', 400)
      const tokens = await call(urls.token, {
        method: 'POST',
        ...form({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
      })
      if (!tokens.refresh_token) throw new DriveError('Google не выдал постоянный доступ. Попробуйте подключить ещё раз.', 400)
      if (!String(tokens.scope || '').includes('drive.file')) {
        throw new DriveError('Нужно поставить галочку доступа к Google Диску. Подключите ещё раз и отметьте её.', 400)
      }
      const { email } = await call(urls.userinfo, { token: tokens.access_token })
      const folderId = await createFolder(tokens.access_token, ROOT_NAME)
      const previous = await connection()
      const data = { email, refresh_token: tokens.refresh_token, folder_id: folderId, connected_by: started.userId }
      await prisma.googleDrive.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: { ...data, created_at: new Date() } })
      access = { token: tokens.access_token, until: Date.now() + tokens.expires_in * 1000, for: tokens.refresh_token }
      if (previous && previous.refresh_token !== tokens.refresh_token) {
        await call(urls.revoke, { method: 'POST', ...form({ token: previous.refresh_token }) }).catch(() => {})
      }
      // A new Drive (or the same one again, with a new top folder): every
      // anketa is copied into it from the start
      await prisma.lead.updateMany({
        where: { type: 'anketa' },
        data: { drive_status: 'pending', drive_error: null, drive_folder_id: null, drive_files: null },
      })
      logger.info('Google Drive connected', { userId: started.userId })
      return { email, folder_url: folderUrl(folderId) }
    },

    async disconnect() {
      const row = await connection()
      if (!row) return
      await prisma.googleDrive.delete({ where: { id: 1 } })
      access = null
      await call(urls.revoke, { method: 'POST', ...form({ token: row.refresh_token }) }).catch(() => {})
      await prisma.lead.updateMany({ where: { drive_status: { in: ['pending', 'failed'] } }, data: { drive_status: 'skipped' } })
    },

    // Puts the anketa's current files into its folder. Returns what to store
    // on the lead. A folder or file deleted in Drive by hand is made again.
    async sync(lead, files) {
      const row = await connection()
      if (!row) return { drive_status: 'skipped' }
      const token = await accessToken(row)

      const newFolder = async () => {
        const date = lead.created_at.toLocaleDateString('ru-RU', { timeZone: 'Asia/Almaty' })
        const name = `${lead.name || lead.phone} — ${date} — анкета №${lead.id}`
        try {
          return await createFolder(token, name, row.folder_id)
        } catch (err) {
          if (err.status !== 404) throw err
          // The top folder was deleted in Drive: a new one
          row.folder_id = await createFolder(token, ROOT_NAME)
          await prisma.googleDrive.update({ where: { id: 1 }, data: { folder_id: row.folder_id } })
          return createFolder(token, name, row.folder_id)
        }
      }

      const put = async (folder, done) => {
        if (!folder) {
          folder = await newFolder()
          await prisma.lead.update({ where: { id: lead.id }, data: { drive_folder_id: folder, drive_files: {} } })
        }
        for (const file of files) {
          const before = done[file.kind]
          if (before?.file_id === file.id) continue
          const driveId = await upload(token, { id: before?.drive_id, name: file.name, parent: folder, mime: file.mime, buffer: file.buffer })
          done = { ...done, [file.kind]: { drive_id: driveId, file_id: file.id } }
          await prisma.lead.update({ where: { id: lead.id }, data: { drive_files: done } })
        }
      }

      try {
        await put(lead.drive_folder_id, lead.drive_files || {})
      } catch (err) {
        if (err.status !== 404) throw err
        await put(null, {})
      }
      return { drive_status: 'sent', drive_error: null }
    },
  }
}

module.exports = { createGoogleDrive, folderUrl, GOOGLE }

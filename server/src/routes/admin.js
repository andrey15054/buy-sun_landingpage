const express = require('express')
const rateLimit = require('express-rate-limit')
const { z } = require('zod')
const auth = require('../services/auth')
const { logger } = require('../utils/logger')
const { anketaEditSchema, partnerTemplateSchema } = require('../utils/validation')
const { downloadName, contentDisposition } = require('../utils/download')

const COOKIE = 'bs_admin'
const PENDING_MS = 10 * 60 * 1000 // first login: only time to set a new password
const SESSION_MS = 12 * 60 * 60 * 1000 // a working day
const IDLE_MS = 2 * 60 * 60 * 1000 // logged out after 2 hours without activity
const MAX_ATTEMPTS = 5
const LOCK_MS = 15 * 60 * 1000

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true })

function readCookie(req, name) {
  const header = req.headers.cookie || ''
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return decodeURIComponent(rest.join('='))
  }
  return null
}

// What the manager has to do before getting into the cabinet
function nextStep(user, session) {
  if (user.must_change_password) return 'password'
  if (!session.verified) return 'login'
  return null
}

function adminRouter({ config, prisma, storage, leadAdmin, templates, delivery = null, drive = null }) {
  const router = express.Router()
  const strict = config.isProduction
  const json = express.json({ limit: '20kb' })

  const setCookie = (res, token, maxAgeMs) => {
    res.cookie(COOKIE, token, {
      httpOnly: true,
      secure: strict,
      sameSite: 'strict',
      path: '/api/admin',
      maxAge: maxAgeMs,
    })
  }

  // Never cache anything from the cabinet: it is personal data
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })

  // A custom header cannot be sent by another site's form, so every change
  // must come from the cabinet's own scripts (on top of SameSite cookies)
  router.use((req, res, next) => {
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'buysun-admin') {
      logger.security('Cabinet request without the cabinet header', { path: req.path })
      return res.status(403).json({ error: 'Запрос отклонён' })
    }
    next()
  })

  const attemptLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: strict ? 20 : 1000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Слишком много попыток. Попробуйте через 15 минут.' },
  })

  const LOCKED = 'Слишком много неудачных попыток. Попробуйте через 15 минут.'

  // An attempt is counted before it is checked, in one statement, so guesses
  // sent in parallel cannot all start from the same count: one past the limit
  // is refused without checking the password
  async function takeAttempt(user) {
    const { failed_attempts: attempts } = await prisma.user.update({
      where: { id: user.id },
      data: { failed_attempts: { increment: 1 } },
      select: { failed_attempts: true },
    })
    if (attempts > MAX_ATTEMPTS) throw fail(423, LOCKED)
    return attempts
  }

  async function registerFailure(user, attempts, reason, req) {
    const locked = attempts >= MAX_ATTEMPTS
    if (locked) {
      await prisma.user.update({ where: { id: user.id }, data: { failed_attempts: 0, locked_until: new Date(Date.now() + LOCK_MS) } })
    }
    logger.security(locked ? 'Cabinet account locked for 15 minutes' : 'Cabinet login failed', { userId: user.id, reason, ip: req.ip })
  }

  const isLocked = (user) => user.locked_until && user.locked_until > new Date()

  // Finds the session from the cookie; refuses expired, idle or disabled ones
  async function loadSession(req, res, next) {
    try {
      const token = readCookie(req, COOKIE)
      if (!token) throw fail(401, 'Войдите в кабинет')
      const session = await prisma.session.findUnique({ where: { token_hash: auth.hashToken(token) }, include: { user: true } })
      const now = Date.now()
      if (!session || session.expires_at.getTime() < now || session.user.disabled
        || (session.verified && now - session.last_seen_at.getTime() > IDLE_MS)) {
        if (session) await prisma.session.delete({ where: { id: session.id } }).catch(() => {})
        res.clearCookie(COOKIE, { path: '/api/admin' })
        throw fail(401, 'Сессия закончилась, войдите снова')
      }
      if (now - session.last_seen_at.getTime() > 60 * 1000) {
        await prisma.session.update({ where: { id: session.id }, data: { last_seen_at: new Date() } })
      }
      req.session = session
      req.user = session.user
      next()
    } catch (err) { next(err) }
  }

  const requireFull = (req, res, next) => {
    if (nextStep(req.user, req.session)) return next(fail(401, 'Войдите в кабинет'))
    next()
  }

  const me = (user, session) => ({ user: { name: user.name, email: user.email }, next: nextStep(user, session) })

  // ---- login ----

  router.post('/login', attemptLimiter, json, async (req, res, next) => {
    try {
      const { email, password } = z.object({ email: z.string().trim().toLowerCase().max(200), password: z.string().max(200) }).parse(req.body)
      const user = await prisma.user.findUnique({ where: { email } })
      if (!user || user.disabled) {
        await auth.verifyAgainstDummy(password)
        logger.security('Cabinet login failed', { reason: 'unknown email', ip: req.ip })
        throw fail(401, 'Неверный email или пароль')
      }
      if (isLocked(user)) throw fail(423, LOCKED)
      const attempts = await takeAttempt(user)
      if (!(await auth.verifyPassword(password, user.password_hash))) {
        await registerFailure(user, attempts, 'password', req)
        throw fail(401, 'Неверный email или пароль')
      }
      // The right password: the counter starts again. On the first login the
      // session only allows setting a new password; otherwise it is the full one.
      const updated = await prisma.user.update({
        where: { id: user.id },
        data: { failed_attempts: 0, locked_until: null, last_login_at: new Date() },
      })
      const full = !user.must_change_password
      const lifetime = full ? SESSION_MS : PENDING_MS
      const token = auth.newToken()
      const session = await prisma.session.create({
        data: { token_hash: auth.hashToken(token), user_id: user.id, verified: full, expires_at: new Date(Date.now() + lifetime) },
      })
      setCookie(res, token, lifetime)
      logger.info(full ? 'Cabinet login' : 'Cabinet first login: new password needed', { userId: user.id })
      res.json(me(updated, session))
    } catch (err) { next(err) }
  })

  router.get('/me', loadSession, (req, res) => res.json(me(req.user, req.session)))

  router.post('/password', json, loadSession, async (req, res, next) => {
    try {
      const { password } = z.object({
        password: z.string().min(10, 'Пароль должен быть не короче 10 символов').max(200),
      }).parse(req.body)
      if (req.session.verified === false && !req.user.must_change_password) throw fail(401, 'Войдите в кабинет')
      const user = await prisma.user.update({
        where: { id: req.user.id },
        data: { password_hash: await auth.hashPassword(password), must_change_password: false },
      })
      // Other devices are logged out after a password change
      await prisma.session.deleteMany({ where: { user_id: user.id, id: { not: req.session.id } } })
      let session = req.session
      if (!session.verified) {
        // First login done: a new cookie value for the full session, so a value
        // seen before is useless
        const token = auth.newToken()
        session = await prisma.session.update({
          where: { id: session.id },
          data: { token_hash: auth.hashToken(token), verified: true, expires_at: new Date(Date.now() + SESSION_MS), last_seen_at: new Date() },
        })
        setCookie(res, token, SESSION_MS)
      }
      logger.info('Cabinet password changed', { userId: user.id })
      res.json(me(user, session))
    } catch (err) { next(err) }
  })

  router.post('/logout', async (req, res, next) => {
    try {
      const token = readCookie(req, COOKIE)
      if (token) await prisma.session.deleteMany({ where: { token_hash: auth.hashToken(token) } })
      res.clearCookie(COOKIE, { path: '/api/admin' })
      res.json({ ok: true })
    } catch (err) { next(err) }
  })

  // ---- managers ----
  // Every manager can add a colleague, give a new temporary password or close
  // someone's access (a small agency: no separate roles). A temporary password
  // is shown once, to be sent privately; it must be changed on the first login.

  const managerView = (u, me) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    status: u.disabled ? 'disabled' : u.must_change_password ? 'new' : 'active',
    last_login_at: u.last_login_at,
    me: u.id === me.id,
  })
  const managerId = (req) => z.coerce.number().int().positive().max(2147483647).parse(req.params.id)
  const notMe = (req, id) => { if (id === req.user.id) throw fail(400, 'Это ваш вход: свой пароль меняйте при входе, а доступ себе закрыть нельзя') }

  router.get('/managers', loadSession, requireFull, async (req, res, next) => {
    try {
      const users = await prisma.user.findMany({ orderBy: { id: 'asc' } })
      res.json({ items: users.map((u) => managerView(u, req.user)) })
    } catch (err) { next(err) }
  })

  router.post('/managers', loadSession, requireFull, json, async (req, res, next) => {
    try {
      const { name, email } = z.object({
        name: z.string().trim().min(1, 'Укажите имя').max(100),
        email: z.string().trim().toLowerCase().max(200).regex(/^\S+@\S+\.\S+$/, 'Укажите email'),
      }).parse(req.body)
      if (await prisma.user.findUnique({ where: { email } })) throw fail(409, 'Менеджер с таким email уже есть')
      const password = auth.generatePassword()
      const user = await prisma.user.create({ data: { email, name, password_hash: await auth.hashPassword(password) } })
      logger.info('Manager added', { userId: user.id, by: req.user.id })
      res.status(201).json({ manager: managerView(user, req.user), password })
    } catch (err) { next(err) }
  })

  // Forgotten password: a new temporary one, every session of that manager ends
  router.post('/managers/:id/reset', loadSession, requireFull, async (req, res, next) => {
    try {
      const id = managerId(req)
      notMe(req, id)
      const password = auth.generatePassword()
      const user = await prisma.user.update({
        where: { id },
        data: { password_hash: await auth.hashPassword(password), must_change_password: true, failed_attempts: 0, locked_until: null, disabled: false },
      }).catch(() => { throw fail(404, 'Менеджер не найден') })
      await prisma.session.deleteMany({ where: { user_id: id } })
      logger.security('Manager password reset', { userId: id, by: req.user.id })
      res.json({ manager: managerView(user, req.user), password })
    } catch (err) { next(err) }
  })

  // Someone left: no access at once; «Открыть доступ» brings it back
  router.post(['/managers/:id/disable', '/managers/:id/enable'], loadSession, requireFull, async (req, res, next) => {
    try {
      const id = managerId(req)
      notMe(req, id)
      const disabled = req.path.endsWith('/disable')
      const user = await prisma.user.update({ where: { id }, data: { disabled } }).catch(() => { throw fail(404, 'Менеджер не найден') })
      if (disabled) await prisma.session.deleteMany({ where: { user_id: id } })
      logger.security(disabled ? 'Manager access closed' : 'Manager access opened', { userId: id, by: req.user.id })
      res.json({ manager: managerView(user, req.user) })
    } catch (err) { next(err) }
  })

  // ---- leads ----

  router.get('/leads', loadSession, requireFull, async (req, res, next) => {
    try {
      const query = z.object({
        q: z.string().trim().max(100).optional(),
        type: z.enum(['quick', 'callback', 'anketa']).optional(),
        page: z.coerce.number().int().min(1).max(10000).default(1),
      }).parse(req.query)
      res.json(await leadAdmin.list(query))
    } catch (err) { next(err) }
  })

  const leadId = (req) => z.coerce.number().int().positive().parse(req.params.id)

  router.get('/leads/:id', loadSession, requireFull, async (req, res, next) => {
    try {
      const lead = await leadAdmin.get(leadId(req))
      if (!lead) throw fail(404, 'Заявка не найдена')
      res.json(lead)
    } catch (err) { next(err) }
  })

  router.get('/leads/:id/files/:fileId', loadSession, requireFull, async (req, res, next) => {
    try {
      const file = await prisma.leadFile.findFirst({
        where: { id: z.coerce.number().int().positive().parse(req.params.fileId), lead_id: leadId(req) },
        include: { lead: { select: { name: true, answers: true } } },
      })
      if (!file) throw fail(404, 'Файл не найден')
      const buffer = await storage.read(file.path)
      res.set('Content-Type', file.mime)
      res.set('Content-Disposition', contentDisposition(req.query.download ? 'attachment' : 'inline', downloadName(file)))
      res.send(buffer)
    } catch (err) { next(err) }
  })

  // A new anketa link: the old one stops opening (sent to the wrong person)
  router.post('/leads/:id/share-link', loadSession, requireFull, async (req, res, next) => {
    try {
      const share_token = await leadAdmin.renewShareToken(leadId(req))
      logger.info('Anketa link renewed', { leadId: leadId(req), userId: req.user.id })
      res.json({ share_token })
    } catch (err) { next(err) }
  })

  // PDF up to 8 MB and five photos up to 4 MB each, base64 adds a third
  // The login is checked before the body is read: without one, nobody can make
  // the server take in 40 MB
  router.put('/leads/:id', loadSession, requireFull, express.json({ limit: '40mb' }), async (req, res, next) => {
    try {
      const data = anketaEditSchema.parse(req.body)
      const lead = await leadAdmin.update(leadId(req), data, req.user)
      res.json(lead)
      // The new PDF and photos go to the anketa's Google Drive folder too
      if (drive && delivery) {
        await prisma.lead.update({ where: { id: lead.id }, data: { drive_status: 'pending', drive_error: null } })
        delivery.enqueue(lead.id)
      }
    } catch (err) { next(err) }
  })

  // ---- Google Drive ----

  router.get('/google', loadSession, requireFull, async (req, res, next) => {
    try {
      res.json(drive ? { configured: true, ...(await drive.status()) } : { configured: false, connected: false })
    } catch (err) { next(err) }
  })

  // The cabinet's «Подключить Google Диск» link: off to Google's consent page
  router.get('/google/connect', loadSession, requireFull, (req, res) => {
    if (!drive) return res.redirect('/admin/#/google')
    res.redirect(drive.authUrl(req.user.id))
  })

  // Google sends the manager back here (without the cabinet cookie, which is
  // SameSite=Strict: the one-time state ties the answer to the manager)
  router.get('/google/callback', async (req, res) => {
    const back = (query) => res.redirect(`/admin/#/google?${new URLSearchParams(query)}`)
    if (!drive) return back({ error: 'Google Диск не настроен на сервере' })
    if (req.query.error) {
      return back({ error: req.query.error === 'access_denied' ? 'Доступ не дан: нажмите «Подключить» ещё раз и разрешите доступ.' : String(req.query.error).slice(0, 200) })
    }
    try {
      await drive.finish({ code: String(req.query.code || ''), state: String(req.query.state || '') })
      const anketas = await prisma.lead.findMany({ where: { type: 'anketa', drive_status: 'pending' }, select: { id: true }, orderBy: { id: 'asc' } })
      for (const { id } of anketas) delivery?.enqueue(id)
      back({ ok: '1' })
    } catch (err) {
      logger.error('Google Drive connection failed', { error: String(err.message).slice(0, 300) })
      back({ error: err.status && err.status < 500 && !/^Google:/.test(err.message) ? err.message : 'Не удалось подключить Google Диск. Попробуйте ещё раз.' })
    }
  })

  router.delete('/google', loadSession, requireFull, async (req, res, next) => {
    try {
      if (drive) await drive.disconnect()
      logger.info('Google Drive disconnected', { userId: req.user.id })
      res.json({ configured: Boolean(drive), connected: false })
    } catch (err) { next(err) }
  })

  // ---- partner templates ----

  const templateId = (req) => {
    const id = Number(req.params.id)
    if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('Шаблон не найден'), { status: 404, expose: true })
    return id
  }

  router.get('/templates', loadSession, requireFull, async (req, res, next) => {
    try {
      res.json({ items: await templates.list() })
    } catch (err) { next(err) }
  })

  router.post('/templates', loadSession, requireFull, express.json({ limit: '2mb' }), async (req, res, next) => {
    try {
      const template = await templates.create(partnerTemplateSchema.parse(req.body), req.user)
      logger.info('Partner template added', { userId: req.user.id, templateId: template.id })
      res.status(201).json({ template })
    } catch (err) { next(err) }
  })

  router.put('/templates/:id', loadSession, requireFull, express.json({ limit: '2mb' }), async (req, res, next) => {
    try {
      const template = await templates.update(templateId(req), partnerTemplateSchema.parse(req.body), req.user)
      logger.info('Partner template saved', { userId: req.user.id, templateId: template.id })
      res.json({ template })
    } catch (err) { next(err) }
  })

  router.delete('/templates/:id', loadSession, requireFull, async (req, res, next) => {
    try {
      const id = templateId(req)
      await templates.remove(id)
      logger.info('Partner template removed', { userId: req.user.id, templateId: id })
      res.json({ ok: true })
    } catch (err) { next(err) }
  })

  return router
}

module.exports = { adminRouter }

const express = require('express')
const rateLimit = require('express-rate-limit')
const { honeypot } = require('../middleware/spam')
const { quickLeadSchema, callbackLeadSchema, anketaSchema } = require('../utils/validation')
const { logger } = require('../utils/logger')
const { SHARE_TOKEN } = require('../utils/shareToken')
const { downloadName, contentDisposition } = require('../utils/download')

// Anketas are taken a few at a time: each one is several megabytes in memory
// while it is checked and written to disk. The others wait their turn (their
// upload simply pauses), so a burst cannot run the server out of memory.
function oneAtATime(max) {
  let active = 0
  const waiting = []
  const pump = () => {
    while (active < max && waiting.length) waiting.shift()()
  }
  return (req, res, next) => {
    let state = 'waiting' // waiting -> running -> done
    const start = () => {
      if (state !== 'waiting') return
      // The person closed the page while waiting: nothing to read any more
      if (req.destroyed || res.destroyed) { state = 'done'; return }
      state = 'running'
      active++
      next()
    }
    const finish = () => {
      if (state === 'running') { state = 'done'; active--; pump() }
      else if (state === 'waiting') { state = 'done'; const i = waiting.indexOf(start); if (i >= 0) waiting.splice(i, 1) }
    }
    res.on('finish', finish)
    res.on('close', finish)
    waiting.push(start)
    pump()
  }
}

function leadsRouter({ config, leads, delivery }) {
  const router = express.Router()
  const strict = config.isProduction

  const limiter = (max) => rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: strict ? max : 1000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Слишком много заявок. Попробуйте через 15 минут.' },
  })

  const smallJson = express.json({ limit: '20kb' })
  // PDF up to 8 MB and five photos up to 4 MB each, base64 adds a third
  const anketaJson = express.json({ limit: '40mb' })
  const anketaTurn = oneAtATime(3)

  router.post('/leads/quick', limiter(10), smallJson, honeypot, async (req, res, next) => {
    try {
      const data = quickLeadSchema.parse(req.body)
      const lead = await leads.createShortLead('quick', data)
      logger.info('Lead stored', { leadId: lead.id, type: 'quick' })
      res.status(201).json({ ok: true })
      delivery.enqueue(lead.id) // Bitrix24 and email in the background
    } catch (err) { next(err) }
  })

  router.post('/leads/callback', limiter(10), smallJson, honeypot, async (req, res, next) => {
    try {
      const data = callbackLeadSchema.parse(req.body)
      const lead = await leads.createShortLead('callback', data)
      logger.info('Lead stored', { leadId: lead.id, type: 'callback' })
      res.status(201).json({ ok: true })
      delivery.enqueue(lead.id) // Bitrix24 and email in the background
    } catch (err) { next(err) }
  })

  router.post('/leads/anketa', limiter(10), anketaTurn, anketaJson, honeypot, async (req, res, next) => {
    try {
      const data = anketaSchema.parse(req.body)
      const lead = await leads.createAnketa(data)
      logger.info('Lead stored', { leadId: lead.id, type: 'anketa' })
      // The anketa link for the candidate's WhatsApp message and Direct
      res.status(201).json({ ok: true, share: lead.share_token })
      delivery.enqueue(lead.id) // Bitrix24 and email in the background
    } catch (err) { next(err) }
  })

  // An anketa by its link: the PDF opens in the browser, without the cabinet.
  // The link is the only key, so the page is kept out of search engines and
  // caches, and too many tries from one address are cut off.
  router.get('/a/:token', limiter(120), async (req, res, next) => {
    try {
      const shared = SHARE_TOKEN.test(req.params.token) ? await leads.sharedPdf(req.params.token) : null
      if (!shared) return res.status(404).type('text/plain; charset=utf-8').send('Анкета не найдена. Ссылка неверная или больше не действует.')
      // Built-in PDF viewers do not need the API's strict page rules
      res.removeHeader('Content-Security-Policy')
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': contentDisposition('inline', downloadName(shared.file)),
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      })
      res.send(shared.buffer)
    } catch (err) { next(err) }
  })

  return router
}

module.exports = { leadsRouter, oneAtATime }

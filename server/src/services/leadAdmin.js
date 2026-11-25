const { decodeDataUrl } = require('../utils/validation')
const { anketaRows, positionLabel, ANKETA_KEYS } = require('../utils/anketaFields')
const { logger } = require('../utils/logger')
const { newShareToken } = require('../utils/shareToken')

const MAX_ID = 2147483647 // largest id the database column holds
const PAGE_SIZE = 30

const FILE_LABELS = { pdf: 'PDF анкеты', selfie: 'фото лица', full_body: 'фото в полный рост', additional: 'доп. фото' }

// Leads for the manager cabinet: list, one lead, saving an edited anketa
function createLeadAdmin({ prisma, storage, bitrixPortal }) {
  const bitrixUrl = (lead) => (bitrixPortal && lead.bitrix_lead_id
    ? `${bitrixPortal}/crm/lead/details/${lead.bitrix_lead_id}/`
    : null)

  async function get(id) {
    const lead = await prisma.lead.findUnique({
      where: { id },
      include: {
        files: { orderBy: { id: 'asc' } },
        events: { orderBy: { id: 'desc' }, take: 50, include: { user: { select: { name: true } } } },
      },
    })
    if (!lead) return null
    return {
      id: lead.id,
      type: lead.type,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      answers: lead.answers,
      utm: lead.utm,
      created_at: lead.created_at,
      updated_at: lead.updated_at,
      version: lead.events[0]?.id ?? 0,
      bitrix_status: lead.bitrix_status,
      bitrix_error: lead.bitrix_error,
      bitrix_url: bitrixUrl(lead),
      email_status: lead.email_status,
      share_token: lead.share_token,
      files: lead.files.map((f) => ({ id: f.id, kind: f.kind, mime: f.mime, size: f.size, focus: f.focus, created_at: f.created_at })),
      events: lead.events.map((e) => ({ action: e.action, details: e.details, created_at: e.created_at, user: e.user?.name || null })),
    }
  }

  return {
    get,

    async renewShareToken(id) {
      const lead = await prisma.lead.findUnique({ where: { id }, select: { type: true } })
      if (!lead) throw Object.assign(new Error('Заявка не найдена'), { status: 404, expose: true })
      if (lead.type !== 'anketa') throw Object.assign(new Error('Ссылка есть только у анкет'), { status: 400, expose: true })
      const { share_token } = await prisma.lead.update({ where: { id }, data: { share_token: newShareToken() } })
      return share_token
    },

    async list({ q, type, page }) {
      const where = {}
      if (type) where.type = type
      if (q) {
        const digits = q.replace(/\D/g, '')
        where.OR = [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ]
        if (digits.length >= 3) where.OR.push({ phone: { contains: digits.length > 10 ? digits.slice(-10) : digits } })
        // "#12" or "12" is a lead number; a phone typed without "+" is not
        const id = Number(q.trim().replace('#', ''))
        if (/^#?\d+$/.test(q.trim()) && id <= MAX_ID) where.OR.push({ id })
      }
      const [total, leads] = await Promise.all([
        prisma.lead.count({ where }),
        prisma.lead.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
      ])
      return {
        total,
        page,
        pages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
        items: leads.map((l) => ({
          id: l.id,
          type: l.type,
          name: l.name,
          phone: l.phone,
          position: l.type === 'anketa' ? positionLabel(l.answers) : '',
          created_at: l.created_at,
          updated_at: l.updated_at,
          bitrix_status: l.bitrix_status,
          email_status: l.email_status,
        })),
      }
    },

    // Saves an edited anketa: answers, the new PDF, replaced photos.
    // New files are written first; old ones are removed only after the
    // database has the new ones, so a failure never leaves an anketa without files.
    async update(id, { answers, files, selfieFocus, version }, user) {
      const lead = await prisma.lead.findUnique({ where: { id }, include: { files: true } })
      if (!lead) throw Object.assign(new Error('Заявка не найдена'), { status: 404, expose: true })
      if (lead.type !== 'anketa') throw Object.assign(new Error('Редактировать можно только анкеты'), { status: 400, expose: true })

      const decoded = Object.entries(files).filter(([, v]) => v).map(([kind, v]) => decodeDataUrl(kind, v))
      const saved = await storage.saveLeadFiles(lead.id, decoded)
      const replacedKinds = saved.map((f) => f.kind)
      const oldFiles = lead.files.filter((f) => replacedKinds.includes(f.kind))

      const { email, ...rest } = answers
      const before = lead.answers || {}
      const changedRows = changedLabels(before, { ...rest, email: email || '' })

      try {
        await prisma.$transaction(async (tx) => {
          // Two managers in one anketa: the row lock makes saves take turns, and
          // a save made from an older version is refused, so nobody's change is lost
          await tx.$queryRaw`SELECT id FROM leads WHERE id = ${lead.id} FOR UPDATE`
          const latest = await tx.leadEvent.findFirst({ where: { lead_id: lead.id }, orderBy: { id: 'desc' }, include: { user: { select: { name: true } } } })
          if (version !== undefined && (latest?.id ?? 0) !== version) {
            const when = latest.created_at.toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
            throw Object.assign(new Error(`Анкету уже изменил(а) ${latest.user?.name || 'другой менеджер'} (${when}). Ваши правки не сохранены: обновите страницу и внесите их снова.`), { status: 409, expose: true })
          }
          await tx.leadFile.deleteMany({ where: { id: { in: oldFiles.map((f) => f.id) } } })
          await tx.leadFile.createMany({
            data: saved.map((f) => ({ ...f, lead_id: lead.id, focus: f.kind === 'selfie' ? selfieFocus : undefined })),
          })
          if (selfieFocus && !replacedKinds.includes('selfie')) {
            await tx.leadFile.updateMany({ where: { lead_id: lead.id, kind: 'selfie' }, data: { focus: selfieFocus } })
          }
          await tx.lead.update({
            where: { id: lead.id },
            data: {
              name: `${answers.firstName} ${answers.lastName}`.trim(),
              phone: answers.phone,
              email: email || null,
              answers: { ...rest, email: email || '' },
            },
          })
          await tx.leadEvent.create({
            data: {
              lead_id: lead.id,
              user_id: user.id,
              action: 'edited',
              details: {
                fields: changedRows,
                files: replacedKinds.filter((k) => k !== 'pdf').map((k) => FILE_LABELS[k]),
              },
            },
          })
        })
      } catch (err) {
        await Promise.all(saved.map((f) => storage.removeFile(f.path).catch(() => {})))
        throw err
      }
      await Promise.all(oldFiles.map((f) => storage.removeFile(f.path).catch(() => {})))
      logger.info('Anketa edited in the cabinet', { leadId: lead.id, userId: user.id, fields: changedRows.length, files: replacedKinds })
      return get(lead.id)
    },
  }
}

// Labels of the rows that differ, as managers read them ("Желаемая вакансия")
function changedLabels(before, after) {
  const keys = ANKETA_KEYS.filter((key) => (before[key] ?? '') !== (after[key] ?? ''))
  if (!keys.length) return []
  const changed = Object.fromEntries(keys.map((k) => [k, after[k] ?? before[k]]))
  const labelsAfter = new Set(anketaRows(changed).map(([label]) => label))
  const labelsBefore = new Set(anketaRows(Object.fromEntries(keys.map((k) => [k, before[k]]))).map(([label]) => label))
  return [...new Set([...labelsAfter, ...labelsBefore])]
}

module.exports = { createLeadAdmin }

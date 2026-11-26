const { decodeDataUrl } = require('../utils/validation')

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true })

// Partner templates: logo, header and contacts that replace BUY SUN at the
// top of the PDF. Several are kept (one per partner agency), shared by all
// managers. Kept in the database, so they are in the nightly backup.
function createTemplates({ prisma }) {
  const view = (t) => t && {
    id: t.id,
    name: t.name,
    header: t.header,
    contacts: t.contacts,
    logo: t.logo ? `data:image/png;base64,${Buffer.from(t.logo).toString('base64')}` : null,
    updated_at: t.updated_at,
    updated_by: t.user?.name || null,
  }

  const find = async (id) => {
    const template = await prisma.partnerTemplate.findUnique({ where: { id } })
    if (!template) throw fail(404, 'Шаблон не найден. Обновите страницу.')
    return template
  }

  // Two templates with one name would be confused in the list
  const checkName = async (name, id) => {
    const same = await prisma.partnerTemplate.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, ...(id ? { NOT: { id } } : {}) },
    })
    if (same) throw fail(409, `Шаблон «${same.name}» уже есть. Выберите его в списке или назовите иначе.`)
  }

  // data.logo: a PNG data URL, null to remove, undefined to keep the saved one
  const fields = (data, saved, user) => {
    let logo = saved?.logo ?? null
    if (data.logo === null) logo = null
    else if (data.logo !== undefined) logo = decodeDataUrl('logo', data.logo).buffer
    if (!data.header && !data.contacts && !logo) throw fail(400, 'Добавьте логотип, шапку или контакты')
    return { name: data.name, header: data.header, contacts: data.contacts, logo, updated_by: user.id }
  }

  return {
    async list() {
      const items = await prisma.partnerTemplate.findMany({ orderBy: { name: 'asc' }, include: { user: true } })
      return items.map(view)
    },

    async create(data, user) {
      await checkName(data.name)
      return view(await prisma.partnerTemplate.create({ data: fields(data, null, user), include: { user: true } }))
    },

    async update(id, data, user) {
      const saved = await find(id)
      await checkName(data.name, id)
      return view(await prisma.partnerTemplate.update({ where: { id }, data: fields(data, saved, user), include: { user: true } }))
    },

    async remove(id) {
      await find(id)
      await prisma.partnerTemplate.delete({ where: { id } })
    },
  }
}

module.exports = { createTemplates }

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { startTestApp, anketaPayload, dataUrl, JPEG, PDF } = require('./helpers')
const { hashPassword } = require('../src/services/auth')

const TEMP = 'temporary-pass-1'
const NEW = 'my-new-password-2026'

async function addManager(t, email, extra = {}) {
  return t.prisma.user.create({ data: { email, name: 'Анна', password_hash: await hashPassword(TEMP), ...extra } })
}

// Logs a new manager in: temporary password, then their own; returns the client
async function firstLogin(t, email) {
  const c = t.cabinet()
  assert.equal((await c.call('POST', '/api/admin/login', { email, password: TEMP })).body.next, 'password')
  assert.equal((await c.call('POST', '/api/admin/password', { password: NEW })).body.next, null)
  return { c }
}

describe('cabinet login', () => {
  let t
  before(async () => { t = await startTestApp() })
  after(async () => { await t.close() })

  it('walks a new manager from the temporary password to their own', async () => {
    await addManager(t, 'anna@buysun.test')
    const c = t.cabinet()
    const login = await c.call('POST', '/api/admin/login', { email: 'ANNA@buysun.test ', password: TEMP })
    assert.equal(login.status, 200)
    assert.equal(login.body.next, 'password')
    assert.match(login.headers.get('set-cookie'), /HttpOnly/i)
    assert.match(login.headers.get('set-cookie'), /SameSite=Strict/i)

    assert.equal((await c.call('GET', '/api/admin/leads')).status, 401, 'no data with the temporary password')
    assert.equal((await c.call('POST', '/api/admin/password', { password: 'short' })).status, 400)
    const before = c.cookie
    const done = await c.call('POST', '/api/admin/password', { password: NEW })
    assert.equal(done.body.next, null)
    assert.notEqual(c.cookie, before, 'a new session value after the first login')
    const leads = await c.call('GET', '/api/admin/leads')
    assert.equal(leads.status, 200)
    assert.equal(leads.headers.get('cache-control'), 'no-store')
    // The old phone-code steps are gone
    assert.equal((await c.call('POST', '/api/admin/2fa/setup')).status, 404)
  })

  it('lets a manager in with the password alone on the next login', async () => {
    await firstLogin(t, (await addManager(t, 'boris@buysun.test')).email)
    const c = t.cabinet()
    assert.equal((await c.call('POST', '/api/admin/login', { email: 'boris@buysun.test', password: TEMP })).status, 401, 'the temporary password no longer works')
    const login = await c.call('POST', '/api/admin/login', { email: 'boris@buysun.test', password: NEW })
    assert.equal(login.body.next, null)
    assert.equal((await c.call('GET', '/api/admin/leads')).status, 200)
    // A manager stuck on the old phone step gets in too
    await addManager(t, 'stuck@buysun.test', { password_hash: await hashPassword(NEW), must_change_password: false, totp_secret: 'ABC', totp_enabled: false })
    const stuck = t.cabinet()
    assert.equal((await stuck.call('POST', '/api/admin/login', { email: 'stuck@buysun.test', password: NEW })).body.next, null)
  })

  it('locks the account for 15 minutes after 5 wrong passwords', async () => {
    await addManager(t, 'vera@buysun.test')
    const c = t.cabinet()
    for (let i = 0; i < 5; i++) {
      assert.equal((await c.call('POST', '/api/admin/login', { email: 'vera@buysun.test', password: 'wrong' })).status, 401)
    }
    const locked = await c.call('POST', '/api/admin/login', { email: 'vera@buysun.test', password: TEMP })
    assert.equal(locked.status, 423)
  })

  it('does not let wrong passwords sent in parallel get past the 5-attempt limit', async () => {
    await addManager(t, 'parallel@buysun.test')
    const tries = await Promise.all(Array.from({ length: 15 }, (_, i) =>
      t.cabinet().call('POST', '/api/admin/login', { email: 'parallel@buysun.test', password: `wrong-${i}` })))
    const checked = tries.filter((r) => r.status === 401).length
    assert.ok(checked <= 5, `only 5 passwords may be checked, ${checked} were`)
    assert.equal(tries.filter((r) => r.status === 423).length, 15 - checked)
    assert.equal((await t.cabinet().call('POST', '/api/admin/login', { email: 'parallel@buysun.test', password: TEMP })).status, 423, 'locked even for the right password')
  })

  it('checks the login before reading a big body', async () => {
    const res = await fetch(`${t.base}/api/admin/leads/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'buysun-admin', Origin: 'https://buysun.kz' },
      body: '{"broken json',
    })
    assert.equal(res.status, 401, 'refused for the missing login, not for the body')
  })

  it('gives the same answer for an unknown email and a wrong password', async () => {
    const unknown = await t.cabinet().call('POST', '/api/admin/login', { email: 'nobody@buysun.test', password: 'x' })
    assert.equal(unknown.status, 401)
    assert.equal(unknown.body.error, 'Неверный email или пароль')
  })

  it('refuses changes without the cabinet header', async () => {
    const res = await t.cabinet().call('POST', '/api/admin/login', { email: 'anna@buysun.test', password: NEW }, { header: false })
    assert.equal(res.status, 403)
  })

  it('logs out after 2 idle hours, on logout, and when access is closed', async () => {
    const user = await addManager(t, 'gleb@buysun.test')
    const { c } = await firstLogin(t, user.email)
    await t.prisma.session.updateMany({ where: { user_id: user.id }, data: { last_seen_at: new Date(Date.now() - 3 * 3600 * 1000) } })
    assert.equal((await c.call('GET', '/api/admin/leads')).status, 401)

    const second = await firstLoginAgain(t, user.email)
    await second.call('POST', '/api/admin/logout')
    assert.equal((await second.call('GET', '/api/admin/leads')).status, 401)

    const third = await firstLoginAgain(t, user.email)
    await t.prisma.user.update({ where: { id: user.id }, data: { disabled: true } })
    assert.equal((await third.call('GET', '/api/admin/leads')).status, 401)
  })
})

async function firstLoginAgain(t, email) {
  const c = t.cabinet()
  assert.equal((await c.call('POST', '/api/admin/login', { email, password: NEW })).body.next, null)
  return c
}

describe('managers page', () => {
  let t, c
  before(async () => {
    t = await startTestApp()
    await addManager(t, 'ahmed@buysun.test')
    c = (await firstLogin(t, 'ahmed@buysun.test')).c
  })
  after(async () => { await t.close() })

  it('adds a manager with a temporary password shown once', async () => {
    const added = await c.call('POST', '/api/admin/managers', { name: 'Дана', email: ' Dana@BuySun.test ' })
    assert.equal(added.status, 201)
    assert.equal(added.body.manager.email, 'dana@buysun.test')
    assert.equal(added.body.manager.status, 'new')
    assert.match(added.body.password, /^[A-Za-z0-9]{14}$/)
    const dana = t.cabinet()
    assert.equal((await dana.call('POST', '/api/admin/login', { email: 'dana@buysun.test', password: added.body.password })).body.next, 'password')
    assert.equal((await c.call('POST', '/api/admin/managers', { name: 'Дана', email: 'dana@buysun.test' })).status, 409)
    assert.equal((await c.call('POST', '/api/admin/managers', { name: '', email: 'x@y.z' })).status, 400)
    const list = (await c.call('GET', '/api/admin/managers')).body.items
    assert.deepEqual(list.map((m) => [m.email, m.status, m.me]), [['ahmed@buysun.test', 'active', true], ['dana@buysun.test', 'new', false]])
    assert.equal(JSON.stringify(list).includes('password_hash'), false)
  })

  it('resets a forgotten password and ends that manager\'s sessions', async () => {
    const boris = await addManager(t, 'boris@buysun.test')
    const { c: b } = await firstLogin(t, boris.email)
    const reset = await c.call('POST', `/api/admin/managers/${boris.id}/reset`)
    assert.equal(reset.status, 200)
    assert.equal((await b.call('GET', '/api/admin/leads')).status, 401, 'logged out')
    assert.equal((await t.cabinet().call('POST', '/api/admin/login', { email: boris.email, password: NEW })).status, 401, 'old password gone')
    assert.equal((await t.cabinet().call('POST', '/api/admin/login', { email: boris.email, password: reset.body.password })).body.next, 'password')
  })

  it('closes and opens access, never one\'s own', async () => {
    const vera = await addManager(t, 'vera@buysun.test')
    const { c: v } = await firstLogin(t, vera.email)
    assert.equal((await c.call('POST', `/api/admin/managers/${vera.id}/disable`)).body.manager.status, 'disabled')
    assert.equal((await v.call('GET', '/api/admin/leads')).status, 401)
    assert.equal((await t.cabinet().call('POST', '/api/admin/login', { email: vera.email, password: NEW })).status, 401)
    assert.equal((await c.call('POST', `/api/admin/managers/${vera.id}/enable`)).body.manager.status, 'active')
    assert.equal((await t.cabinet().call('POST', '/api/admin/login', { email: vera.email, password: NEW })).body.next, null)

    const me = (await c.call('GET', '/api/admin/managers')).body.items.find((m) => m.me)
    assert.equal((await c.call('POST', `/api/admin/managers/${me.id}/disable`)).status, 400)
    assert.equal((await c.call('POST', `/api/admin/managers/${me.id}/reset`)).status, 400)
    assert.equal((await c.call('POST', '/api/admin/managers/999999/reset')).status, 404)
    // Only for a logged-in manager, and only from the cabinet page
    assert.equal((await t.cabinet().call('GET', '/api/admin/managers')).status, 401)
    assert.equal((await c.call('POST', '/api/admin/managers', { name: 'X', email: 'x@buysun.test' }, { header: false })).status, 403)
  })
})

describe('cabinet anketas', () => {
  let t, c, leadId
  before(async () => {
    t = await startTestApp()
    await t.post('/api/leads/anketa', anketaPayload({ top: { selfieFocus: { x: 0.4, y: 0.3 } } }))
    await t.post('/api/leads/callback', { phone: '+7 701 000 00 09', consent: true })
    await t.settle()
    leadId = (await t.prisma.lead.findFirst({ where: { type: 'anketa' } })).id
    await addManager(t, 'anna@buysun.test')
    c = (await firstLogin(t, 'anna@buysun.test')).c
  })
  after(async () => { await t.close() })

  it('links the Bitrix24 lead to the anketa in the cabinet', async () => {
    const add = t.bitrixServer.calls.find((call) => call.method === 'crm.lead.add')
    assert.match(add.params.fields.COMMENTS, new RegExp(`Открыть и исправить анкету в кабинете:.*https://buysun\\.kz/admin/#/leads/${leadId}`))
  })

  it('lists and finds leads by name, phone and number', async () => {
    const all = await c.call('GET', '/api/admin/leads')
    assert.equal(all.body.total, 2)
    assert.equal(all.body.items.find((i) => i.type === 'anketa').position, 'Официант')
    assert.equal((await c.call('GET', '/api/admin/leads?q=petrov')).body.total, 1)
    assert.equal((await c.call('GET', '/api/admin/leads?q=8 777 123-45-67')).body.total, 1)
    // A phone typed as digits only, without "+": not taken for a lead number
    assert.equal((await c.call('GET', '/api/admin/leads?q=7771234567')).body.total, 1)
    assert.equal((await c.call('GET', '/api/admin/leads?q=87771234567')).body.total, 1)
    assert.equal((await c.call('GET', `/api/admin/leads?q=%23${leadId}`)).body.items[0].id, leadId)
    assert.equal((await c.call('GET', '/api/admin/leads?type=callback')).body.total, 1)
  })

  it('shows the anketa link and makes a new one that cuts off the old', async () => {
    const lead = (await c.call('GET', `/api/admin/leads/${leadId}`)).body
    assert.match(lead.share_token, /^[A-Za-z0-9_-]{32}$/)
    const renewed = await c.call('POST', `/api/admin/leads/${leadId}/share-link`)
    assert.equal(renewed.status, 200)
    assert.notEqual(renewed.body.share_token, lead.share_token)
    assert.equal((await fetch(`${t.base}/api/a/${lead.share_token}`)).status, 404)
    assert.equal((await fetch(`${t.base}/api/a/${renewed.body.share_token}`)).status, 200)
    // Short leads have no anketa to share
    const callback = await t.prisma.lead.findFirst({ where: { type: 'callback' } })
    assert.equal((await c.call('POST', `/api/admin/leads/${callback.id}/share-link`)).status, 400)
  })

  it('opens an anketa with its files, selfie position and Bitrix24 link', async () => {
    const lead = (await c.call('GET', `/api/admin/leads/${leadId}`)).body
    assert.equal(lead.answers.firstName, 'Ivan')
    assert.deepEqual(lead.files.map((f) => f.kind).sort(), ['full_body', 'pdf', 'selfie'])
    assert.deepEqual(lead.files.find((f) => f.kind === 'selfie').focus, { x: 0.4, y: 0.3 })
    assert.match(lead.bitrix_url, /^http:\/\/127\.0\.0\.1:\d+\/crm\/lead\/details\/\d+\/$/)
    const pdf = await c.call('GET', `/api/admin/leads/${leadId}/files/${lead.files.find((f) => f.kind === 'pdf').id}`)
    assert.equal(pdf.headers.get('content-type'), 'application/pdf')
    assert.deepEqual(pdf.body, PDF)
    // Downloaded under the candidate's name, like the partner and Canva files
    const download = await c.call('GET', `/api/admin/leads/${leadId}/files/${lead.files.find((f) => f.kind === 'pdf').id}?download=1`)
    assert.equal(download.headers.get('content-disposition'), `attachment; filename="${lead.answers.firstName}_${lead.answers.lastName}_BUYSUN.pdf"; filename*=UTF-8''${lead.answers.firstName}_${lead.answers.lastName}_BUYSUN.pdf`)
    const selfie = await c.call('GET', `/api/admin/leads/${leadId}/files/${lead.files.find((f) => f.kind === 'selfie').id}`)
    assert.match(selfie.headers.get('content-disposition'), /^inline; filename="Ivan_[A-Za-z]+_photo\.jpg"/)
  })

  it('saves an edited anketa with a new PDF and a replaced photo, and records who did it', async () => {
    const before = (await c.call('GET', `/api/admin/leads/${leadId}`)).body
    const oldFullBody = await t.prisma.leadFile.findFirst({ where: { lead_id: leadId, kind: 'full_body' } })
    const newPdf = Buffer.concat([PDF, Buffer.from('% edited\n')])
    const res = await c.call('PUT', `/api/admin/leads/${leadId}`, {
      answers: { ...before.answers, desiredPosition: 'bartender', lastName: 'Petrova', phone: '+7 777 123 45 67' },
      selfieFocus: { x: 0.5, y: 0.25 },
      files: { pdf: dataUrl('application/pdf', newPdf), full_body: dataUrl('image/jpeg', JPEG) },
    })
    assert.equal(res.status, 200)
    assert.equal(res.body.name, 'Ivan Petrova')
    assert.equal(res.body.answers.desiredPosition, 'bartender')
    assert.deepEqual(res.body.files.find((f) => f.kind === 'selfie').focus, { x: 0.5, y: 0.25 })
    assert.equal(res.body.files.filter((f) => f.kind === 'full_body').length, 1)
    assert.ok(!fs.existsSync(path.join(t.uploadDir, oldFullBody.path)), 'the replaced photo is deleted')
    const pdfFile = res.body.files.find((f) => f.kind === 'pdf')
    assert.deepEqual((await c.call('GET', `/api/admin/leads/${leadId}/files/${pdfFile.id}`)).body, newPdf)

    const [event] = res.body.events
    assert.equal(event.action, 'edited')
    assert.equal(event.user, 'Анна')
    assert.deepEqual(event.details.fields.sort(), ['Желаемая вакансия', 'Фамилия'])
    assert.deepEqual(event.details.files, ['фото в полный рост'])
  })

  it('refuses a save made over a newer change by another manager, keeping that change', async () => {
    await addManager(t, 'boris@buysun.test', { name: 'Борис' })
    const boris = (await firstLogin(t, 'boris@buysun.test')).c
    const opened = (await c.call('GET', `/api/admin/leads/${leadId}`)).body
    const openedByBoris = (await boris.call('GET', `/api/admin/leads/${leadId}`)).body
    assert.equal(opened.version, openedByBoris.version)
    const pdf = { pdf: dataUrl('application/pdf', PDF) }

    const first = await c.call('PUT', `/api/admin/leads/${leadId}`, { answers: { ...opened.answers, lastName: 'First' }, files: pdf, version: opened.version })
    assert.equal(first.status, 200)
    assert.ok(first.body.version > opened.version, 'a save makes a new version')
    const leadFiles = () => fs.readdirSync(path.join(t.uploadDir, 'leads', String(leadId))).length
    const filesBefore = leadFiles()

    const late = await boris.call('PUT', `/api/admin/leads/${leadId}`, { answers: { ...openedByBoris.answers, city: 'Shymkent' }, files: pdf, version: openedByBoris.version })
    assert.equal(late.status, 409)
    assert.match(late.body.error, /Анкету уже изменил\(а\) Анна.*обновите страницу/)
    const now = (await c.call('GET', `/api/admin/leads/${leadId}`)).body
    assert.equal(now.answers.lastName, 'First', 'the first change is kept')
    assert.equal(now.answers.city, opened.answers.city)
    assert.equal(leadFiles(), filesBefore, 'the refused save leaves no files behind')

    // After reloading, Boris saves from the new version
    const again = await boris.call('PUT', `/api/admin/leads/${leadId}`, { answers: { ...now.answers, city: 'Shymkent' }, files: pdf, version: now.version })
    assert.equal(again.status, 200)
    assert.equal(again.body.answers.lastName, 'First')
    assert.equal(again.body.answers.city, 'Shymkent')
  })

  it('refuses to edit a short form lead and bad files', async () => {
    const callback = await t.prisma.lead.findFirst({ where: { type: 'callback' } })
    const lead = (await c.call('GET', `/api/admin/leads/${leadId}`)).body
    const body = { answers: lead.answers, files: { pdf: dataUrl('application/pdf', PDF) } }
    assert.equal((await c.call('PUT', `/api/admin/leads/${callback.id}`, body)).status, 400)
    const png = Buffer.from('89504e470d0a1a0a0000', 'hex')
    assert.equal((await c.call('PUT', `/api/admin/leads/${leadId}`, { ...body, files: { ...body.files, selfie: dataUrl('image/jpeg', png) } })).status, 400)
    assert.equal((await c.call('GET', '/api/admin/leads/999999')).status, 404)
  })
})

describe('partner template', () => {
  let t, c
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  before(async () => {
    t = await startTestApp()
    await addManager(t, 'anna@buysun.test')
    c = (await firstLogin(t, 'anna@buysun.test')).c
  })
  after(async () => { await t.close() })

  it('is only for managers who are logged in', async () => {
    assert.equal((await t.cabinet().call('GET', '/api/admin/templates')).status, 401)
    assert.equal((await t.cabinet().call('POST', '/api/admin/templates', { name: 'X', header: 'X', contacts: '' })).status, 401)
  })

  it('keeps a template per partner, shared by all managers, with who saved it', async () => {
    assert.deepEqual((await c.call('GET', '/api/admin/templates')).body.items, [])
    const tayga = await c.call('POST', '/api/admin/templates', {
      name: 'TAYGA GRUP', header: 'TAYGA GRUP', contacts: '+90 532 000 00 00\ninfo@tayga.test', logo: dataUrl('image/png', PNG),
    })
    assert.equal(tayga.status, 201)
    assert.equal(tayga.body.template.updated_by, 'Анна')
    assert.equal(tayga.body.template.logo, dataUrl('image/png', PNG))

    // A second partner does not replace the first one; one name only once
    const patika = await c.call('POST', '/api/admin/templates', { name: 'PATIKA', header: '', contacts: '', logo: dataUrl('image/png', PNG) })
    assert.equal(patika.status, 201)
    assert.equal((await c.call('POST', '/api/admin/templates', { name: 'patika', header: 'P', contacts: '' })).status, 409)
    const id = tayga.body.template.id

    await addManager(t, 'boris@buysun.test')
    const boris = (await firstLogin(t, 'boris@buysun.test')).c
    assert.deepEqual((await boris.call('GET', '/api/admin/templates')).body.items.map((x) => x.name), ['PATIKA', 'TAYGA GRUP'])

    // Saving changes only that template; a missing logo keeps the saved one
    const renamed = await c.call('PUT', `/api/admin/templates/${id}`, { name: 'TAYGA', header: 'TAYGA GRUP', contacts: '' })
    assert.equal(renamed.status, 200)
    assert.equal(renamed.body.template.logo, dataUrl('image/png', PNG))
    assert.equal((await c.call('PUT', `/api/admin/templates/${id}`, { name: 'PATIKA', header: 'X', contacts: '' })).status, 409)

    // null removes the logo; a template cannot end up empty
    const noLogo = await c.call('PUT', `/api/admin/templates/${id}`, { name: 'TAYGA', header: 'TAYGA GRUP', contacts: '', logo: null })
    assert.equal(noLogo.body.template.logo, null)
    assert.equal((await c.call('PUT', `/api/admin/templates/${id}`, { name: 'TAYGA', header: '', contacts: '' })).status, 400)

    assert.equal((await c.call('DELETE', `/api/admin/templates/${id}`)).status, 200)
    assert.equal((await c.call('DELETE', `/api/admin/templates/${id}`)).status, 404)
    assert.equal((await c.call('PUT', '/api/admin/templates/abc', { name: 'X', header: 'X', contacts: '' })).status, 404)
    assert.deepEqual((await c.call('GET', '/api/admin/templates')).body.items.map((x) => x.name), ['PATIKA'])
  })

  it('refuses a logo that is not a PNG, too many lines and an empty name', async () => {
    const base = { name: 'P', header: 'P', contacts: '' }
    assert.equal((await c.call('POST', '/api/admin/templates', { ...base, logo: dataUrl('image/png', JPEG) })).status, 400)
    assert.equal((await c.call('POST', '/api/admin/templates', { ...base, logo: dataUrl('image/jpeg', JPEG) })).status, 400)
    assert.equal((await c.call('POST', '/api/admin/templates', { ...base, contacts: 'a\nb\nc\nd' })).status, 400)
    assert.equal((await c.call('POST', '/api/admin/templates', { ...base, name: ' ' })).status, 400)
    assert.equal((await c.call('POST', '/api/admin/templates', base, { header: false })).status, 403, 'not without the cabinet header')
  })
})

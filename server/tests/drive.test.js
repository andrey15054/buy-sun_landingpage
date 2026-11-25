const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { startTestApp, anketaPayload, dataUrl, JPEG, PDF } = require('./helpers')
const { hashPassword, totpFor } = require('../src/services/auth')

const TEMP = 'temporary-pass-1'
const NEW = 'my-new-password-2026'
const code = (secret, email) => totpFor(secret, email).generate()

async function login(t, email) {
  await t.prisma.user.create({ data: { email, name: 'Ахмед', password_hash: await hashPassword(TEMP) } })
  const c = t.cabinet()
  await c.call('POST', '/api/admin/login', { email, password: TEMP })
  await c.call('POST', '/api/admin/password', { password: NEW })
  const setup = await c.call('POST', '/api/admin/2fa/setup')
  await c.call('POST', '/api/admin/2fa/confirm', { code: code(setup.body.secret, email) })
  return c
}

// The manager clicks «Подключить», Google sends them back with a code
async function connect(t, c, { code: googleCode = 'good-code', state } = {}) {
  const start = await c.call('GET', '/api/admin/google/connect', undefined, { redirect: 'manual' })
  assert.equal(start.status, 302)
  const to = new URL(start.headers.get('location'))
  assert.equal(to.origin + to.pathname, 'https://accounts.google.test/auth')
  assert.equal(to.searchParams.get('scope'), 'openid email https://www.googleapis.com/auth/drive.file')
  assert.equal(to.searchParams.get('access_type'), 'offline')
  assert.equal(to.searchParams.get('redirect_uri'), 'https://buysun.kz/api/admin/google/callback')
  // Back from Google: a cross-site navigation, so no cabinet cookie
  const back = await fetch(`${t.base}/api/admin/google/callback?code=${googleCode}&state=${state ?? to.searchParams.get('state')}`, { redirect: 'manual' })
  assert.equal(back.status, 302)
  return new URLSearchParams(back.headers.get('location').split('?')[1])
}

describe('Google Drive', () => {
  let t, c, g
  before(async () => {
    t = await startTestApp({ google: true, bitrixEnabled: false, mailEnabled: false })
    g = t.googleServer
    c = await login(t, 'buysun@gmail.com')
  })
  after(async () => { await t.close() })

  const lead = (id) => t.prisma.lead.findUnique({ where: { id } })
  const root = async () => (await t.prisma.googleDrive.findUnique({ where: { id: 1 } })).folder_id

  it('keeps anketas on the site while Drive is not connected', async () => {
    assert.deepEqual((await c.call('GET', '/api/admin/google')).body, { configured: true, connected: false })
    await t.post('/api/leads/anketa', anketaPayload())
    await t.settle()
    assert.equal((await lead(1)).drive_status, 'skipped')
    // Only a logged-in manager can start the connection
    assert.equal((await fetch(`${t.base}/api/admin/google/connect`, { redirect: 'manual' })).status, 401)
  })

  it('refuses an answer from Google it did not ask for, or a refusal', async () => {
    const forged = await fetch(`${t.base}/api/admin/google/callback?code=good-code&state=made-up`, { redirect: 'manual' })
    assert.match(decodeURIComponent(forged.headers.get('location')), /error=Ссылка\+устарела/)
    const denied = await fetch(`${t.base}/api/admin/google/callback?error=access_denied`, { redirect: 'manual' })
    assert.match(new URLSearchParams(denied.headers.get('location').split('?')[1]).get('error'), /Доступ не дан/)
    const badCode = await connect(t, c, { code: 'bad-code' })
    assert.ok(badCode.get('error'))
    assert.equal(await t.prisma.googleDrive.count(), 0)
  })

  it('connects once and copies the anketas already on the site', async () => {
    const back = await connect(t, c)
    assert.equal(back.get('ok'), '1')
    const status = (await c.call('GET', '/api/admin/google')).body
    assert.equal(status.connected, true)
    assert.equal(status.email, 'buysun@gmail.com')
    assert.equal(g.files.get(await root()).name, 'BUY SUN — анкеты с сайта')

    await t.settle()
    const first = await lead(1)
    assert.equal(first.drive_status, 'sent')
    const folder = g.files.get(first.drive_folder_id)
    assert.match(folder.name, /^Ivan Petrov — \d\d\.\d\d\.\d{4} — анкета №1$/)
    assert.equal(folder.parents[0], await root())
    const inside = g.inFolder(first.drive_folder_id)
    assert.deepEqual(inside.map((f) => f.mime).sort(), ['application/pdf', 'image/jpeg', 'image/jpeg'])
    assert.ok(inside.find((f) => f.mime === 'application/pdf').name.endsWith('.pdf'))
    assert.equal(inside.find((f) => f.mime === 'application/pdf').size, PDF.length)
    const view = (await c.call('GET', '/api/admin/leads/1')).body
    assert.equal(view.drive_url, `https://drive.google.com/drive/folders/${first.drive_folder_id}`)
  })

  it('copies a new anketa right after it is sent, short leads stay off Drive', async () => {
    await t.post('/api/leads/anketa', anketaPayload())
    await t.post('/api/leads/callback', { phone: '+7 701 000 00 09', consent: true })
    await t.settle()
    assert.equal((await lead(2)).drive_status, 'sent')
    assert.equal(g.inFolder((await lead(2)).drive_folder_id).length, 3)
    assert.equal((await lead(3)).drive_status, 'skipped')
  })

  it('updates the same files when the anketa is edited in the cabinet', async () => {
    const before = await lead(2)
    const opened = (await c.call('GET', '/api/admin/leads/2')).body
    const newPdf = Buffer.concat([PDF, Buffer.from('% edited\n')])
    const res = await c.call('PUT', '/api/admin/leads/2', { answers: { ...opened.answers, lastName: 'Petrova' }, files: { pdf: dataUrl('application/pdf', newPdf) }, version: opened.version })
    assert.equal(res.status, 200)
    await t.settle()
    const after = await lead(2)
    assert.equal(after.drive_status, 'sent')
    assert.equal(after.drive_folder_id, before.drive_folder_id)
    const inside = g.inFolder(after.drive_folder_id)
    assert.equal(inside.length, 3, 'no second PDF next to the old one')
    const pdf = g.files.get(before.drive_files.pdf.drive_id)
    assert.equal(pdf.updated, true)
    assert.equal(pdf.size, newPdf.length)
    assert.equal(g.files.get(before.drive_files.selfie.drive_id).updated, undefined, 'photos not sent again')
  })

  it('makes the folder again if it was deleted in Drive', async () => {
    const before = await lead(2)
    g.removeFolder(before.drive_folder_id)
    const opened = (await c.call('GET', '/api/admin/leads/2')).body
    await c.call('PUT', '/api/admin/leads/2', { answers: opened.answers, files: { pdf: dataUrl('application/pdf', PDF), selfie: dataUrl('image/jpeg', JPEG) }, version: opened.version })
    await t.settle()
    const after = await lead(2)
    assert.equal(after.drive_status, 'sent')
    assert.notEqual(after.drive_folder_id, before.drive_folder_id)
    assert.equal(g.inFolder(after.drive_folder_id).length, 3)

    // Even the top folder deleted: a new one
    g.removeFolder(await root())
    await t.post('/api/leads/anketa', anketaPayload())
    await t.settle()
    const fresh = await lead(4)
    assert.equal(fresh.drive_status, 'sent')
    assert.equal(g.files.get(fresh.drive_folder_id).parents[0], await root())
  })

  it('says so when access to Drive was taken back in Google', async () => {
    g.fail.refresh = true
    // a fresh access token is needed: the server restarted
    const drive2 = require('../src/services/googleDrive').createGoogleDrive({ prisma: t.prisma, clientId: 'c', clientSecret: 's', redirectUri: 'x', urls: g.urls })
    await assert.rejects(drive2.sync(await lead(4), []), /отозван/)
    g.fail.refresh = false
  })

  it('disconnects: access given back to Google, new anketas stay on the site', async () => {
    const res = await c.call('DELETE', '/api/admin/google')
    assert.equal(res.body.connected, false)
    assert.ok(g.calls.some((call) => call.path === '/revoke'))
    await t.post('/api/leads/anketa', anketaPayload())
    await t.settle()
    assert.equal((await lead(5)).drive_status, 'skipped')
  })
})

import { useEffect, useState } from 'react'
import { api } from './api'
import { formatDate } from './common'
import { buildAnketaPdf } from '../anketaPdf'
import { downloadBlob, pdfName } from './download'

const EMPTY = { name: '', header: '', contacts: '', logo: null }
const MAX_LOGO_BYTES = 900 * 1024

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image()
  img.onload = () => resolve(img)
  img.onerror = reject
  img.src = src
})

const withSize = async (dataUrl) => {
  const img = await loadImage(dataUrl)
  return { dataUrl, width: img.naturalWidth, height: img.naturalHeight }
}

// Where the drawing is: skips transparent and white margins around a logo,
// so it is not shown tiny in the PDF
function contentBox(ctx, width, height) {
  const { data } = ctx.getImageData(0, 0, width, height)
  let top = height, left = width, right = -1, bottom = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const empty = data[i + 3] < 16 || (data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245)
      if (empty) continue
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
    }
  }
  if (right < 0) return { x: 0, y: 0, width, height }
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 }
}

// Any picture the browser can open becomes a PNG of at most 800 px without
// empty margins: keeps a transparent background, small enough for the server
async function logoFromFile(file) {
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    const naturalWidth = img.naturalWidth || 800
    const naturalHeight = img.naturalHeight || 400
    const first = Math.min(1, 1600 / Math.max(naturalWidth, naturalHeight))
    const full = document.createElement('canvas')
    full.width = Math.round(naturalWidth * first)
    full.height = Math.round(naturalHeight * first)
    const fullCtx = full.getContext('2d', { willReadFrequently: true })
    fullCtx.drawImage(img, 0, 0, full.width, full.height)
    const box = contentBox(fullCtx, full.width, full.height)

    for (const max of [800, 500, 300]) {
      const scale = Math.min(1, max / Math.max(box.width, box.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(box.width * scale))
      canvas.height = Math.max(1, Math.round(box.height * scale))
      canvas.getContext('2d').drawImage(full, box.x, box.y, box.width, box.height, 0, 0, canvas.width, canvas.height)
      const dataUrl = canvas.toDataURL('image/png')
      if (dataUrl.length * 0.75 < MAX_LOGO_BYTES) return { dataUrl, width: canvas.width, height: canvas.height }
    }
    throw new Error('too large')
  } finally {
    URL.revokeObjectURL(url)
  }
}

// The partner chosen last, so the next anketa opens with it
const LAST_KEY = 'buysun-partner'
const remember = (id) => {
  try {
    if (id) localStorage.setItem(LAST_KEY, String(id))
    else localStorage.removeItem(LAST_KEY)
  } catch { /* private mode: nothing to remember */ }
}
const remembered = () => {
  try { return Number(localStorage.getItem(LAST_KEY)) || null } catch { return null }
}

// The file for a partner: their logo, header and contacts instead of BUY SUN,
// without the BUY SUN manager's name. A template is kept per partner, shared
// by all managers.
function PartnerPanel({ build, waiting, dirty, onError }) {
  const [items, setItems] = useState(undefined) // undefined: loading
  const [saved, setSaved] = useState(null) // the chosen template; null: a new partner
  const [draft, setDraft] = useState(EMPTY)
  const [logoChanged, setLogoChanged] = useState(false)
  const [working, setWorking] = useState('')
  const [status, setStatus] = useState(null)

  const applyTemplate = async (template) => {
    setSaved(template)
    setDraft(template ? { ...template, logo: template.logo ? await withSize(template.logo) : null } : EMPTY)
    setLogoChanged(false)
    remember(template?.id)
  }

  useEffect(() => {
    api('GET', '/templates')
      .then(({ items: list }) => {
        setItems(list)
        return applyTemplate(list.find((x) => x.id === remembered()) || list[0] || null)
      })
      .catch((err) => { onError(err); setItems([]) })
  }, [onError])

  const choose = (e) => {
    const next = items.find((x) => x.id === Number(e.target.value)) || null
    if (changed && !window.confirm('Изменения в шаблоне не сохранены. Перейти к другому партнёру без них?')) return
    applyTemplate(next)
    setStatus(null)
  }

  const changed = saved
    ? draft.name !== saved.name || draft.header !== saved.header || draft.contacts !== saved.contacts || logoChanged
    : Boolean(draft.name || draft.header || draft.contacts || draft.logo)

  const set = (field) => (e) => {
    setDraft((d) => ({ ...d, [field]: e.target.value }))
    setStatus(null)
  }

  const changeLogo = async (e) => {
    const input = e.target
    const file = input.files[0]
    if (!file) return
    setWorking('logo')
    setStatus(null)
    try {
      const logo = await logoFromFile(file)
      setDraft((d) => ({ ...d, logo }))
      setLogoChanged(true)
    } catch {
      setStatus({ ok: false, text: 'Не удалось открыть логотип. Выберите PNG, JPG или SVG.' })
    } finally {
      input.value = ''
      setWorking('')
    }
  }

  const removeLogo = () => {
    setDraft((d) => ({ ...d, logo: null }))
    setLogoChanged(true)
    setStatus(null)
  }

  const download = async () => {
    setWorking('pdf')
    setStatus(null)
    try {
      const { answers, photos } = build()
      const blob = await buildAnketaPdf({ ...answers, ...photos }, { partner: draft })
      downloadBlob(blob, pdfName(answers, 'CV'))
    } catch {
      setStatus({ ok: false, text: 'Не удалось создать PDF. Попробуйте ещё раз.' })
    } finally {
      setWorking('')
    }
  }

  // TAYGA GRUP's own Word form, filled in (loaded only when asked: the form
  // file and the zip code are not needed for anything else)
  const downloadTayga = async () => {
    setWorking('tayga')
    setStatus(null)
    try {
      const { answers, photos } = build()
      const { buildTaygaDocx, taygaFileName } = await import('./partnerForms/taygaDocx')
      downloadBlob(await buildTaygaDocx(answers, photos), taygaFileName(answers))
    } catch (err) {
      setStatus({ ok: false, text: err.message?.startsWith('Бланк') ? err.message : 'Не удалось заполнить бланк TAYGA. Попробуйте ещё раз.' })
    } finally {
      setWorking('')
    }
  }

  const save = async () => {
    if (!draft.name.trim()) return setStatus({ ok: false, text: 'Укажите название партнёра, чтобы сохранить шаблон.' })
    setWorking('save')
    setStatus(null)
    try {
      const body = { name: draft.name, header: draft.header, contacts: draft.contacts }
      if (logoChanged || !saved) body.logo = draft.logo ? draft.logo.dataUrl : null
      const { template } = saved
        ? await api('PUT', `/templates/${saved.id}`, body)
        : await api('POST', '/templates', body)
      setItems((list) => [...list.filter((x) => x.id !== template.id), template]
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')))
      await applyTemplate(template)
      setStatus({ ok: true, text: 'Шаблон сохранён' })
    } catch (err) {
      onError(err)
      setStatus({ ok: false, text: err.message || 'Не удалось сохранить шаблон' })
    } finally {
      setWorking('')
    }
  }

  const remove = async () => {
    if (!window.confirm(`Удалить шаблон «${saved.name}»?`)) return
    try {
      await api('DELETE', `/templates/${saved.id}`)
      const rest = items.filter((x) => x.id !== saved.id)
      setItems(rest)
      await applyTemplate(rest[0] || null)
      setStatus({ ok: true, text: 'Шаблон удалён' })
    } catch (err) {
      onError(err)
      setStatus({ ok: false, text: err.message })
    }
  }

  return (
    <section className="cab-section cab-partner" id="partner">
      <h2>Файл для партнёра</h2>
      <p className="cab-hint">
        Вверху файла вместо BUY SUN будут логотип, шапка и контакты партнёра.
        Имя менеджера и другие служебные поля в файл не попадают.
      </p>

      <div className="cab-partner-grid">
        <div>
          {items?.length > 0 && (
            <label className="cab-field">
              <span>Шаблон</span>
              <select value={saved?.id ?? ''} onChange={choose} disabled={Boolean(working)}>
                {items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                <option value="">+ Новый партнёр</option>
              </select>
            </label>
          )}
          <label className="cab-field">
            <span>Название партнёра (в файл не попадает)</span>
            <input value={draft.name} onChange={set('name')} maxLength={80} placeholder="Например, Antalya Staff" />
          </label>
          <div className="cab-field">
            <span>Логотип</span>
            <div className="cab-logo-row">
              <label className="cab-btn secondary cab-file">
                {draft.logo ? 'Заменить логотип' : 'Выбрать логотип'}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={changeLogo} />
              </label>
              {draft.logo && <button type="button" className="cab-link" onClick={removeLogo}>Убрать</button>}
              {working === 'logo' && <span className="cab-hint">Обрабатываем…</span>}
            </div>
          </div>
          <label className="cab-field">
            <span>Шапка</span>
            <input value={draft.header} onChange={set('header')} maxLength={120} placeholder="Название компании партнёра" />
          </label>
          <label className="cab-field">
            <span>Контакты (до 3 строк)</span>
            <textarea
              rows={3}
              value={draft.contacts}
              onChange={(e) => { if (e.target.value.split('\n').length <= 3) set('contacts')(e) }}
              maxLength={300}
              placeholder={'+90 532 000 00 00\ninfo@partner.com\nAntalya, Türkiye'}
            />
          </label>
        </div>

        <div>
          <span className="cab-preview-title">Так будет вверху первой страницы</span>
          <PartnerPreview partner={draft} />
        </div>
      </div>

      {dirty && <p className="cab-hint cab-warn">В файл попадут данные анкеты так, как они сейчас на экране, даже несохранённые.</p>}

      <div className="cab-partner-actions">
        <button type="button" className="cab-btn" onClick={download} disabled={waiting || Boolean(working)}>
          {working === 'pdf' ? 'Создаём PDF…' : 'Скачать PDF для партнёра'}
        </button>
        <button type="button" className="cab-btn secondary" onClick={save} disabled={!changed || Boolean(working)}>
          {working === 'save' ? 'Сохраняем…' : saved ? 'Сохранить шаблон' : 'Сохранить как новый шаблон'}
        </button>
        <span className="cab-partner-status" role="status">
          {status ? <span className={status.ok ? 'cab-ok' : 'cab-error'}>{status.text}</span>
            : items === undefined ? 'Загружаем шаблоны…'
            : saved ? <>Шаблон «{saved.name}» сохранён{saved.updated_by && `, ${saved.updated_by}`}, {formatDate(saved.updated_at)}{changed && ' · есть несохранённые изменения'}</>
            : 'Новый партнёр: шаблон пока не сохранён'}
        </span>
        {saved && !changed && <button type="button" className="cab-link" onClick={remove}>Удалить шаблон</button>}
        {saved && changed && <button type="button" className="cab-link" onClick={() => { applyTemplate(saved); setStatus(null) }}>Вернуть сохранённый</button>}
      </div>

      <div className="cab-partner-forms">
        <div>
          <span className="cab-preview-title">Бланк партнёра в его оформлении</span>
          <p className="cab-hint">Собственный бланк TAYGA GRUP (Word), заполненный ответами и фото кандидата. Перед отправкой его можно поправить в Word; строку PC skills анкета не спрашивает — её заполняют вручную.</p>
        </div>
        <button type="button" className="cab-btn secondary" onClick={downloadTayga} disabled={waiting || Boolean(working)}>
          {working === 'tayga' ? 'Заполняем бланк…' : 'Анкета TAYGA GRUP (Word)'}
        </button>
      </div>
    </section>
  )
}

// A small copy of the top of the PDF: the dark column with the photo on the
// left, the partner's block where the BUY SUN logo usually is
function PartnerPreview({ partner }) {
  const contacts = partner.contacts.split('\n').map((l) => l.trim()).filter(Boolean)
  const hasText = Boolean(partner.header.trim() || contacts.length)
  return (
    <div className="cab-preview" aria-hidden="true">
      <div className="cab-preview-left"><div className="cab-preview-photo" /></div>
      <div className="cab-preview-right">
        <div className={`cab-preview-head${partner.logo && hasText ? ' row' : ''}`}>
          {partner.logo && <img src={partner.logo.dataUrl} alt="" />}
          {hasText && (
            <div className="cab-preview-text">
              {partner.header.trim() && <b>{partner.header}</b>}
              {contacts.map((line, i) => <small key={i}>{line}</small>)}
            </div>
          )}
          {!partner.logo && !hasText && <span className="cab-preview-empty">Пусто: файл без шапки</span>}
        </div>
        <div className="cab-preview-name" />
        <div className="cab-preview-line" />
        <div className="cab-preview-line short" />
      </div>
    </div>
  )
}

export default PartnerPanel

// The anketa written into TAYGA GRUP's own CV form (tayga.docx, the Word file
// they gave): their layout and logo stay exactly as they are, only the empty
// cells get the candidate's answers and the photo goes into the frame on the
// right. The result is a normal Word file the manager can still edit.
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate'
import templateUrl from './tayga.docx?url'
import { defaultFocus } from '../../photoUtils'
import { positionEn } from '../../positions'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const NS = {
  w: W,
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
}
const PHOTO_REL = 'rIdCandidatePhoto'
const PHOTO_FILE = 'media/candidate-photo.jpeg'

// The form is in English and Turkish: answers stored as codes become English
const MARITAL = { single: 'Single', married: 'Married', divorced: 'Divorced' }

const clean = (v) => (v === undefined || v === null ? '' : String(v).trim())
const range = (a, b) => [clean(a), clean(b)].filter(Boolean).join(' - ')
const dateDots = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(clean(iso)) ? iso.split('-').reverse().join('.') : clean(iso))
const capital = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '')

// Every cell this form has, by row, with the label the row must start with
// (if TAYGA ever sends a changed form, filling stops instead of guessing)
function values(a) {
  const job = (n) => [range(a[`workStart${n}`], a[`workEnd${n}`]), [clean(a[`company${n}`]), clean(a[`country${n}`])].filter(Boolean).join(', '), clean(a[`position${n}`])]
  const hobbies = [clean(a.hobbies), clean(a.courses) && clean(a.courses) !== '-' ? `Courses, certificates: ${clean(a.courses)}` : ''].filter(Boolean).join('. ')
  const season = a.startMonth && a.startDay && a.endMonth && a.endDay ? ` (${a.startDay}.${a.startMonth} – ${a.endDay}.${a.endMonth})` : ''
  const other = clean(a.additionalLanguage) ? `${capital(clean(a.additionalLanguage))}${a.additionalLanguageLevel ? ` — ${a.additionalLanguageLevel}` : ''}` : ''
  return [
    { row: 2, label: 'Full name', cells: { 1: [clean(a.firstName), clean(a.lastName)].filter(Boolean).join(' ') } },
    { row: 3, label: 'Position', cells: { 1: clean(a.desiredPosition) && positionEn(clean(a.desiredPosition)) } },
    { row: 4, label: 'Hight', cells: { 1: clean(a.height) && `${clean(a.height)} cm`, 3: clean(a.weight) && `${clean(a.weight)} kg` } },
    { row: 5, label: 'Date of birth', cells: { 1: dateDots(a.birthDate), 3: MARITAL[a.maritalStatus] || capital(clean(a.maritalStatus)) } },
    { row: 6, label: 'Address', cells: { 1: clean(a.city) } },
    { row: 9, label: '', cells: { 0: range(a.studyStart, a.studyEnd), 1: clean(a.institution), 2: clean(a.specialty) } },
    { row: 12, label: '', cells: Object.assign({}, job(1)) },
    { row: 13, label: '', cells: Object.assign({}, job(2)) },
    { row: 14, label: '', cells: Object.assign({}, job(3)) },
    { row: 17, label: 'Russian', cells: { 1: clean(a.russian) } },
    { row: 18, label: 'English', cells: { 1: clean(a.english) } },
    { row: 19, label: 'Turkish', cells: { 1: clean(a.turkish) } },
    { row: 20, label: 'Other', cells: { 1: other } },
    { row: 23, label: 'Hobi', cells: { 1: hobbies } },
    { row: 25, label: 'Select pls', cells: { 1: `${a.readyToWorkPermanently ? '1 year' : '6 months'}${season}` } },
  ]
}

const textOf = (el) => [...el.getElementsByTagNameNS(W, 't')].map((t) => t.textContent).join('')

// Puts the text into the cell's paragraph in the form's own type (12 pt)
function writeCell(doc, tc, text) {
  const p = tc.getElementsByTagNameNS(W, 'p')[0]
  for (const child of [...p.childNodes]) if (child.localName !== 'pPr') p.removeChild(child)
  if (!text) return
  const r = doc.createElementNS(W, 'w:r')
  const markProps = p.getElementsByTagNameNS(W, 'pPr')[0]?.getElementsByTagNameNS(W, 'rPr')[0]
  const rPr = markProps ? markProps.cloneNode(true) : doc.createElementNS(W, 'w:rPr')
  for (const tag of ['sz', 'szCs']) {
    let el = rPr.getElementsByTagNameNS(W, tag)[0]
    if (!el) { el = doc.createElementNS(W, `w:${tag}`); rPr.appendChild(el) }
    el.setAttributeNS(W, 'w:val', text.length > 90 ? '20' : '24')
  }
  r.appendChild(rPr)
  const t = doc.createElementNS(W, 'w:t')
  t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve')
  t.textContent = text
  r.appendChild(t)
  p.appendChild(r)
}

// The selfie cut to the 3:4 frame of the form, around the face
async function portrait(photo) {
  const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = photo.dataUrl })
  const focus = photo.focus || defaultFocus(photo.width, photo.height)
  let w = photo.width, h = (photo.width * 4) / 3
  if (h > photo.height) { h = photo.height; w = (h * 3) / 4 }
  const x = Math.min(Math.max(focus.x * photo.width - w / 2, 0), photo.width - w)
  const y = Math.min(Math.max(focus.y * photo.height - h / 2.6, 0), photo.height - h)
  const canvas = document.createElement('canvas')
  canvas.width = 600; canvas.height = 800
  canvas.getContext('2d').drawImage(img, x, y, w, h, 0, 0, 600, 800)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.88))
  return new Uint8Array(await blob.arrayBuffer())
}

function photoRun(doc) {
  const cx = 1656000, cy = 2208000 // 4.6 × 6.1 cm, inside the 5.4 × 6.8 cm frame
  const xml = `<w:r xmlns:w="${NS.w}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}" xmlns:r="${NS.r}"><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="1001" name="Candidate photo"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="${NS.pic}"><pic:pic><pic:nvPicPr><pic:cNvPr id="1001" name="candidate-photo.jpeg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${PHOTO_REL}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  return doc.importNode(new DOMParser().parseFromString(xml, 'application/xml').documentElement, true)
}

// Aigerim_Nurlanova_TAYGA.docx
export const taygaFileName = (answers) => {
  const name = [answers.firstName, answers.lastName].map((s) => clean(s)).filter(Boolean).join('_')
  return `${name.replace(/[^\p{L}\p{N}_-]+/gu, '_') || 'Anketa'}_TAYGA.docx`
}

// answers: the anketa as on the screen; photos.selfiePhoto: { dataUrl, width, height, focus }
export async function buildTaygaDocx(answers, photos = {}) {
  const template = new Uint8Array(await (await fetch(templateUrl)).arrayBuffer())
  const files = unzipSync(template)
  const doc = new DOMParser().parseFromString(strFromU8(files['word/document.xml']), 'application/xml')
  const table = doc.getElementsByTagNameNS(W, 'tbl')[0]
  const rows = [...table.childNodes].filter((n) => n.localName === 'tr')
  const cellsOf = (tr) => [...tr.childNodes].filter((n) => n.localName === 'tc')

  for (const { row, label, cells } of values(answers)) {
    const tcs = cellsOf(rows[row])
    if (label && !textOf(tcs[0]).startsWith(label)) throw new Error(`Бланк TAYGA изменился: в строке ${row + 1} нет «${label}»`)
    for (const [i, text] of Object.entries(cells)) writeCell(doc, tcs[Number(i)], text)
  }

  if (photos.selfiePhoto) {
    const frame = cellsOf(rows[0])[1]
    const p = frame.getElementsByTagNameNS(W, 'p')[0]
    let pPr = p.getElementsByTagNameNS(W, 'pPr')[0]
    if (!pPr) { pPr = doc.createElementNS(W, 'w:pPr'); p.insertBefore(pPr, p.firstChild) }
    const jc = doc.createElementNS(W, 'w:jc'); jc.setAttributeNS(W, 'w:val', 'center')
    pPr.insertBefore(jc, pPr.getElementsByTagNameNS(W, 'rPr')[0] || null)
    p.appendChild(photoRun(doc))
    files[`word/${PHOTO_FILE}`] = await portrait(photos.selfiePhoto)
    const rels = strFromU8(files['word/_rels/document.xml.rels'])
    files['word/_rels/document.xml.rels'] = strToU8(rels.replace('</Relationships>',
      `<Relationship Id="${PHOTO_REL}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${PHOTO_FILE}"/></Relationships>`))
    const types = strFromU8(files['[Content_Types].xml'])
    if (!/Extension="jpeg"/i.test(types)) {
      files['[Content_Types].xml'] = strToU8(types.replace(/(<Types[^>]*>)/, '$1<Default Extension="jpeg" ContentType="image/jpeg"/>'))
    }
  }

  files['word/document.xml'] = strToU8(new XMLSerializer().serializeToString(doc))
  return new Blob([zipSync(files, { level: 6 })], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
}

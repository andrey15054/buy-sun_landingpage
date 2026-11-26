import { applyPdfFonts, TITLE_FONT, TEXT_FONT } from './pdfFonts'
import { cropRoundPhoto, fitInBox } from './photoUtils'
import logoAnketa from '/logo_anketa.png'

// The partner's logo, header and contacts in the place of the BUY SUN logo.
// box: the area at the top of the right column, in mm.
function drawPartnerHeader(pdf, { logo, header, contacts }, box) {
  const headerText = (header || '').trim()
  const contactLines = (contacts || '').split('\n').map((l) => l.trim()).filter(Boolean)
  const hasText = Boolean(headerText || contactLines.length)

  let textX = box.x
  let textWidth = box.width
  if (logo) {
    // Next to the text the logo takes the left part, alone it is centered
    const size = fitInBox(logo.width, logo.height, hasText ? 48 : 80, box.height)
    const x = hasText ? box.x : box.x + (box.width - size.width) / 2
    pdf.addImage(logo.dataUrl, 'PNG', x, box.y + (box.height - size.height) / 2, size.width, size.height)
    textX = box.x + size.width + 6
    textWidth = box.width - size.width - 6
  }
  if (!hasText) return

  const ptToMm = 0.3528 * 1.15
  // The header on one line if it fits down to 12 pt, otherwise two lines of 14 pt
  pdf.setFont(undefined, 'bold')
  let headerSize = 14
  let headerLines = []
  if (headerText) {
    const oneLine = [16, 15, 14, 13, 12].find((size) => {
      pdf.setFontSize(size)
      return pdf.getTextWidth(headerText) <= textWidth
    })
    if (oneLine) {
      headerSize = oneLine
      headerLines = [headerText]
    } else {
      pdf.setFontSize(headerSize)
      headerLines = pdf.splitTextToSize(headerText, textWidth).slice(0, 2)
    }
  }
  pdf.setFont(undefined, 'normal')
  pdf.setFontSize(10)
  const contactRows = contactLines.flatMap((l) => pdf.splitTextToSize(l, textWidth)).slice(0, 4)
  const headerHeight = headerLines.length * headerSize * ptToMm
  const gap = headerLines.length && contactRows.length ? 1.5 : 0
  const height = headerHeight + gap + contactRows.length * 10 * ptToMm

  const center = !logo
  const x = center ? box.x + box.width / 2 : textX
  const options = { baseline: 'top', align: center ? 'center' : 'left' }
  let y = box.y + Math.max(0, (box.height - height) / 2)
  if (headerLines.length) {
    pdf.setFont(undefined, 'bold')
    pdf.setFontSize(headerSize)
    pdf.setTextColor(20, 20, 20)
    pdf.text(headerLines, x, y, options)
    y += headerHeight + gap
  }
  if (contactRows.length) {
    pdf.setFont(undefined, 'normal')
    pdf.setFontSize(10)
    pdf.setTextColor(90, 90, 90)
    pdf.text(contactRows, x, y, options)
  }
}

// The anketa PDF exactly as candidates get it, in the agency's Canva template
// («Копия резюме для турции»): a blue left column with the round photo, the
// name, personal details, education, courses and interests; on the right the
// logo, the vacancy, up to three jobs and the languages; the photos on the
// next page. Used by the form on the site and by the manager cabinet, so an
// edited anketa looks the same.
// formData: the anketa answers plus selfiePhoto, fullBodyPhoto and
// additionalPhoto1..3 as { dataUrl, width, height, focus? }. Returns a Blob.
// partner: { logo: { dataUrl, width, height } | null, header, contacts } makes
// the file for a partner: their header instead of BUY SUN.
// All sizes are in mm, measured on the template.

const PAGE_W = 210
const PAGE_H = 297
const COL_W = 82.6 // the blue column
const BLUE = [51, 83, 132] // #335384, as in the template
const WHITE = [255, 255, 255]
const BLACK = [0, 0, 0]
const PT = 25.4 / 72 // one point in mm

// The answers in words, as the template shows them
const POSITIONS = {
  waiter: 'Waiter', bartender: 'Bartender', receptionist: 'Receptionist', housekeeping: 'Housekeeping',
  kitchen: 'Kitchen', animator: 'Animator', other: 'Other',
}
const MARITAL = { single: 'Single', married: 'Married', divorced: 'Divorced' }
const clean = (v) => {
  const text = String(v ?? '').trim()
  return text === '-' || text === '—' ? '' : text
}
const capitalize = (v) => (v ? v.charAt(0).toUpperCase() + v.slice(1) : v)
// 2002-06-18 → 18.06.2002
const dateText = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(v))
  return m ? `${m[3]}.${m[2]}.${m[1]}` : clean(v)
}
const range = (from, to) => (from && to ? `${from} – ${to}` : from || to || '')
// Height as candidates type it: «164», «164 см», «1.64» or «1,64» (metres)
// all print as «164 cm»; something else is printed as typed
const heightText = (v) => {
  const text = clean(v)
  const n = Number(text.replace(',', '.').replace(/\s*(cm|см|m|м)\.?$/i, ''))
  if (!text || !Number.isFinite(n) || n <= 0) return text
  return `${Math.round(n < 3 ? n * 100 : n)} cm`
}
const weightText = (v) => {
  const text = clean(v)
  const n = Number(text.replace(',', '.').replace(/\s*(kg|кг)\.?$/i, ''))
  return text && Number.isFinite(n) && n > 0 ? `${Number(n.toFixed(1))} kg` : text
}
// «Нет», «No», «Yok», «Жоқ» in courses or hobbies mean nothing to print
const NOTHING = /^(нет|нету|no|none|nope|yok|yoktur|жоқ|n\/?a|-+|—|\.+)[.!]*$/i
const meaningful = (v) => (NOTHING.test(clean(v)) ? '' : clean(v))

export async function buildAnketaPdf(formData, { partner } = {}) {
  // Loaded only when needed: keeps 400 KB of PDF code out of the first page load
  const { default: jsPDF } = await import('jspdf')
  const pdf = new jsPDF('p', 'mm', 'a4')
  await applyPdfFonts(pdf)
  const f = (key) => clean(formData[key])

  // Labels and headings: the template's wide capitals, spaced out on the right
  const title = (size, color, space = 0) => {
    pdf.setFont(TITLE_FONT, 'normal'); pdf.setFontSize(size); pdf.setTextColor(...color); pdf.setCharSpace(space)
  }
  // Values in the same bold font as the labels: Ahmed asked for one font on
  // the whole anketa, a thin font after a bold label was hard to read
  const text = (size, color) => { pdf.setFont(TITLE_FONT, 'normal'); pdf.setFontSize(size); pdf.setTextColor(...color); pdf.setCharSpace(0) }
  // jsPDF leaves the letter spacing out of the width
  const titleWidth = (str) => pdf.getTextWidth(str) + pdf.getCharSpace() * str.length
  const lineH = (size) => size * PT * 1.2

  const paintPage = () => {
    pdf.setFillColor(...BLUE)
    pdf.rect(0, 0, COL_W, PAGE_H, 'F')
  }
  paintPage()

  // A label and its value on one line; a value that does not fit goes on to
  // the next lines from the left edge. Returns the height used.
  // dry: only measures, so the right column can be fitted to the page first
  const labelled = (label, value, { x, y, right, size = 12, labelSize = size, space = 0, color, below = false, dry = false }) => {
    title(labelSize, color, space)
    if (!dry) pdf.text(`${label}:`, x, y, { baseline: 'top' })
    const labelEnd = x + titleWidth(`${label}:`) + 2
    text(size, color)
    const v = String(value)
    if (!below && pdf.getTextWidth(v) <= right - labelEnd) {
      // On the label's line: both letters stand on one baseline
      if (!dry) pdf.text(v, labelEnd, y + (labelSize - size) * PT * 0.75, { baseline: 'top' })
      return lineH(size)
    }
    const lines = pdf.splitTextToSize(v, right - x)
    if (!dry) pdf.text(lines, x, y + lineH(size), { baseline: 'top', lineHeightFactor: 1.2 })
    return lineH(size) * (1 + lines.length)
  }

  // ========== LEFT COLUMN ==========
  const leftX = 6.2
  const leftRight = COL_W - 3
  const leftCenter = COL_W / 2
  if (formData.selfiePhoto) {
    const round = await cropRoundPhoto(formData.selfiePhoto, BLUE)
    pdf.addImage(round, 'JPEG', leftCenter - 33, 4, 66, 66)
  }
  let leftY = 74

  const heading = (label, x, y) => {
    const left = x === leftCenter
    title(17, left ? WHITE : BLACK, left ? 0 : 0.3)
    pdf.text(label, x - titleWidth(label) / 2, y, { baseline: 'top' })
  }

  heading('PERSONAL DETAILS', leftCenter, leftY)
  leftY += 12
  const personal = [
    ['DATE OF BIRTH', dateText(formData.birthDate)],
    ['HEIGHT', heightText(formData.height)],
    ['WEIGHT', weightText(formData.weight)],
    ['MARITAL STATUS', MARITAL[f('maritalStatus')] || capitalize(f('maritalStatus'))],
    ['START FINISH', f('startDay') && f('startMonth') && f('endDay') && f('endMonth')
      ? `${f('startDay')}.${f('startMonth')} – ${f('endDay')}.${f('endMonth')}` : ''],
    ['CITIZENSHIP', f('citizenship')],
    ['CITY', f('city')],
  ]
  for (const [label, value] of personal) {
    if (!value) continue
    leftY += labelled(label, value, { x: leftX, y: leftY, right: leftRight, labelSize: 12.5, color: WHITE }) + 4.6
  }

  const education = [
    ['NAME OF EMPLOYER', f('institution')],
    ['MAJOR', f('specialty')],
    ['DATE', range(f('studyStart'), f('studyEnd'))],
  ].filter(([, v]) => v)
  if (education.length) {
    leftY += 4
    heading('EDUCATION', leftCenter, leftY)
    leftY += 12
    for (const [label, value] of education) {
      leftY += labelled(label, value, { x: leftX, y: leftY, right: leftRight, labelSize: 12.5, color: WHITE, below: true }) + 4.6
    }
  }

  // Courses and hobbies at the bottom of the column, smaller if they are long
  const interests = [meaningful(formData.courses), meaningful(formData.hobbies)].filter(Boolean)
  if (interests.length) {
    leftY += 4
    title(12.5, WHITE, 0.2)
    pdf.text('COURSES AND INTERESTS', leftX, leftY, { baseline: 'top' })
    leftY += 9
    const room = PAGE_H - 8 - leftY
    let size = 12
    let lines
    for (;;) {
      text(size, WHITE)
      lines = interests.flatMap((p) => pdf.splitTextToSize(p, leftRight - leftX))
      if (lines.length * lineH(size) <= room || size <= 8) break
      size -= 0.5
    }
    const fit = Math.max(1, Math.floor(room / lineH(size)))
    if (lines.length > fit) lines = [...lines.slice(0, fit - 1), `${lines[fit - 1].replace(/\s*\S*$/, '')}…`]
    pdf.text(lines, leftX, leftY, { baseline: 'top', lineHeightFactor: 1.2 })
  }

  // ========== RIGHT COLUMN ==========
  const rightX = 89.6
  const rightEnd = 206.8
  const rightCenter = (COL_W + PAGE_W) / 2
  const bottom = PAGE_H - 10
  let rightY = 0
  // A long anketa (long places of work) goes on to the next page instead of
  // being cut off
  const roomFor = (height) => {
    if (rightY + height <= bottom) return
    pdf.addPage()
    paintPage()
    rightY = 14
  }

  if (partner) {
    pdf.setFont(TEXT_FONT, 'normal')
    drawPartnerHeader(pdf, partner, { x: rightX, y: 6, width: rightEnd - rightX, height: 32 })
  } else {
    const logo = pdf.getImageProperties(logoAnketa)
    const size = fitInBox(logo.width, logo.height, 60.7, 27.9)
    pdf.addImage(logoAnketa, 'PNG', 147 - size.width / 2, 7.9 + (27.9 - size.height) / 2, size.width, size.height)
  }

  // The candidate's name between the logo and the vacancy, as Ahmed asked.
  // Smaller for a long name, so it stays within two lines.
  const name = [f('firstName'), f('lastName')].filter(Boolean).join(' ')
  if (name) {
    let size = 22
    let lines
    for (;;) {
      title(size, BLUE, 0.3)
      lines = pdf.splitTextToSize(name.toUpperCase(), rightEnd - rightX - 10)
      if (lines.length <= 2 || size <= 13) break
      size -= 1
    }
    const height = lines.length * size * PT * 1.15
    const top = 39 + (21 - height) / 2
    lines.forEach((line, i) => {
      pdf.text(line, rightCenter - titleWidth(line) / 2, top + i * size * PT * 1.15, { baseline: 'top' })
    })
  }

  rightY = 63
  const position = POSITIONS[f('desiredPosition')] || capitalize(f('desiredPosition'))
  if (position) {
    rightY += labelled('POSITION', position, { x: 87.8, y: rightY, right: rightEnd, size: 14, labelSize: 16, color: BLACK }) + 8
  } else {
    rightY += 15
  }

  const rowOptions = { x: rightX, right: rightEnd, labelSize: 13, space: 0.3, color: BLACK }
  let gap = 4.4 // between rows; less for a long anketa, see below
  const row = (label, value) => {
    if (!value) return
    text(12, BLACK)
    roomFor(lineH(12) + 1)
    rightY += labelled(label, value, { ...rowOptions, y: rightY }) + gap
  }
  const divider = () => {
    pdf.setDrawColor(...BLACK)
    pdf.setLineWidth(0.9)
    pdf.line(rightX, rightY + 3.2, rightEnd, rightY + 3.2)
    rightY += 9.5
  }

  const jobs = [1, 2, 3]
    .map((n) => ({
      position: f(`position${n}`),
      company: f(`company${n}`),
      period: range(f(`workStart${n}`), f(`workEnd${n}`)),
      country: f(`country${n}`),
    }))
    .filter((j) => j.position || j.company || j.country)
  const languages = [
    ['ENGLISH', f('english')],
    ['TÜRKÇE', f('turkish')],
    ['RUSSIAN', f('russian')],
    [f('additionalLanguage').toUpperCase(), f('additionalLanguage') && f('additionalLanguageLevel')],
  ].filter(([label, v]) => label && v)

  // Three jobs with long places of work: the rows move closer together so the
  // languages still fit on the first page
  {
    const measure = (label, value) => (value ? labelled(label, value, { ...rowOptions, y: 0, dry: true }) : null)
    const heights = [
      ...jobs.flatMap((j) => [measure('POSITION', j.position), measure('PLACE OF WORK', j.company), measure('WORK PERIOD', j.period), measure('COUNTRY', j.country)]),
      ...languages.map(([label, value]) => measure(label, value)),
    ].filter((h) => h !== null)
    const fixed = (jobs.length ? 10.5 + jobs.length * 9.5 : 0) + (languages.length ? 18 : 0)
    const free = bottom - rightY - fixed - heights.reduce((a, b) => a + b, 0)
    if (heights.length) gap = Math.max(1.2, Math.min(4.4, (free - 8) / heights.length))
  }
  if (jobs.length) {
    roomFor(10.5 + 4 * (lineH(12) + gap))
    heading('EXPERIENCE', rightCenter, rightY - 0.2)
    rightY += 10.5
    for (const job of jobs) {
      roomFor(4 * (lineH(12) + gap)) // a job is kept together on one page when it fits
      row('POSITION', job.position)
      row('PLACE OF WORK', job.company)
      row('WORK PERIOD', job.period)
      row('COUNTRY', job.country)
      divider()
    }
  }

  if (languages.length) {
    roomFor(18 + languages.length * (lineH(12) + gap))
    rightY += 2
    heading('LANGUAGES', rightCenter, rightY)
    rightY += 16
    for (const [label, value] of languages) row(label, value)
  }

  // ========== PHOTO PAGE ==========
  // Up to four photos, two by two, as in the agency's own anketas: the full
  // body and three more. With fewer of them the selfie fills a free cell.
  let photos = [formData.fullBodyPhoto, formData.additionalPhoto1, formData.additionalPhoto2, formData.additionalPhoto3].filter(Boolean)
  if (photos.length < 4 && formData.selfiePhoto) photos = [formData.selfiePhoto, ...photos]
  if (photos.length > 0) {
    pdf.addPage()
    const margin = 4
    const gapBetween = 3
    const cols = photos.length === 1 ? 1 : 2
    const rows = Math.ceil(photos.length / cols)
    const cellW = (PAGE_W - margin * 2 - gapBetween * (cols - 1)) / cols
    const cellH = (PAGE_H - margin * 2 - gapBetween * (rows - 1)) / rows
    // The whole photo fits in its cell, so a head or feet are never cut off
    photos.forEach((photo, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      const x = margin + col * (cellW + gapBetween)
      const y = margin + row * (cellH + gapBetween)
      const { width, height } = fitInBox(photo.width, photo.height, cellW, cellH)
      pdf.addImage(photo.dataUrl, 'JPEG', x + (cellW - width) / 2, y + (cellH - height) / 2, width, height)
    })
  }

  return pdf.output('blob')
}

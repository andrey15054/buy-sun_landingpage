// Aigerim_Nurlanova_BUYSUN.pdf, Aigerim_Nurlanova_photo.jpg: the candidate's
// name, as the partner and Canva files are named in the cabinet
const FILE_SUFFIX = { pdf: 'BUYSUN', selfie: 'photo', full_body: 'full_body', additional: 'photo_2' }
const downloadName = (file) => {
  const answers = file.lead?.answers || {}
  const parts = [answers.firstName, answers.lastName].map((v) => String(v || '').trim()).filter(Boolean)
  const person = (parts.length ? parts.join('_') : String(file.lead?.name || '').trim())
    .replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 80)
  const tail = `_${FILE_SUFFIX[file.kind] || file.kind}.${file.mime === 'application/pdf' ? 'pdf' : 'jpg'}`
  const plain = `Anketa_${file.lead_id}${tail}`
  const name = person ? `${person}${tail}` : plain
  return { name, fallback: /^[A-Za-z0-9_.-]+$/.test(name) ? name : plain }
}
// A name in Cyrillic goes in filename* (RFC 6266); filename keeps a Latin
// one for old programs
const contentDisposition = (type, { name, fallback }) => {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

module.exports = { downloadName, contentDisposition }

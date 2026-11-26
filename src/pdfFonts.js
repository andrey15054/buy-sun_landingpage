// jsPDF's built-in fonts only cover Latin-1, so Russian, Kazakh and Turkish
// letters turn into garbage. We embed our own fonts (subsets with Latin,
// Turkish and Cyrillic letters, all under the SIL Open Font License, see
// public/fonts/OFL*.txt). The names are neutral on purpose: files for
// partners must not carry the BUY SUN name.
//
// AnketaSans (Liberation Sans, same metrics as Helvetica): the Canva file.
// AnketaTitle (Montserrat ExtraBold) and AnketaText (Noto Sans): the anketa PDF
// in the agency's Canva template, labels and values.
export const PDF_FONT = 'AnketaSans'
export const TITLE_FONT = 'AnketaTitle'
export const TEXT_FONT = 'AnketaText'

const FONT_FILES = [
  [PDF_FONT, 'normal', '/fonts/AnketaSans-Regular.ttf'],
  [PDF_FONT, 'bold', '/fonts/AnketaSans-Bold.ttf'],
  [TITLE_FONT, 'normal', '/fonts/AnketaTitle.ttf'],
  [TEXT_FONT, 'normal', '/fonts/AnketaText-Regular.ttf'],
  [TEXT_FONT, 'bold', '/fonts/AnketaText-Bold.ttf'],
]

let fontsPromise = null

const toBase64 = (buffer) => {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

// Starts the download once and reuses it; call early so the PDF is ready faster.
export const loadPdfFonts = () => {
  if (!fontsPromise) {
    fontsPromise = Promise.all(
      FONT_FILES.map(async ([family, style, url]) => {
        const response = await fetch(url)
        if (!response.ok) throw new Error(`Font ${url}: HTTP ${response.status}`)
        return [family, style, toBase64(await response.arrayBuffer())]
      })
    ).catch((err) => {
      fontsPromise = null // allow a retry, e.g. after the connection comes back
      throw err
    })
  }
  return fontsPromise
}

// Registers the fonts on a jsPDF document and makes AnketaSans the current
// font. Later calls like pdf.setFont(undefined, 'bold') keep the current family.
export const applyPdfFonts = async (pdf) => {
  const fonts = await loadPdfFonts()
  for (const [family, style, data] of fonts) {
    const fileName = `${family}-${style}.ttf`
    pdf.addFileToVFS(fileName, data)
    pdf.addFont(fileName, family, style)
  }
  pdf.setFont(PDF_FONT, 'normal')
}

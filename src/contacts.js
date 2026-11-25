// BUY SUN contacts shown on the site. Change them here only: the first screen,
// the footer, the «Сделаем вашу мечту реальностью!» block and the WhatsApp
// buttons of the forms all take them from this file.
export const CONTACTS = {
  email: 'buysun.kz@mail.ru',
  // As shown in the «Телефон» block, one line each
  phones: ['+77777599489', '+77026677171'],
  // Number the WhatsApp buttons open: digits only, country code first, no "+"
  whatsapp: '77026677171',
  telegram: 'https://t.me/buysunkz',
  tiktok: 'https://www.tiktok.com/@buysun.kz',
  instagram: 'https://www.instagram.com/buysun.kz/',
  // Offices in the «Сделаем вашу мечту реальностью!» block
  offices: [
    { city: 'Алматы', address: 'БЦ Кунаев 5 этаж 518 офис' },
    { city: 'Астана', address: 'Кенесары 40, 21 этаж 2100 офис' },
  ],
}

export const whatsappUrl = `https://wa.me/${CONTACTS.whatsapp}`

// Vacancies a candidate can choose in the anketa: [code, Russian, English].
// The code is stored with the anketa; the English name goes into the PDF and
// the partner files. Codes must not change: the server and old anketas use
// them (server/src/utils/anketaFields.js has the Russian names too).
export const POSITIONS = [
  ['bartender', 'Бармен', 'Bartender'],
  ['waiter', 'Официант', 'Waiter'],
  ['guest_relations', 'Guest Relation', 'Guest Relations'],
  ['kids_animator', 'Детская анимация', 'Kids Animator'],
  ['sport_animator', 'Спортивная анимация', 'Sports Animator'],
  ['receptionist', 'Ресепшен', 'Receptionist'],
  ['cook', 'Повар', 'Cook'],
  ['housekeeping', 'Горничная', 'Housekeeping'],
  ['dishwasher', 'Мойка посуды', 'Dishwasher'],
  ['public_area', 'Уборка территории', 'Public Area Cleaner'],
  ['other', 'Другое', 'Other'],
]

// Only in anketas sent before the list above
const OLD_POSITIONS = [
  ['kitchen', 'Кухня', 'Kitchen'],
  ['animator', 'Аниматор', 'Animator'],
]

const ALL = [...POSITIONS, ...OLD_POSITIONS]
const RU = Object.fromEntries(ALL.map(([code, ru]) => [code, ru]))
const EN = Object.fromEntries(ALL.map(([code, , en]) => [code, en]))

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1)

export const positionRu = (code) => RU[code] || capitalize(String(code || '').trim())
export const positionEn = (code) => EN[code] || capitalize(String(code || '').trim())

// For the cabinet: the current list plus the old values, so an old anketa
// still shows its vacancy
export const POSITION_OPTIONS = [
  ...POSITIONS.map(([code, ru]) => [code, ru]),
  ...OLD_POSITIONS.map(([code, ru]) => [code, `${ru} (старая анкета)`]),
]

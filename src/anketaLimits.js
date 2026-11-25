// The longest answer the server accepts for each anketa field, the same
// numbers as server/src/utils/validation.js. The form stops typing at the
// limit, so a long answer never turns into "the anketa was not sent".
const LIMITS = { firstName: 100, lastName: 100, email: 200, phone: 40, hobbies: 2000, courses: 2000 }

export const maxLength = (name) => LIMITS[name] ?? 300

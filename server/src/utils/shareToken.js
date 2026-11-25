const crypto = require('crypto')

// Secret part of an anketa link: 24 random bytes, 32 characters in the link
const newShareToken = () => crypto.randomBytes(24).toString('base64url')

// Tokens from the generator above and from the migration (64 hex characters)
const SHARE_TOKEN = /^[A-Za-z0-9_-]{32,64}$/

module.exports = { newShareToken, SHARE_TOKEN }

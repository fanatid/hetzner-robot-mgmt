const ms = require('ms')

async function delay (value) {
  if (typeof value !== 'number') value = ms(value)
  return new Promise((resolve) => setTimeout(resolve, value))
}

module.exports = {
  delay
}

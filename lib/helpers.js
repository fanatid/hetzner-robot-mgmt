const ms = require('ms')

async function delay (value) {
  return new Promise((resolve) => setTimeout(resolve, ms(value)))
}

module.exports = {
  delay
}

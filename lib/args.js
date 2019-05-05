const fs = require('fs')
const path = require('path')
const chalk = require('chalk')
const ms = require('ms')
const yargs = require('yargs')

const options = {
  auth: {
    alias: 'a',
    coerce (arg) {
      if (arg === '-' || arg === 'stdin') {
        try {
          return fs.readFileSync(process.stdin.fd, 'utf8').trim()
        } catch (err) {
          if (err.code === 'EAGAIN') throw new Error('Can not read auth info from stdin')
          throw err
        }
      }

      return fs.readFileSync(arg, 'utf8').trim()
    },
    describe: 'Credentials for basic access authentication, for read from stdin pass `-` or `stdin`',
    type: 'string'
  },
  input: {
    alias: 'i',
    demandOption: true,
    describe: 'File with state of Hetzner Servers',
    type: 'string'
  },
  output: {
    alias: 'o',
    coerce (arg) {
      arg = path.resolve(arg)

      // check that parent is directory
      const dir = path.dirname(arg)
      try {
        const stats = fs.statSync(dir)
        if (!stats.isDirectory()) throw new Error(`Expected directory: ${dir}`)
      } catch (err) {
        if (err.code === 'ENOENT') throw new Error(`Expected directory: ${dir}`)
        throw err
      }

      // check permissions
      try {
        fs.accessSync(arg, fs.constants.W_OK)
      } catch (err) {
        if (err.code !== 'ENOENT') throw err
        fs.accessSync(dir, fs.constants.W_OK)
      }

      return arg
    },
    describe: 'Output file for current state',
    type: 'string'
  },
  pingInterval: {
    coerce: ms,
    default: '5s',
    describe: 'Ping interval for checking apply to firewall/vSwitch',
    type: 'string'
  }
}

function getArgs () {
  return yargs
    .usage('Usage: $0 <command> [options]')
    .command('fetch [options]', 'Fetch current state of Hetzner Servers.', {
      auth: options.auth,
      output: options.output
    })
    .command('plan [options]', 'Show execution plan on apply command.', {
      auth: options.auth,
      input: options.input
    })
    .command('apply [options]', 'Apply specified state to Hetzner Servers.', {
      auth: options.auth,
      input: options.input,
      'ping-interval': options.pingInterval
    })
    .demandCommand(1, 'You need at least one command before moving on')
    .version()
    .help('help').alias('help', 'h')
    .wrap(yargs.terminalWidth())
    .check((args) => {
      const cmds = ['fetch', 'plan', 'apply']
      if (!cmds.includes(args._[0])) throw new Error(`Unknow command: ${args._[0]}`)
      return true
    })
    .fail((msg, err, yargs) => {
      console.error(chalk.red(msg))
      process.exit(1)
    })
    .argv
}

module.exports = {
  getArgs
}

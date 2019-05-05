const fs = require('fs')
const { getArgs } = require('./args')
const HetznerRobotAPI = require('./api')
const HetznerRobotState = require('./state')

async function fetch (args) {
  const api = new HetznerRobotAPI(args.auth)

  const state = new HetznerRobotState(api)
  await state.fetch(api)
  const data = state.dump()

  if (args.output) fs.writeFileSync(args.output, data, 'utf8')
  else process.stdout.write(data)

  return 0
}

async function plan (args) {
  return apply(args, true)
}

async function apply (args, plan = false) {
  const api = new HetznerRobotAPI(args.auth)

  const state = new HetznerRobotState(api)
  state.load(fs.readFileSync(args.input, 'utf8'))
  const success = await state.apply({ pingInterval: args.pingInterval, plan })
  return success ? 0 : 1
}

;(async () => {
  const args = getArgs()
  const cmds = {
    fetch,
    plan,
    apply
  }

  process.exitCode = await cmds[args._[0]](args)
})().catch((err) => {
  console.error(err.stack || err)
  process.exit(1)
})

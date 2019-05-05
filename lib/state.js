const chalk = require('chalk')
const lodash = require('lodash')
const logSymbols = require('log-symbols')
const qs = require('qs')
const yaml = require('yaml')
const yamlTypes = require('yaml/types')
const { delay } = require('./helpers')

// disable automatic line wrapping
yamlTypes.strOptions.fold.lineWidth = 0

class HetznerRobotState {
  constructor (api) {
    this.api = api

    this.servers = []
    this.failovers = []
    this.vSwitches = []
  }

  dump () {
    const servers = {}
    for (const server of this.servers) {
      const firewallRules = server.firewall.rules.input || []
      servers[server.server_ip] = {
        number: server.server_number,
        name: server.server_name,
        firewall: {
          status: server.firewall.status,
          whitelistHOS: server.firewall.whitelist_hos,
          rules: firewallRules.map((rule) => {
            const values = lodash.pick(rule, ['name', 'dst_ip', 'src_ip', 'dst_port', 'src_port', 'protocol', 'tcp_flags', 'action'])
            const notNullValues = lodash.pickBy(values, (x) => x)
            return qs.stringify(notNullValues, { delimiter: ';', encode: false })
          })
        }
      }
    }

    const failovers = {}
    for (const failover of this.failovers) {
      failovers[failover.ip] = {
        serverIP: failover.server_ip,
        activeServerIP: failover.active_server_ip
      }
    }

    const vSwitches = this.vSwitches.map((vSwitch) => ({
      id: vSwitch.id,
      name: vSwitch.name,
      vlan: vSwitch.vlan,
      servers: vSwitch.server.map((x) => x.server_ip)
    }))

    // ¯\_(ツ)_/¯
    const doc = yaml.parseDocument(yaml.stringify({ servers, failovers, vSwitches }))
    const nodeServers = doc.contents.items.find((item) => item.key.value === 'servers')
    for (const server of nodeServers.value.items) {
      const nodeFirewall = server.value.items.find((item) => item.key.value === 'firewall')
      const nodeRules = nodeFirewall.value.items.find((item) => item.key.value === 'rules')
      nodeRules.commentBefore = ' keys: name;dst_ip;src_ip;dst_port;src_port;protocol;tcp_flags;action'
    }
    return doc.toString()
  }

  load (data) {
    const obj = yaml.parse(data)

    this.servers = Object.entries(obj.servers).map(([ip, obj]) => ({
      server_ip: ip,
      server_number: obj.number,
      server_name: obj.name,
      firewall: {
        status: obj.firewall.status,
        whitelist_hos: obj.firewall.whitelistHOS,
        rules: {
          input: obj.firewall.rules.map((s) => ({
            ip_version: 'ipv4',
            name: null,
            dst_ip: null,
            src_ip: null,
            dst_port: null,
            src_port: null,
            protocol: null,
            tcp_flags: null,
            action: null,
            ...qs.parse(s, { delimiter: ';' })
          }))
        }
      }
    }))

    this.failovers = Object.entries(obj.failovers).map(([ip, obj]) => ({
      ip,
      server_ip: obj.serverIP,
      active_server_ip: obj.activeServerIP
    }))

    this.vSwitches = obj.vSwitches.map((obj) => ({
      id: obj.id,
      name: obj.name,
      vlan: obj.vlan,
      server: obj.servers.map((ip) => ({ server_ip: ip }))
    }))
  }

  // fetch functions, fetch remote state to current
  async fetch (api) {
    const fns = ['Servers', 'Failovers', 'VSwitches']
    await Promise.all(fns.map((name) => this['fetch' + name]()))
  }

  async fetchServers () {
    const servers = await this.api.server.getAll()
    this.servers = await Promise.all(servers.map(async ({ server }) => {
      const { firewall } = await this.api.firewall.get(server.server_ip)
      return { ...server, firewall }
    }))
  }

  async fetchFailovers () {
    const failovers = await this.api.failover.getAll()
    this.failovers = failovers.map((x) => x.failover)
  }

  async fetchVSwitches () {
    const vSwitches = await this.api.vSwitch.getAll()
    this.vSwitches = await Promise.all(vSwitches.filter((x) => !x.cancelled).map(({ id }) => this.api.vSwitch.get(id)))
  }

  // apply functions, trying apply local state to remote
  async apply ({ pingInterval, plan }) {
    const state = {
      pingInterval,
      plan,

      log: (msg) => console.error(`${new Date().toISOString()} ${msg}`),

      applied: 0,
      failed: 0,
      async madeChange (fn, startMsg, successMsg, failMsg) {
        state.log(`${logSymbols.info} ${startMsg}`)
        if (plan) return

        try {
          await fn()
          state.applied += 1
          state.log(`${logSymbols.success} ${successMsg}`)
        } catch (err) {
          state.failed += 1
          state.log(`${logSymbols.error} ${failMsg}: ${err.message}`)
        }
      }
    }

    const cmds = ['Servers', 'Failovers', 'VSwitches']
    for (const name of cmds) await this['apply' + name](state)

    state.total = state.applied + state.failed
    if (state.failed > 0) state.log(chalk.red.bold(`${logSymbols.error} ${state.failed} / ${state.total} changes failed`))
    else if (state.applied > 0) state.log(`${logSymbols.success} ${state.total} changes applied`)
    else state.log(`${logSymbols.success} 0 changes applied`)

    return state.failed === 0
  }

  async applyServers (state) {
    const serversArray = await this.api.server.getAll()
    const servers = serversArray.map((x) => x.server)

    // do we have new servers?
    const newServers = lodash.differenceBy(servers, this.servers, 'server_ip')
    if (newServers.length > 0) {
      state.failed += newServers.length
      for (const server of newServers) {
        state.log(`${logSymbols.error} server#${server.server_ip} not found in local state (new?)`)
      }
    }

    // do we have removed servers?
    const removedServers = lodash.differenceBy(this.servers, servers, 'server_ip')
    if (removedServers.length > 0) {
      state.failed += removedServers.length
      for (const server of removedServers) {
        state.log(`${logSymbols.error} server#${server.server_ip} not found in remote state (removed?)`)
      }
    }

    await Promise.all(this.servers.map(async (server) => {
      // change name
      const currentServer = servers.find((x) => x.server_ip === server.server_ip)
      if (server.server_name !== currentServer.server_name) {
        await state.madeChange(
          () => this.api.server.setName(server.server_ip, { server_name: server.server_name }),
          `server#${server.server_ip} name will be changed`,
          `server#${server.server_ip} name changed`,
          `server#${server.server_ip} name change caused error`
        )
      }

      // fetch current state firewall
      const { firewall: firewallFull } = await this.api.firewall.get(server.server_ip)
      const firewall = lodash.pick(firewallFull, ['status', 'whitelist_hos', 'rules'])
      if (firewall.rules.input === undefined) firewall.rules.input = []

      // update if required, unfortunately we can not check when firewall really updated
      if (JSON.stringify(server.firewall) !== JSON.stringify(firewall)) {
        await state.madeChange(
          () => this.api.firewall.apply(server.server_ip, server.firewall),
          `server#${server.server_ip} firewall will be changed`,
          `server#${server.server_ip} firewall changed`,
          `server#${server.server_ip} firewall change caused error`
        )
      }
    }))
  }

  async applyFailovers (state) {
    const failoversArray = await this.api.failover.getAll()
    const failovers = failoversArray.map((x) => x.failover)

    // do we have new failovers?
    const newFailovers = lodash.differenceBy(failovers, this.failovers, 'ip')
    if (newFailovers.length > 0) {
      state.failed += newFailovers.length
      for (const failover of newFailovers) {
        state.log(`${logSymbols.error} failover#${failover.ip} not found in local state (new?)`)
      }
    }

    // do we have removed failovers?
    const removedFailovers = lodash.differenceBy(this.failovers, failovers, 'ip')
    if (removedFailovers.length > 0) {
      state.failed += removedFailovers.length
      for (const failover of removedFailovers) {
        state.log(`${logSymbols.error} failover#${failover.ip} not found in remote state (removed?)`)
      }
    }

    // change active server
    const forChange = lodash.differenceBy(this.failovers, failovers, 'active_server_ip')
    await Promise.all(forChange.map(async (failover) => {
      await state.madeChange(
        () => this.api.failover.switch(failover.ip, { active_server_ip: failover.active_server_ip }),
        `failover#${failover.ip} active server IP will be changed`,
        `failover#${failover.ip} active server IP changed`,
        `failover#${failover.ip} active server IP change caused error`
      )
    }))
  }

  async applyVSwitches (state) {
    const vSwitchesShortInfo = await this.api.vSwitch.getAll()
    const vSwitches = await Promise.all(vSwitchesShortInfo.filter((x) => !x.cancelled).map(({ id }) => this.api.vSwitch.get(id)))

    // do we have new vSwitches?
    const newVSwitches = lodash.differenceBy(vSwitches, this.vSwitches, 'id')
    if (newVSwitches.length > 0) {
      state.failed += newVSwitches.length
      for (const vSwitch of newVSwitches) {
        state.log(`${logSymbols.error} vSwitch#${vSwitch.id} not found in local state (new?)`)
      }
    }

    // do we have removed vSwitches?
    const removedVSwitches = lodash.differenceBy(this.vSwitches, vSwitches, 'id')
    if (removedVSwitches.length > 0) {
      state.failed += removedVSwitches.length
      for (const vSwitch of removedVSwitches) {
        state.log(`${logSymbols.error} vSwitch#${vSwitch.id} not found in remote state (removed?)`)
      }
    }

    // change name / vlan
    const nameVLAN = lodash.differenceBy(this.vSwitches, vSwitches, (x) => JSON.stringify([x.name, x.vlan]))
    await Promise.all(nameVLAN.map((vSwitch) => state.madeChange(
      () => this.api.vSwitch.edit(vSwitch.id, { name: vSwitch.name, vlan: vSwitch.vlan }),
      `vSwitch#${vSwitch.id} name/vlan will be changed`,
      `vSwitch#${vSwitch.id} name/vlan changed`,
      `vSwitch#${vSwitch.id} name/vlan change caused error`
    )))

    // change servers
    const servers = lodash.differenceBy(this.vSwitches, vSwitches, (x) => JSON.stringify(x.server.map((x) => x.server_ip)))
    await Promise.all(servers.map(async (vSwitch) => {
      const currentServers = vSwitches.find((x) => x.id === vSwitch.id).server.map((x) => x.server_ip)
      const servers = vSwitch.server.map((x) => x.server_ip)

      // remove servers
      const removed = lodash.differenceBy(currentServers, servers)
      if (removed.length > 0) {
        await state.madeChange(
          () => this.api.vSwitch.deleteServers(vSwitch.id, { server: removed }),
          `vSwitch#${vSwitch.id} servers (${removed.length}) will be removed`,
          `vSwitch#${vSwitch.id} servers (${removed.length}) removed`,
          `vSwitch#${vSwitch.id} servers (${removed.length}) remove caused error`
        )
      }

      // add servers
      const added = lodash.differenceBy(servers, currentServers)
      if (added.length > 0) {
        await state.madeChange(
          () => this.api.vSwitch.addServers(vSwitch.id, { server: added }),
          `vSwitch#${vSwitch.id} servers (${added.length}) will be added`,
          `vSwitch#${vSwitch.id} servers (${added.length}) added`,
          `vSwitch#${vSwitch.id} servers (${added.length}) add caused error`
        )
      }

      // wait that there will no servers with status `in process`
      if (!state.plan && (removed.length > 0 || added.length > 0)) {
        delay('2s')
        while (true) {
          const vSwitchCurrent = await this.api.vSwitch.get(vSwitch.id)
          const vSwitchStatusCount = lodash.countBy(vSwitchCurrent.server.map((x) => x.status), (x) => x.replace(/ /g, ''))
          const count = { ready: 0, inprocess: 0, failed: 0, ...vSwitchStatusCount }

          if (count.inprocess === 0) {
            const symbol = count.failed > 0 ? logSymbols.warning : logSymbols.success
            state.log(`${symbol} vSwitch#${vSwitch.id} updated (${count.ready} servers ready, ${count.failed} servers failed)`)
            break
          }

          state.log(`${logSymbols.info} vSwitch#${vSwitch.id} ${count.inprocess} servers still in process (${count.ready} ready, ${count.failed} failed)`)
          await delay(state.pingInterval)
        }
      }
    }))
  }
}

module.exports = HetznerRobotState

const https = require('https')
const ms = require('ms')
const qs = require('qs')

async function makeRequest (options, data) {
  return new Promise((resolve, reject) => {
    const req = https.request(options)
    req.on('error', reject)
    req.on('timeout', () => {
      req.abort()
      reject(new Error('Timeout errror'))
    })

    req.on('response', (resp) => {
      const chunks = []
      resp.on('data', (chunk) => chunks.push(chunk))
      resp.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8')
          resolve([resp.statusCode, body.length === 0 ? null : JSON.parse(body)])
        } catch (err) {
          reject(err)
        }
      })
    })

    req.end(data)
  })
}

class HetznerRobotAPI {
  constructor (auth) {
    this.requestOptions = {
      auth,
      hostname: 'robot-ws.your-server.de',
      port: 443,
      timeout: ms('60s') // because failover change usually takes ~40s
    }

    this.createMethods()
  }

  async request (expectedStatusCode, expectNoOutput, method, path, data) {
    const headers = {}
    if (data) {
      if (typeof data !== 'string') data = qs.stringify(data)
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      headers['Content-Length'] = Buffer.byteLength(data)
    }

    const [statusCode, body] = await makeRequest({ ...this.requestOptions, method, path, headers }, data)

    if (body === null && !expectNoOutput) {
      if (statusCode === 401) throw new Error('Unauthorized')
      if (statusCode === 404) throw new Error(`Unknow method: ${path} (${method})`)
      throw new Error(`Empty response: ${path} (${method})`)
    }

    if (statusCode >= 400) {
      const e = body.error
      switch (statusCode) {
        case 400: throw new Error(`${e.code} (code ${e.status}): ${e.message} (missing: [${e.missing}], invalid: [${e.invalid}])`)
        case 403: throw new Error(`${e.code} (code ${e.status}): ${e.message} (request limit: ${e.max_request}, time interval: ${e.interval})`)
        default: throw new Error(`${e.code} (code ${e.status}): ${e.message}`)
      }
    }

    if (statusCode !== expectedStatusCode) {
      throw new Error(`Wrong status code ${statusCode}, response: ${JSON.stringify(body)}`)
    }

    return body
  }

  createMethods () {
    const methods = {
      server: {
        getAll: [200, false, 'GET', () => '/server'],
        get: [200, false, 'GET', (ip) => `/server/${ip}`],
        setName: [200, false, 'POST', (ip) => `/server/${ip}`]
      },
      failover: {
        getAll: [200, false, 'GET', () => '/failover'],
        get: [200, false, 'GET', (ip) => `/failover/${ip}`],
        switch: [200, false, 'POST', (ip) => `/failover/${ip}`],
        clear: [200, false, 'DELETE', (ip) => `/failover/${ip}`]
      },
      firewall: {
        get: [200, false, 'GET', (ip) => `/firewall/${ip}`],
        apply: [202, false, 'POST', (ip) => `/firewall/${ip}`],
        clear: [202, false, 'DELETE', (ip) => `/firewall/${ip}`]
      },
      vSwitch: {
        getAll: [200, false, 'GET', () => '/vswitch'],
        create: [201, false, 'POST', () => '/vswitch'],
        get: [200, false, 'GET', (id) => `/vswitch/${id}`],
        edit: [201, true, 'POST', (id) => `/vswitch/${id}`],
        cancel: [200, false, 'DELETE', (id) => `/vswitch/${id}`],
        addServers: [201, true, 'POST', (id) => `/vswitch/${id}/server`],
        deleteServers: [200, true, 'DELETE', (id) => `/vswitch/${id}/server`]
      }
    }

    for (const [section, methodsMap] of Object.entries(methods)) {
      this[section] = {}
      for (const [methodName, [expectedStatusCode, expectNoOutput, method, pathFn]] of Object.entries(methodsMap)) {
        this[section][methodName] = async (...args) => {
          const path = pathFn(args.splice(0, pathFn.length))
          if (args.length > 1) throw new Error(`Wrong number of arguments, left: ${args}`)

          return this.request(expectedStatusCode, expectNoOutput, method, path, ...args)
        }
      }
    }
  }
}

module.exports = HetznerRobotAPI

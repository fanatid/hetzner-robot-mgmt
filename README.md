# hetzner-robot-mgmt
[![js-standard-style](https://cdn.rawgit.com/feross/standard/master/badge.svg)](https://github.com/feross/standard)

Tool for servers management in [Hetzner](https://www.hetzner.com/) from CLI with [websirvice](https://robot.your-server.de/doc/webservice/en.html) API.

Currently only supported:

  - server: name, firewall
  - failover: active server
  - vSwitch: name, vlan, servers

## Installation

```bash
npm install -g https://github.com/fanatid/hetzner-robot-mgmt@v0.0.1
```

## CLI

Currently 3 commands supported:

  - `feth` -- print current state of Hetzner account
  - `plan` -- show what will be changed
  - `apply` -- trying apply current state to Hetzner account

Examples:

```bash
hetzner-robot-mgmt fetch -a hetzner-creds.auth -o hetzner-state.yml
hetzner-robot-mgmt plan -a hetzner-creds.auth -o hetzner-state.yml
hetzner-robot-mgmt apply -a hetzner-creds.auth -o hetzner-state.yml
```

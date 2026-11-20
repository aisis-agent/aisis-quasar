// Who may talk to this server at all.
//
// Upstream answers every client that can reach its port: a WebSocket with any `x-uprx-device-id` is a speaker (its
// text turns run the Home Assistant fast-intent layer), `GET /glagol/token?device_id=…` mints a control token for any
// device id and `GET /glagol/device_list` returns every speaker's private key. That is fine on a private network of
// one household and wrong on a LAN with phones, guests and IoT plugs. Admission is decided per request from the
// address it really came from.
//
//   - A colour binds to 127.0.0.1 (main.ts) and is reached through the blue/green switch (nginx) on the same host,
//     which sets `X-Real-IP` to the address it accepted the connection from. The client is therefore the `X-Real-IP`
//     of a loopback peer, or the peer itself on a direct connection; the headers of a non-loopback peer are never
//     believed.
//   - A loopback client is this host (deploy smoke checks, tools) and is always admitted. Any other client must be
//     listed in AISIS_ALLOWED_CLIENTS (comma separated IPs and CIDR ranges: the voice front the speakers connect
//     through). Unset means nobody.
//   - AISIS_EDGE_TOKEN, when set, is also required from every non-loopback client in `x-aisis-edge-token` (a second
//     factor for a front that can add a header: an address alone can be spoofed on a LAN).
//   - A WebSocket from a non-loopback client must also carry the id of a station this server already knows, so a
//     text turn can no longer provision and impersonate a new device. New speakers are provisioned from this host
//     (README.md).
//   - AISIS_ADMISSION=log refuses nothing and only logs what enforcement would refuse: a rollout aid, not a setting
//     to leave on.
import type { NextFunction, Request, Response } from 'express'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

import { createHash, timingSafeEqual } from 'node:crypto'
import { BlockList, isIP } from 'node:net'

import { getLogger } from './logger'

export interface AdmissionPolicy {
  allowed: BlockList
  edgeTokenDigest: Buffer | null
  enforce: boolean
}

export type Decision = { client: string, local: boolean, ok: true } | { ok: false, reason: string }

const REFUSAL_LOG_INTERVAL_MS = 60_000
const MAX_REFUSAL_LOG_KEYS = 256
const lastRefusalLogged = new Map<string, number>()
const logger = getLogger()

// HTTP: the address rules for every route, and, from a client that is not this host, a `device_id` query parameter must
// name a known station (the routes that take one create the station on first sight: `get_sync_info`,
// `update_device_state`; the glagol token is minted for it).
export function admissionMiddleware (policy: AdmissionPolicy, knownDevices: () => Promise<ReadonlySet<string>>):
(request: Request, response: Response, next: NextFunction) => void {
  // The one line that tells an operator, after a deploy, who is admitted.
  const ranges = policy.allowed.rules.map(rule => `, ${rule}`).join('')
  const token = policy.edgeTokenDigest === null ? '' : ', edge token required'
  logger.info(`Admission ${policy.enforce ? 'enforced' : 'logging only'}: loopback${ranges}${token}`)
  return (request, response, next) => {
    // The routes that create a station or mint a token for one fall back to the id "undefined" when it is missing:
    // a missing id on them is checked as an unknown one.
    const device = request.query['device_id']
    // Express matches routes case-insensitively and with an optional trailing slash: so does this.
    const takesDevice = /\/(get_sync_info|update_device_state|glagol\/token)\/?$/i.test(request.path)
    const what = `${request.method} ${printable(request.path)}`
    const deviceId = device === undefined ? (takesDevice ? '' : null) : String(device)
    admitDevice(policy, request, deviceId, knownDevices, what).then(admitted => {
      if (admitted) next()
      else response.status(403).end()
    }, next)
  }
}

// A client from another address must be listed (and present the token). The token is taken off the request first, on
// every path (also for this host and in logging-only mode), so that no handler downstream (several log every request
// header) can write it to a log.
export function admit (policy: AdmissionPolicy, request: IncomingMessage): Decision {
  const presented = request.headers['x-aisis-edge-token']
  delete request.headers['x-aisis-edge-token']
  const client = clientAddress(request)
  if (client === null) return { ok: false, reason: 'the client address is unknown' }
  const local = isLoopback(client)
  if (local) return { client, local, ok: true }
  if (!policy.allowed.check(client, isIP(client) === 6 ? 'ipv6' : 'ipv4')) {
    return { ok: false, reason: `client ${client} is not in AISIS_ALLOWED_CLIENTS` }
  }
  if (!edgeTokenMatches(policy, presented)) {
    return { ok: false, reason: `client ${client} did not present the edge token` }
  }
  return { client, local, ok: true }
}

// WebSocket upgrade: the device named in the header must be a known station (see admitDevice).
export async function admitUpgrade (policy: AdmissionPolicy, request: IncomingMessage,
  knownDevices: () => Promise<ReadonlySet<string>>): Promise<boolean> {
  const deviceId = String(request.headers['x-uprx-device-id'] ?? '')
  return await admitDevice(policy, request, deviceId, knownDevices, 'WebSocket upgrade')
}

// A loopback peer is the switch (which always sets X-Real-IP) or a local tool (which sends none). A header that is
// present but is not one address is neither: it is refused, not read as "this host".
export function clientAddress (request: IncomingMessage): null | string {
  const peer = normalize(request.socket.remoteAddress)
  if (peer === null || !isLoopback(peer)) return peer
  const claimed = request.headers['x-real-ip']
  if (claimed === undefined) return peer
  return typeof claimed === 'string' ? normalize(claimed.trim()) : null
}

export async function knownStationIds (provider: { getStationInfos: () => Promise<{ duid: string }[]> }):
Promise<Set<string>> {
  const infos = await provider.getStationInfos()
  return new Set(infos.map(info => info.duid))
}

export function parseAdmissionPolicy (environment: NodeJS.ProcessEnv = process.env): AdmissionPolicy {
  const allowed = new BlockList()
  const entries = (environment.AISIS_ALLOWED_CLIENTS ?? '').split(',').map(item => item.trim())
  for (const entry of entries.filter(item => item !== '')) {
    const [address = '', prefix, ...extra] = entry.split('/')
    const family = isIP(address)
    if (family === 0 || extra.length > 0 || (prefix !== undefined && !/^\d{1,3}$/.test(prefix))) {
      throw new Error(`AISIS_ALLOWED_CLIENTS: '${entry}' is not an IP address or a CIDR range`)
    }
    const name = family === 6 ? 'ipv6' : 'ipv4'
    try {
      if (prefix === undefined) allowed.addAddress(address, name)
      else allowed.addSubnet(address, Number(prefix), name)
    } catch (error) {
      throw new Error(`AISIS_ALLOWED_CLIENTS: '${entry}': ${String(error)}`, { cause: error })
    }
  }
  const mode = environment.AISIS_ADMISSION ?? 'enforce'
  if (mode !== 'enforce' && mode !== 'log') {
    throw new Error(`AISIS_ADMISSION: '${mode}' is neither 'enforce' nor 'log'`)
  }
  const token = environment.AISIS_EDGE_TOKEN
  return {
    allowed,
    edgeTokenDigest: token === undefined || token === '' ? null : sha256(token),
    enforce: mode === 'enforce'
  }
}

// `end` only closes our side: destroy the socket once the answer is flushed, or a client that never closes its own side
// keeps a file descriptor for ever.
export function refuseUpgrade (socket: Duplex): void {
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  socket.once('finish', () => { socket.destroy() })
}

// The shared decision: the address rules, then, for a client that is not this host and names a device, the device must
// be a known station. A failing lookup refuses (fail closed); `knownDevices` is only called for such clients.
async function admitDevice (policy: AdmissionPolicy, request: IncomingMessage, deviceId: null | string,
  knownDevices: () => Promise<ReadonlySet<string>>, what: string): Promise<boolean> {
  let decision = admit(policy, request)
  if (decision.ok && !decision.local && deviceId !== null) {
    try {
      const known = await knownDevices()
      if (!known.has(deviceId)) {
        decision = { ok: false, reason: `device ${printable(deviceId)} is not a known station` }
      }
    } catch (error) {
      decision = { ok: false, reason: `the station list could not be read: ${String(error)}` }
    }
  }
  return proceed(policy, decision, what)
}

function edgeTokenMatches (policy: AdmissionPolicy, presented: unknown): boolean {
  if (policy.edgeTokenDigest === null) return true
  return typeof presented === 'string' && timingSafeEqual(sha256(presented), policy.edgeTokenDigest)
}

function isLoopback (address: string): boolean {
  return address === '::1' || (isIP(address) === 4 && address.startsWith('127.'))
}

function normalize (address: string | undefined): null | string {
  if (address === undefined) return null
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  const value = mapped?.[1] ?? address
  return isIP(value) === 0 ? null : value
}

function printable (text: string): string {
  return text.replaceAll(/[^\w.:/-]/g, '?').slice(0, 64)
}

// Whether the request goes on. A refusal is logged at most once a minute per reason (a scan must not flush the log).
function proceed (policy: AdmissionPolicy, decision: Decision, what: string): boolean {
  if (decision.ok) return true
  const key = `${policy.enforce}|${decision.reason}`
  const now = Date.now()
  if (now - (lastRefusalLogged.get(key) ?? 0) >= REFUSAL_LOG_INTERVAL_MS) {
    if (lastRefusalLogged.size >= MAX_REFUSAL_LOG_KEYS) lastRefusalLogged.clear()
    lastRefusalLogged.set(key, now)
    const verdict = policy.enforce ? 'refused' : 'would refuse (AISIS_ADMISSION=log)'
    logger.warn(`Admission ${verdict} ${what}: ${decision.reason}`)
  }
  return !policy.enforce
}

function sha256 (text: string): Buffer {
  return createHash('sha256').update(text).digest()
}

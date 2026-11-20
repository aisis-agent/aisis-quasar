// Offline check of src/admission.ts and its wiring (exit 1 on any failure):
//   node_modules/.bin/tsx src/routers/check_admission.mts
// Inside a quasar image the file sits at /src/routers/ and /src is the image's source root (the AISIS overlay README runs it there).
// The policy is checked on fake requests; the router and the Express middleware with real WebSocket / HTTP clients on loopback. The
// connection class and the logger are replaced by recorders, so no database, Home Assistant or outside network is involved.
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { createRequire } from 'node:module'
import { type AddressInfo, connect as tcpConnect } from 'node:net'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import WebSocket from 'ws'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const logged: string[] = []
const recorder = (level: string) => (...args: unknown[]): void => { logged.push(`${level} ${args.map(String).join(' ')}`) }
const fakeLogger = { debug: recorder('debug'), error: recorder('error'), info: recorder('info'), warn: recorder('warn') }

// The sources are CommonJS: stand-ins go into the module cache before the modules load.
const require = createRequire(import.meta.url)
const constructed: string[] = []
const stub = (path: string, exports: object): void => {
  require.cache[path] = { children: [], exports, filename: path, id: path, loaded: true, path, paths: [] } as unknown as NodeModule
}
stub(`${root}/logger.ts`, { getLogger: () => fakeLogger })
stub(`${root}/routers/uniproxy/uniproxy-connection.ts`, {
  UniProxyConnection: class { constructor (_websocket: unknown, deviceId: string) { constructed.push(deviceId) } }
})
interface Policy { enforce: boolean }
const admission = require(`${root}/admission.ts`) as {
  admissionMiddleware: (policy: Policy, knownDevices: () => Promise<ReadonlySet<string>>) => (request: unknown, response: unknown, next: () => void) => void
  admit: (policy: Policy, request: IncomingMessage) => { client?: string, local?: boolean, ok: boolean, reason?: string }
  parseAdmissionPolicy: (env: Record<string, string | undefined>) => Policy
}
const router = require(`${root}/routers/uniproxy.alice.yandex.net.ts`) as {
  registerUniproxyAliceYandexNetRouter: (parameters: object, server: Server, admission?: Policy) => unknown
}

let pass = 0
let total = 0
const failures: string[] = []
function check (name: string, ok: boolean, detail?: unknown): void {
  total++
  if (ok) pass++
  else failures.push(`${name}: ${JSON.stringify(detail)}`)
}
const sleep = async (ms: number): Promise<void> => { await new Promise(resolve => setTimeout(resolve, ms)) }

function fakeRequest (peer: string, headers: Record<string, string> = {}): IncomingMessage {
  return { headers, socket: { remoteAddress: peer } } as unknown as IncomingMessage
}
const verdict = (env: Record<string, string>, peer: string, headers?: Record<string, string>): string => {
  const result = admission.admit(admission.parseAdmissionPolicy(env), fakeRequest(peer, headers))
  return result.ok ? (result.local === true ? 'local' : `admitted ${result.client}`) : 'refused' // topology-ok: property access, not a host name
}

// ── The address rules ────────────────────────────────────────────────────────────────────────────────────────────────
const FRONT = { AISIS_ALLOWED_CLIENTS: '192.0.2.0/24, 2001:db8::1' }
const table: [string, Record<string, string>, string, Record<string, string> | undefined, string][] = [
  ['default: this host is admitted', {}, '127.0.0.1', undefined, 'local'],
  ['default: ::1 is admitted', {}, '::1', undefined, 'local'],
  ['default: a mapped loopback is admitted', {}, '::ffff:127.0.0.1', undefined, 'local'],
  ['default: a LAN client behind the switch is refused', {}, '127.0.0.1', { 'x-real-ip': '192.0.2.10' }, 'refused'],
  ['default: a LAN client connecting directly is refused', {}, '192.0.2.10', undefined, 'refused'],
  ['a listed client behind the switch is admitted', FRONT, '127.0.0.1', { 'x-real-ip': '192.0.2.7' }, 'admitted 192.0.2.7'],
  ['an unlisted client behind the switch is refused', FRONT, '127.0.0.1', { 'x-real-ip': '198.51.100.9' }, 'refused'],
  ['a listed client connecting directly is admitted', FRONT, '192.0.2.7', undefined, 'admitted 192.0.2.7'],
  ['a mapped IPv4 peer is matched as IPv4', FRONT, '::ffff:192.0.2.7', undefined, 'admitted 192.0.2.7'],
  ['an exact IPv6 entry is matched', FRONT, '2001:db8::1', undefined, 'admitted 2001:db8::1'],
  ['an unlisted direct client cannot claim to be loopback', FRONT, '198.51.100.9', { 'x-real-ip': '127.0.0.1' }, 'refused'],
  ['an unlisted direct client cannot claim a listed address', FRONT, '198.51.100.9', { 'x-real-ip': '192.0.2.7' }, 'refused'],
  ['an unreadable X-Real-IP behind the switch is refused, not read as this host', FRONT, '127.0.0.1', { 'x-real-ip': 'not an address' }, 'refused'],
  ['two X-Real-IP values (joined by Node) are refused', FRONT, '127.0.0.1', { 'x-real-ip': '192.0.2.7, 127.0.0.1' }, 'refused'],
  ['a listed client without the token is refused when a token is set', { ...FRONT, AISIS_EDGE_TOKEN: 's3cret' }, '192.0.2.7', undefined, 'refused'],
  ['a wrong token is refused', { ...FRONT, AISIS_EDGE_TOKEN: 's3cret' }, '192.0.2.7', { 'x-aisis-edge-token': 's3cret!' }, 'refused'],
  ['the right token is admitted', { ...FRONT, AISIS_EDGE_TOKEN: 's3cret' }, '192.0.2.7', { 'x-aisis-edge-token': 's3cret' }, 'admitted 192.0.2.7'],
  ['this host needs no token', { ...FRONT, AISIS_EDGE_TOKEN: 's3cret' }, '127.0.0.1', undefined, 'local']
]
for (const [name, env, peer, headers, expected] of table) {
  const got = verdict(env, peer, headers)
  check(name, got === expected, { expected, got })
}
for (const [name, env] of [
  ['an entry that is not an address', { AISIS_ALLOWED_CLIENTS: '192.0.2.7, printer' }],
  ['a prefix above 32', { AISIS_ALLOWED_CLIENTS: '192.0.2.0/33' }],
  ['a prefix that is not a number', { AISIS_ALLOWED_CLIENTS: '192.0.2.0/x' }],
  ['a second slash', { AISIS_ALLOWED_CLIENTS: '192.0.2.0/24/1' }],
  ['an unknown mode', { AISIS_ADMISSION: 'off' }]
] as const) {
  let message = ''
  try { admission.parseAdmissionPolicy({ ...env }) } catch (error) { message = String(error) }
  check(`startup refuses ${name}`, /AISIS_/.test(message), message)
}

// ── The WebSocket upgrade ────────────────────────────────────────────────────────────────────────────────────────────
interface Outcome { status: number | 'open', closeCode?: number }
let storageFails = false
let lookupDelayMs = 0
const parameters = {
  storage: {
    getInfo: async () => { throw new Error('a refused client must never provision a station') },
    getStationInfos: async () => {
      if (lookupDelayMs > 0) await sleep(lookupDelayMs)
      if (storageFails) throw new Error('db down')
      return [{ duid: 'known-station' }]
    }
  }
}
async function startRouter (policy: Policy): Promise<{ close: () => void, port: number }> {
  const server = createServer()
  router.registerUniproxyAliceYandexNetRouter(parameters, server, policy)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { close: () => { server.close(); server.closeAllConnections() }, port: (server.address() as AddressInfo).port }
}
async function connect (port: number, device: string | null, headers: Record<string, string> = {}): Promise<Outcome> {
  const client = new WebSocket(`ws://127.0.0.1:${port}/uni.ws`, { headers: { ...(device === null ? {} : { 'x-uprx-device-id': device }), ...headers } })
  return await new Promise<Outcome>(resolve => {
    client.on('unexpected-response', (_request, response) => { resolve({ status: response.statusCode ?? 0 }); response.resume() })
    client.on('error', () => {})
    client.on('open', () => { client.close() })
    client.on('close', code => { resolve({ closeCode: code, status: 'open' }) })
  })
}

const enforcing = await startRouter(admission.parseAdmissionPolicy({ AISIS_ALLOWED_CLIENTS: '192.0.2.0/24' }))
const LAN = (address: string): Record<string, string> => ({ 'x-real-ip': address })
let before = constructed.length
check('this host connects with a throwaway id (deploy smoke checks)', (await connect(enforcing.port, 'bg-smoke-1')).status === 'open')
check('...and a connection is made for it', constructed.length === before + 1 && constructed.at(-1) === 'bg-smoke-1', constructed)
before = constructed.length
const intruder = await connect(enforcing.port, 'proof-throwaway', LAN('198.51.100.9'))
check('an unlisted LAN client with an invented device id is refused with 403', intruder.status === 403, intruder)
check('...and no connection object exists for it', constructed.length === before, constructed)
const knownIntruder = await connect(enforcing.port, 'known-station', LAN('198.51.100.9'))
check('an unlisted LAN client with a KNOWN station id is refused too', knownIntruder.status === 403, knownIntruder)
check('the voice front with a known station is admitted', (await connect(enforcing.port, 'known-station', LAN('192.0.2.7'))).status === 'open')
check('...and its connection is made for that station', constructed.at(-1) === 'known-station', constructed)
const invented = await connect(enforcing.port, 'invented-station', LAN('192.0.2.7'))
check('the voice front with an unknown station id is refused (no provisioning by a text turn)', invented.status === 403, invented)
check('the voice front without a device id is refused', (await connect(enforcing.port, null, LAN('192.0.2.7'))).status === 403)
storageFails = true
check('an unreadable station list refuses (fail closed)', (await connect(enforcing.port, 'known-station', LAN('192.0.2.7'))).status === 403)
check('...but does not stop this host', (await connect(enforcing.port, 'bg-smoke-2')).status === 'open')
storageFails = false
const missing = await connect(enforcing.port, null)
check('this host without a device id is still closed with 1008 by the router', missing.closeCode === 1008, missing)

// The http module drops its own socket error handler when it hands over an upgrade, and admission makes the hand-over wait for the
// station list: a client that resets in that gap (or right after it is refused) must not raise an unhandled 'error' that kills the process.
const uncaught: string[] = []
process.on('uncaughtException', error => { uncaught.push(String(error)) })
const UPGRADE = (address: string): string => 'GET /uni.ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
  `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nx-uprx-device-id: known-station\r\nX-Real-IP: ${address}\r\n\r\n`
for (const [name, address, resetAfterMs, delay] of [
  ['resets while the station list is being read', '192.0.2.7', 20, 150],
  ['resets right after it is refused', '198.51.100.9', 0, 0]
] as const) {
  lookupDelayMs = delay
  const raw = tcpConnect(enforcing.port, '127.0.0.1')
  raw.on('error', () => {})
  await new Promise<void>(resolve => raw.once('connect', () => { resolve() }))
  raw.write(UPGRADE(address))
  await sleep(resetAfterMs)
  raw.resetAndDestroy()
  await sleep(300)
  check(`a client that ${name} does not crash the server`, uncaught.length === 0, uncaught)
}
lookupDelayMs = 0
check('...and the server still answers afterwards', (await connect(enforcing.port, 'bg-smoke-3')).status === 'open')
check('a refusal is logged with the reason and never with the frame content', logged.some(line => /Admission refused WebSocket upgrade: client 198\.51\.100\.9 is not in AISIS_ALLOWED_CLIENTS/.test(line)), logged)
enforcing.close()

const rollout = await startRouter(admission.parseAdmissionPolicy({ AISIS_ADMISSION: 'log' }))
before = constructed.length
check('AISIS_ADMISSION=log lets the unlisted client through', (await connect(rollout.port, 'proof-throwaway', LAN('198.51.100.9'))).status === 'open')
check('...and says what enforcement would have refused', logged.some(line => /would refuse \(AISIS_ADMISSION=log\) WebSocket upgrade: client 198\.51\.100\.9/.test(line)), logged)
rollout.close()

// ── The HTTP routes (the glagol token and device list) ─────────────────────────────────────────────────────────────
const express = require('express') as () => { listen: (port: number, host: string, callback: () => void) => Server, use: (...handlers: unknown[]) => void }
const app = express()
let routeRuns = 0
const knownStations = async (): Promise<ReadonlySet<string>> => new Set(['known-station'])
app.use(admission.admissionMiddleware(admission.parseAdmissionPolicy({ AISIS_ALLOWED_CLIENTS: '192.0.2.0/24' }), knownStations))
app.use((_request: unknown, response: { json: (body: object) => void }) => { routeRuns++; response.json({ token: 'minted' }) })
const http = await new Promise<Server>(resolve => { const listening = app.listen(0, '127.0.0.1', () => { resolve(listening) }) })
async function get (headers: Record<string, string>, query = '?device_id=known-station', route = '/quasar.yandex.net/glagol/token'): Promise<number> {
  return await new Promise(resolve => {
    const call = httpRequest({ headers, host: '127.0.0.1', path: `${route}${query}`, port: (http.address() as AddressInfo).port }, response => { response.resume(); resolve(response.statusCode ?? 0) })
    call.end()
  })
}
check('the effective policy is logged once at startup', logged.filter(line => /^info Admission enforced: loopback, Subnet: IPv4 192\.0\.2\.0\/24$/.test(line)).length === 1, logged)
check('HTTP: an unlisted LAN client cannot mint a glagol token', await get(LAN('198.51.100.9')) === 403)
check('...the route never ran for it', routeRuns === 0, routeRuns)
check('HTTP: the voice front is served for a known station', await get(LAN('192.0.2.7')) === 200)
routeRuns = 0
check('HTTP: the voice front cannot provision or mint for an invented device id', await get(LAN('192.0.2.7'), '?device_id=invented') === 403)
check('...the route never ran for it', routeRuns === 0, routeRuns)
check('HTTP: the voice front is served on a route that takes no device id', await get(LAN('192.0.2.7'), '', '/quasar.yandex.net/check_updates') === 200)
routeRuns = 0
check('HTTP: the voice front cannot create the station "undefined" by leaving the id out', await get(LAN('192.0.2.7'), '', '/quasar.yandex.net/get_sync_info') === 403)
check('HTTP: ...nor mint a token or update the state without an id', await get(LAN('192.0.2.7'), '', '/quasar.yandex.net/glagol/token') === 403 && await get(LAN('192.0.2.7'), '', '/quasar.yandex.net/update_device_state') === 403)
check('HTTP: ...also with a trailing slash or another letter case (Express matches both)',
  await get(LAN('192.0.2.7'), '', '/quasar.yandex.net/get_sync_info/') === 403 && await get(LAN('192.0.2.7'), '', '/quasar.yandex.net/Get_Sync_Info') === 403 &&
  await get(LAN('192.0.2.7'), '', '/quasar.yandex.net/glagol/TOKEN/') === 403)
check('...no route ran for those', routeRuns === 0, routeRuns)
check('HTTP: this host may provision a new station', await get({}, '?device_id=invented') === 200)
http.close()
http.closeAllConnections()

// The edge token is consumed at admission: several handlers dump every request header into the debug log.
const withToken = admission.parseAdmissionPolicy({ AISIS_ALLOWED_CLIENTS: '192.0.2.0/24', AISIS_EDGE_TOKEN: 's3cret' })
const tokenRequest = fakeRequest('192.0.2.7', { 'x-aisis-edge-token': 's3cret' })
check('an admitted request no longer carries the edge token', admission.admit(withToken, tokenRequest).ok && tokenRequest.headers['x-aisis-edge-token'] === undefined, tokenRequest.headers)
const loopbackWithToken = fakeRequest('127.0.0.1', { 'x-aisis-edge-token': 's3cret' })
admission.admit(withToken, loopbackWithToken)
const loggedWithToken = fakeRequest('198.51.100.9', { 'x-aisis-edge-token': 's3cret' })
admission.admit(admission.parseAdmissionPolicy({ AISIS_ADMISSION: 'log', AISIS_EDGE_TOKEN: 's3cret' }), loggedWithToken)
check('...nor does a request from this host or one let through in logging-only mode',
  loopbackWithToken.headers['x-aisis-edge-token'] === undefined && loggedWithToken.headers['x-aisis-edge-token'] === undefined)

// A refused upgrade must not keep its socket: a client that never closes its own side gets disconnected.
const half = await startRouter(admission.parseAdmissionPolicy({}))
const lingering = tcpConnect({ allowHalfOpen: true, host: '127.0.0.1', port: half.port })
lingering.on('error', () => {})
await new Promise<void>(resolve => lingering.once('connect', () => { resolve() }))
lingering.resume()
lingering.write(UPGRADE('198.51.100.9'))
// After its FIN the client writes again: a server that only half-closed accepts it, one that destroyed its socket resets it.
const dropped = await new Promise<boolean>(resolve => {
  lingering.once('end', () => { lingering.write('x'); setTimeout(() => { lingering.write('y') }, 100) })
  lingering.once('close', () => { resolve(true) })
  setTimeout(() => { resolve(false) }, 1500)
})
check('a refused upgrade whose client keeps its side open is disconnected', dropped)
lingering.destroy()
half.close()

// ── The wiring in main.ts ─────────────────────────────────────────────────────────────────────────────────────────────
const main = readFileSync(`${root}/main.ts`, 'utf8')
const at = (needle: string): number => main.indexOf(needle)
check('main.ts: admission is the first middleware, before body parsing and every route',
  at('app.use(admissionMiddleware(') > 0 && at('app.use(admissionMiddleware(') < at('app.use(bodyParser.json(') && at('app.use(admissionMiddleware(') < at('registerQuasarYandexNetRouter(app'))
check('main.ts: the HTTP server binds to bindHost (loopback by default)', main.includes('app.listen(environment.PORT, bindHost') && main.includes("process.env.BIND_HOST ?? '127.0.0.1'"))
check('main.ts: the function-state-server stays on loopback whatever BIND_HOST says', main.includes("functionStateServer.listen({ hostname: '127.0.0.1'"))

await sleep(50)
console.log(`ИТОГ ${pass}/${total}`)
for (const failure of failures) console.log('FAIL', failure)
process.exit(pass === total ? 0 : 1)

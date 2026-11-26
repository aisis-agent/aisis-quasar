// The fast-intent layer talks to Home Assistant directly, with the connection store the AISIS dashboard writes
// (ha-connection.ts). The REAL layer runs against fake Home Assistants on loopback ports (no network, no device actions, no sound):
//   node_modules/.bin/tsx src/backend/check_ha_direct.mts
// Covers: OAuth refresh (/auth/token) and its cache, a 401 renewing the token once, a revoked grant, the address changing in the
// file mid-run (new mtime, and a change the mtime did not show), an unreachable Home Assistant, a hung one (3 s, token refresh
// inside that budget), the health poll of the fillers, a long-lived token, no store at all, and the wording without any proxy.
import { mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'ha-direct-'))
const STORE = join(dir, 'connection.json')
process.env.AISIS_HA_STORE = STORE
process.env.AISIS_HA_AMBIGUITY_FILE = join(dir, 'ambiguity.json')
process.env.SEMANTIC_INTENTS = 'off'

type Result = null | { kind: string, listen?: boolean, quasarDirectives?: unknown[], text: null | string }

// ── a fake Home Assistant ───────────────────────────────────────────────────────────────────────────────────────────
interface FakeHa {
  accepted: Set<string>          // bearer tokens the API accepts
  calls: string[]                // "METHOD path" of every request, in order
  authHeaders: (string | undefined)[] // Authorization of every /api request
  tokenForms: URLSearchParams[]  // form bodies of /auth/token
  tokenLifetime: number          // expires_in of the next token
  tokenMode: 'ok' | 'invalid_grant' | 'unaccepted'
  tokenDelayMs: number
  serviceDelayMs: number
  providersStatus: number
  providersDelayMs: number
  providersAuth: (string | undefined)[] // Authorization of every /auth/providers request
  readDelayMs: number            // reads (GET /api) are answered after this long
  readBodyStallMs: number        // reads answer their headers at once but stall the body this long
  readDelayAfterCallMs: number   // readDelayMs from the moment a service call arrives on
  readBodyStallAfterCallMs: number
  serviceDrop: boolean           // a service call is executed, then the connection is cut without an answer
  leaveUnchanged: boolean        // a service call is answered 200 but the device does not change
  serviceStatus: number
  lights: Record<string, { area: string, state: string }>
  minted: number
  server: Server
  url: string
}

async function startHa (): Promise<FakeHa> {
  const ha: FakeHa = {
    accepted: new Set(), authHeaders: [], calls: [], leaveUnchanged: false, lights: {
      'light.gostinaya': { area: 'Гостиная', state: 'on' },
      'light.kukhnya': { area: 'Кухня', state: 'on' }
    }, minted: 0, providersAuth: [], providersDelayMs: 0, providersStatus: 200, readBodyStallAfterCallMs: 0, readBodyStallMs: 0,
    readDelayAfterCallMs: 0, readDelayMs: 0, serviceDelayMs: 0, serviceDrop: false, serviceStatus: 200,
    server: null as unknown as Server, tokenDelayMs: 0, tokenForms: [], tokenLifetime: 1800, tokenMode: 'ok', url: ''
  }
  const entity = (id: string) => ({ attributes: { friendly_name: id }, entity_id: id, state: ha.lights[id].state })
  const respond = (response: ServerResponse, status: number, value: unknown, delayMs = 0, stallMs = 0) => {
    setTimeout(() => {
      if (response.destroyed) return
      response.writeHead(status, { 'Content-Type': 'application/json' })
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      if (stallMs > 0) {
        response.flushHeaders()
        setTimeout(() => response.end(text), stallMs)
        return
      }
      response.end(text)
    }, delayMs)
  }
  ha.server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = ''
    request.on('data', chunk => { raw += String(chunk) })
    request.on('end', () => {
      const url = request.url ?? ''
      if (url === '/intent/decide') return respond(response, 200, { route: 'none' })
      ha.calls.push(`${request.method} ${url}`)
      if (url === '/auth/providers') {
        ha.providersAuth.push(request.headers.authorization)
        return respond(response, ha.providersStatus, [], ha.providersDelayMs)
      }
      if (url === '/auth/token') {
        ha.tokenForms.push(new URLSearchParams(raw))
        if (ha.tokenMode === 'invalid_grant') return respond(response, 400, { error: 'invalid_grant' }, ha.tokenDelayMs)
        const token = `at-${++ha.minted}`
        if (ha.tokenMode === 'ok') ha.accepted.add(token)
        return respond(response, 200, { access_token: token, expires_in: ha.tokenLifetime, token_type: 'Bearer' }, ha.tokenDelayMs)
      }
      ha.authHeaders.push(request.headers.authorization)
      const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1]
      if (bearer === undefined || !ha.accepted.has(bearer)) return respond(response, 401, { message: 'Unauthorized' })
      const read = (value: unknown) => respond(response, 200, value, ha.readDelayMs, ha.readBodyStallMs)
      if (url === '/api/states') return read(Object.keys(ha.lights).map(entity))
      if (url === '/api/template') {
        return read(Object.entries(ha.lights).map(([id, light]) => `${id}\t${id}\t${light.area}\n`).join(''))
      }
      const one = /^\/api\/states\/(light\.\w+)$/.exec(url)
      if (one !== null && ha.lights[one[1]] !== undefined) return read(entity(one[1]))
      if (url.startsWith('/api/services/')) {
        const turn = /\/light\/turn_(on|off)$/.exec(url)
        const body = raw === '' ? {} : JSON.parse(raw) as { entity_id?: string }
        if (ha.serviceStatus === 200 && turn !== null && !ha.leaveUnchanged) {
          const ids = body.entity_id === 'all' ? Object.keys(ha.lights) : [body.entity_id ?? '']
          for (const id of ids) if (ha.lights[id] !== undefined) ha.lights[id].state = turn[1]
        }
        if (ha.readDelayAfterCallMs > 0) ha.readDelayMs = ha.readDelayAfterCallMs
        if (ha.readBodyStallAfterCallMs > 0) ha.readBodyStallMs = ha.readBodyStallAfterCallMs
        if (ha.serviceDrop) {
          request.socket.destroy()
          return
        }
        return respond(response, ha.serviceStatus, [], ha.serviceDelayMs)
      }
      respond(response, 404, '')
    })
  })
  await new Promise<void>(resolve => ha.server.listen(0, '127.0.0.1', resolve))
  ha.url = `http://127.0.0.1:${(ha.server.address() as AddressInfo).port}`
  return ha
}

// A port nothing listens on: connection refused.
async function deadUrl (): Promise<string> {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`
  await new Promise<void>(resolve => probe.close(() => resolve()))
  return url
}

// ── the store ───────────────────────────────────────────────────────────────────────────────────────────────────────
type StoreAuth = { kind: 'long_lived', token: string } | { kind: 'oauth', refresh_token: string }
const storeBody = (url: string, auth: StoreAuth, name = 'Home') => JSON.stringify({
  auth, client_id: 'http://192.168.0.56:8781/', connected_at: 1.7e9, name, url, uuid: 'uuid-1', version: 1
})
// The way the dashboard writes it: a temporary file renamed over the store.
function writeStore (url: string, auth: StoreAuth): void {
  const tmp = `${STORE}.tmp`
  writeFileSync(tmp, storeBody(url, auth))
  renameSync(tmp, STORE)
}

const ha1 = await startHa()
const ha2 = await startHa()
process.env.AISIS_ADAPTER_INTENT_URL = `${ha1.url}/intent/decide`

const connection = await import('./ha-connection.ts')
const layer = await import('./ha-intents.ts')
const fillers = await import('./fillers.ts')
const { matchFastIntent } = layer

let pass = 0
let total = 0
const failures: string[] = []
const check = (name: string, ok: boolean, detail = '') => {
  total++
  if (ok) pass++
  else failures.push(`${name} ${detail}`.trim())
}
const show = (result: Result) => JSON.stringify(result)
const earcon = (value: Result) => value?.kind === 'reply' && value.text === null && (value.quasarDirectives?.length ?? 0) > 0
const says = (value: Result, text: string) => value?.kind === 'reply' && value.text === text && value.listen === undefined
const spoken: string[] = []

const UNREACHABLE = 'Home Assistant недоступен.'
const TIMEOUT = 'Home Assistant не ответил вовремя, результат команды не проверен.'
const REAL_ERROR = 'Не удалось выполнить команду умного дома.'
const PHRASE = 'выключи свет на кухне'

// Fresh state for one scenario: the store, the fakes' bookkeeping, the layer's token cache.
function scenario (ha: FakeHa, auth: StoreAuth, url = ha.url): void {
  connection.resetHaConnection()
  writeStore(url, auth)
  for (const fake of [ha1, ha2]) {
    fake.calls.length = 0
    fake.authHeaders.length = 0
    fake.tokenForms.length = 0
    fake.tokenMode = 'ok'
    fake.tokenLifetime = 1800
    fake.tokenDelayMs = 0
    fake.serviceDelayMs = 0
    fake.serviceStatus = 200
    fake.serviceDrop = false
    fake.readDelayMs = 0
    fake.readBodyStallMs = 0
    fake.readDelayAfterCallMs = 0
    fake.readBodyStallAfterCallMs = 0
    fake.providersAuth.length = 0
    fake.providersDelayMs = 0
    fake.providersStatus = 200
    fake.leaveUnchanged = false
    fake.accepted.clear()
    for (const light of Object.values(fake.lights)) light.state = 'on'
  }
  ha.accepted.add('LLAT')
}
const LONG: StoreAuth = { kind: 'long_lived', token: 'LLAT' }
const OAUTH = (token: string): StoreAuth => ({ kind: 'oauth', refresh_token: token })
const ask = async (phrase = PHRASE): Promise<Result> => {
  const result = await matchFastIntent(phrase)
  if (result?.text) spoken.push(result.text)
  return result
}
const tokenCalls = (ha: FakeHa) => ha.calls.filter(call => call === 'POST /auth/token').length

// ── long-lived token: the bearer as it is ───────────────────────────────────────────────────────────────────────────
scenario(ha1, LONG)
let result = await ask()
check('long-lived: the command is executed (earcon)', earcon(result), show(result))
check('long-lived: the token is the bearer, /auth/token is never called', tokenCalls(ha1) === 0 && ha1.authHeaders.every(header => header === 'Bearer LLAT'), ha1.calls.join(' | '))
check('long-lived: the device changed', ha1.lights['light.kukhnya'].state === 'off')

// ── OAuth: refresh, cache, expiry ───────────────────────────────────────────────────────────────────────────────────
scenario(ha1, OAUTH('RT-1'))
result = await ask()
check('oauth: the command is executed (earcon)', earcon(result), show(result))
check('oauth: one refresh for the whole turn (registry, reads, call and read-back share it)', tokenCalls(ha1) === 1, `${tokenCalls(ha1)} refreshes: ${ha1.calls.join(' | ')}`)
const form = ha1.tokenForms[0]
check('oauth: the refresh is grant_type=refresh_token + refresh_token + client_id',
  form?.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'RT-1' && form.get('client_id') === 'http://192.168.0.56:8781/', form?.toString())
check('oauth: the API gets the minted access token as bearer', ha1.authHeaders.length > 0 && ha1.authHeaders.every(header => header === 'Bearer at-1'), ha1.authHeaders.join())
ha1.lights['light.kukhnya'].state = 'on'
result = await ask()
check('oauth: a second turn reuses the cached access token', earcon(result) && tokenCalls(ha1) === 1, `${tokenCalls(ha1)} refreshes`)

scenario(ha1, OAUTH('RT-2'))
ha1.tokenLifetime = 60 // cached until expires_in - 60 s = already over
await ask()
ha1.lights['light.kukhnya'].state = 'on'
await ask()
check('oauth: a token is cached only until expires_in - 60 s (60 s lifetime is never cached)', tokenCalls(ha1) >= 2, `${tokenCalls(ha1)} refreshes`)

// ── a 401 renews the token once ─────────────────────────────────────────────────────────────────────────────────────
scenario(ha1, OAUTH('RT-3'))
await ask()
const before = tokenCalls(ha1)
ha1.accepted.clear() // Home Assistant forgot the access token (restart, expiry)
ha1.lights['light.kukhnya'].state = 'on'
result = await ask()
check('401: the turn still succeeds after one renewal', earcon(result), show(result))
check('401: exactly one refresh for it', tokenCalls(ha1) === before + 1, `${tokenCalls(ha1) - before} refreshes`)

scenario(ha1, OAUTH('RT-4'))
ha1.tokenMode = 'unaccepted' // every token the API gets is refused
result = await ask()
check('401 that persists: each request renews once and repeats once, never a loop (3 requests: read, call, read-back)', tokenCalls(ha1) <= 3 && ha1.calls.length <= 8, ha1.calls.join(' | '))
check('401 that persists: says the generic failure, not a success', says(result, REAL_ERROR), show(result))

// ── revoked access ──────────────────────────────────────────────────────────────────────────────────────────────────
scenario(ha1, OAUTH('RT-5'))
ha1.tokenMode = 'invalid_grant'
result = await ask()
check('invalid_grant: behaves as unreachable for HA actions', says(result, UNREACHABLE), show(result))
const revokedRefreshes = tokenCalls(ha1)
await ask()
check('invalid_grant: the revoked grant is not hammered on every turn', tokenCalls(ha1) === revokedRefreshes, `${tokenCalls(ha1)} vs ${revokedRefreshes}`)
ha1.tokenMode = 'ok'
writeStore(ha1.url, OAUTH('RT-5-new'))
result = await ask()
check('invalid_grant: a new credential in the store is picked up', earcon(result), show(result))

// ── the address changes in the file mid-run ─────────────────────────────────────────────────────────────────────────
scenario(ha1, LONG)
ha2.accepted.add('LLAT')
result = await ask()
check('address: first turn on the first Home Assistant', earcon(result) && ha1.calls.length > 0 && ha2.calls.length === 0, show(result))
writeStore(ha2.url, LONG) // atomic rename, new mtime and inode
ha2.calls.length = 0
ha1.calls.length = 0
ha1.lights['light.kukhnya'].state = 'on'
ha2.lights['light.kukhnya'].state = 'on'
result = await ask()
check('address: the next turn goes to the new address', earcon(result) && ha2.calls.length > 0 && ha1.calls.length === 0, `${show(result)} ha1=${ha1.calls.length} ha2=${ha2.calls.length}`)

// The file is changed in place with the same inode, size and mtime: only a failure can reveal it.
scenario(ha1, LONG)
ha2.accepted.add('LLAT')
const dead = await deadUrl()
const padTo = (url: string, width: number) => storeBody(url, LONG, 'Home').replace('"Home"', `"${'H'.padEnd(width, 'x')}"`)
const deadBody = padTo(dead, 8)
writeFileSync(STORE, deadBody)
const SECOND = 1_700_000_000 // a whole-second mtime survives utimes() exactly, whatever the file system's resolution
utimesSync(STORE, SECOND, SECOND)
connection.resetHaConnection()
const key = statSync(STORE)
await ask('что включено') // the layer loads the store pointing at the dead address
const liveBody = padTo(ha2.url, 8 + deadBody.length - padTo(ha2.url, 8).length)
writeFileSync(STORE, liveBody)
utimesSync(STORE, SECOND, SECOND)
const after = statSync(STORE)
const hidden = after.mtimeMs === key.mtimeMs && after.size === key.size && after.ino === key.ino
check('address (hidden change): the premise holds, inode/size/mtime unchanged', hidden, `${key.mtimeMs}/${key.size} -> ${after.mtimeMs}/${after.size}`)
ha2.calls.length = 0
result = await ask()
check('address (hidden change): a connection failure re-reads the store and retries once at the new address',
  earcon(result) && ha2.calls.length > 0, `${show(result)} ha2=${ha2.calls.length}`)

// ── unreachable ─────────────────────────────────────────────────────────────────────────────────────────────────────
scenario(ha1, LONG, await deadUrl())
const started = Date.now()
result = await ask()
check('unreachable: «Home Assistant недоступен.»', says(result, UNREACHABLE), show(result))
check('unreachable: it answers at once, not after the timeout', Date.now() - started < 1500, `${Date.now() - started} ms`)
scenario(ha1, OAUTH('RT-6'), await deadUrl())
result = await ask()
check('unreachable at the token refresh: the same wording', says(result, UNREACHABLE), show(result))

// ── hung ────────────────────────────────────────────────────────────────────────────────────────────────────────────
scenario(ha1, LONG)
ha1.serviceDelayMs = 6000
let t0 = Date.now()
result = await ask()
let elapsed = Date.now() - t0
check('hung service call: «не ответил вовремя, результат не проверен»', says(result, TIMEOUT), show(result))
check('hung service call: after 3 s, not before and not much later', elapsed >= 2900 && elapsed < 3800, `${elapsed} ms`)
ha1.serviceDelayMs = 0

scenario(ha1, OAUTH('RT-7'))
ha1.tokenLifetime = 60 // never cached: every call refreshes first
ha1.tokenDelayMs = 2000 // a refresh alone fits the 3 s of one call; refresh + a 2 s service call does not
ha1.serviceDelayMs = 2000
result = await ask()
check('token refresh + service call share ONE 3 s budget', says(result, TIMEOUT), show(result))
ha1.tokenDelayMs = 0
ha1.serviceDelayMs = 0

// ── what the speaker says without any proxy ─────────────────────────────────────────────────────────────────────────
scenario(ha1, LONG)
ha1.serviceStatus = 500
result = await ask()
check('HA answers 5xx to the call: the generic failure text', says(result, REAL_ERROR), show(result))
ha1.serviceStatus = 400
result = await ask()
check('HA answers 4xx to the call: the generic failure text', says(result, REAL_ERROR), show(result))

scenario(ha1, LONG)
ha1.leaveUnchanged = true
result = await ask()
check('200 but the device did not change: the layer\'s own read-back says so (no earcon)',
  result?.kind === 'reply' && /^Не получилось выключить/.test(result.text ?? ''), show(result))

scenario(ha1, LONG)
result = await ask('что включено')
check('a state answer is the plain one', result?.kind === 'reply' && /^Сейчас /.test(result.text ?? ''), show(result))
ha1.lights['light.kukhnya'].state = 'off'
result = await ask(PHRASE)
check('«уже выключено» is answered from the live read', result?.kind === 'reply' && /уже/i.test(result.text ?? ''), show(result))

// ── the read-back after a command, and what a command in doubt is called ────────────────────────────────────────────────
for (const [phrase, label] of [[PHRASE, 'one light'], ['выключи весь свет', 'whole domain'], ['яркость 50', 'set-point']]) {
  scenario(ha1, LONG)
  ha1.readDelayAfterCallMs = 3500
  result = await ask(phrase)
  check(`${label}: the read-back after the call times out: «не ответил вовремя»`, says(result, TIMEOUT), `${phrase}: ${show(result)}`)
}
scenario(ha1, LONG)
ha1.readBodyStallAfterCallMs = 3500
result = await ask()
check('the read-back sends headers but stalls its body: «не ответил вовремя»', says(result, TIMEOUT), show(result))
scenario(ha1, LONG)
ha1.readDelayMs = 3500
result = await ask()
check('a read that times out BEFORE any call keeps the generic failure and sends nothing',
  says(result, REAL_ERROR) && !ha1.calls.some(call => call.startsWith('POST /api/services')), `${show(result)} ${ha1.calls.join(' | ')}`)
scenario(ha1, LONG)
result = await ask('выключи свет на кухне и в гостиной')
check('two targets: both called, read back, earcon', earcon(result) && ha1.calls.filter(call => call.startsWith('POST /api/services')).length === 2, show(result))
scenario(ha1, LONG)
ha1.serviceDrop = true
result = await ask()
check('connection cut after the call was sent: «не ответил вовремя», the call is not repeated',
  says(result, TIMEOUT) && ha1.calls.filter(call => call.startsWith('POST /api/services')).length === 1, `${show(result)} ${ha1.calls.join(' | ')}`)

const SITES: Array<[string, string, string]> = [
  ['выключи весь свет', 'whole domain', '/api/services/light/turn_off'],
  ['яркость 50', 'set-point', '/api/services/light/turn_on'],
  ['включи ютуб на телевизоре', 'TV application', '/api/services/script/turn_on'],
  ['включи камин на проекторе', 'projector fireplace', '/api/services/script/turn_on']
]
for (const [phrase, label, expected] of SITES) {
  scenario(ha1, LONG)
  ha1.serviceStatus = 500
  result = await ask(phrase)
  check(`${label}: HA answers 5xx: generic failure`, says(result, REAL_ERROR) && ha1.calls.some(call => call.startsWith(`POST ${expected}`)), `${phrase}: ${show(result)} ${ha1.calls.join(' | ')}`)
  scenario(ha1, LONG)
  ha1.serviceDelayMs = 6000
  result = await ask(phrase)
  check(`${label}: no answer in 3 s: «не ответил вовремя»`, says(result, TIMEOUT), `${phrase}: ${show(result)}`)
}

// ── Home Assistant down: a phrase that is not a home command still reaches the brain ──────────────────────────────────
scenario(ha1, LONG)
await ask() // warm entity map
scenario(ha1, LONG, await deadUrl())
const realNow = Date.now
Date.now = () => realNow() + 120_000 // the cached entity map is expired: the refresh finds Home Assistant down
result = await ask('расскажи анекдот')
Date.now = realNow
check('HA down, expired entity map: a non-home phrase goes on to the brain (null or llm, never «недоступен»)', result === null || result.kind === 'llm', show(result))

// ── no store ────────────────────────────────────────────────────────────────────────────────────────────────────────
scenario(ha1, LONG)
rmSync(STORE)
result = await ask()
check('no store file: the layer is disabled (null, no HA traffic)', result === null && ha1.calls.length === 0, `${show(result)} ${ha1.calls.join()}`)
writeFileSync(STORE, '{ not json')
connection.resetHaConnection()
result = await ask()
check('unreadable store: the layer is disabled', result === null && ha1.calls.length === 0, show(result))
writeFileSync(STORE, JSON.stringify({ auth: { kind: 'oauth', refresh_token: 'x' }, url: ha1.url, version: 1 }))
connection.resetHaConnection()
result = await ask()
check('an oauth store without client_id is unusable: disabled', result === null, show(result))

// ── the health poll of the fillers ──────────────────────────────────────────────────────────────────────────────────
const plan = async () => (await fillers.classifyForFiller('что включено')).immediate
scenario(ha1, LONG)
ha1.providersStatus = 401 // any answer below 500 means up
await fillers.pollHaHealth()
check('health: /auth/providers answered (401 is still «up»)', await plan() === 'state', String(await plan()))
check('health: it asked /auth/providers, without credentials, and never /health', ha1.calls.includes('GET /auth/providers') && !ha1.calls.some(call => /\/health/.test(call)) && ha1.providersAuth.length > 0 && ha1.providersAuth.every(header => header === undefined), ha1.calls.join(' | '))
ha1.providersStatus = 503
await fillers.pollHaHealth()
check('health: 5xx is not up', await plan() === 'ha_down', String(await plan()))
ha1.providersStatus = 200
await fillers.pollHaHealth()
check('health: up again', await plan() === 'state', String(await plan()))
scenario(ha1, LONG, await deadUrl())
await fillers.pollHaHealth()
check('health: a refused connection is «down»', await plan() === 'ha_down', String(await plan()))
scenario(ha1, LONG)
await fillers.pollHaHealth()
check('health: back up after the address is right again', await plan() === 'state', String(await plan()))
ha1.providersDelayMs = 5000
t0 = Date.now()
await fillers.pollHaHealth()
check('health: no answer within 2 s is «down», the poll gives up at 2 s', await plan() === 'ha_down' && Date.now() - t0 < 2800, `${Date.now() - t0} ms`)
fillers.resetFillerState()
t0 = Date.now()
await fillers.classifyForFiller('что включено')
check('classification never waits for the health poll', Date.now() - t0 < 700, `${Date.now() - t0} ms`)
ha1.providersDelayMs = 0

check('nothing the speaker said promises to run the command later or claims a reboot',
  spoken.every(text => !/перезагруж|когда он вернётся|в очереди|по последним данным/i.test(text)), spoken.join(' | '))

ha1.server.closeAllConnections()
ha2.server.closeAllConnections()
ha1.server.close()
ha2.server.close()
rmSync(dir, { force: true, recursive: true })
console.log(`ИТОГ ${pass}/${total}`)
for (const failure of failures) console.log(`ПРОВАЛ ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)

// Run inside a quasar image with the overlay mounted over /src/backend (README.md). The fast layer is the REAL one; ha-cli (the
// "Home Assistant" the layer talks to) is a stub on a loopback port inside the throwaway container (no network) that answers
// a service call the way the new ha-cli does: status + X-Aisis-Verify / -Verify-Reason / -Down headers.
//   docker run --rm --network none --entrypoint /node_modules/.bin/tsx \
//     -v "$PWD/check_ha_verify_wording.mts:/src/backend/check_ha_verify_wording.mts:ro" \
//     -v "$OVERLAY/backend/ha-intents.ts:/src/backend/ha-intents.ts:ro" "$IMAGE" /src/backend/check_ha_verify_wording.mts
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

type Result = null | { kind: string, listen?: boolean, quasarDirectives?: unknown[], text: null | string }
interface Layer { haRecoveryText?: (down: string | undefined) => string, matchFastIntent: (text: string, options?: object) => Promise<Result> }
// headersByEntity: per-target headers of a multi-target call (they win over `headers`); leaveUnchanged: the call is answered 200 but
// the device does not change; readDelayAfterMs: reads (GET) are delayed from the moment the call is answered on;
// readBodyStallAfterMs: reads answer their headers at once but stall the body.
interface Reply { afterwardsStale?: boolean, delayMs?: number, headers?: Record<string, string>, headersByEntity?: Record<string, Record<string, string>>, leaveUnchanged?: boolean, readBodyStallAfterMs?: number, readDelayAfterMs?: number, status: number }

process.env.AISIS_HA_TOKEN = 'check-only'

const lights: Record<string, { area: string, name: string, state: string }> = {
  'light.gostinaya': { area: 'Гостиная', name: 'Гостиная', state: 'on' },
  'light.kukhnya': { area: 'Кухня', name: 'Кухня', state: 'on' }
}
const serviceCalls: string[] = []
let serviceReply: Reply = { status: 200 }
let staleReads = false          // Home Assistant went away after the call: ha-cli answers reads from its cache, marked stale
let readDelayMs = 0
let readBodyStallMs = 0

const entity = (id: string) => ({ attributes: { friendly_name: lights[id].name }, entity_id: id, state: lights[id].state })
const server = createServer((request, response) => {
  let raw = ''
  request.on('data', chunk => { raw += String(chunk) })
  request.on('end', () => {
    const url = request.url ?? ''
    const json = (value: unknown) => {
      const isRead = url.startsWith('/api/')
      setTimeout(() => {
        response.writeHead(200, { 'Content-Type': 'application/json', ...(staleReads ? { 'X-Aisis-Cache': 'stale' } : {}) })
        if (isRead && readBodyStallMs > 0) {
          response.flushHeaders()
          setTimeout(() => response.end(JSON.stringify(value)), readBodyStallMs)
          return
        }
        response.end(JSON.stringify(value))
      }, isRead ? readDelayMs : 0)
    }
    if (url === '/intent/decide') return json({ route: 'none' })
    if (url === '/api/states') return json(Object.keys(lights).map(entity))
    if (url === '/api/template') {
      response.writeHead(200, staleReads ? { 'X-Aisis-Cache': 'stale' } : {})
      response.end(Object.entries(lights).map(([id, light]) => `${id}\t${light.name}\t${light.area}\n`).join(''))
      return
    }
    const one = /^\/api\/states\/(light\.\w+)$/.exec(url)
    if (one !== null && lights[one[1]] !== undefined) return json(entity(one[1]))
    if (/^\/api\/services\//.test(url)) {
      serviceCalls.push(`${url} ${raw}`)
      // A verified call really changes the light (what a 200 from ha-cli means); every other answer leaves it alone.
      const turn = /\/light\/turn_(on|off)$/.exec(url)
      const body = raw === '' ? {} : JSON.parse(raw) as { entity_id?: string }
      if (serviceReply.status === 200 && turn !== null && serviceReply.leaveUnchanged !== true) {
        const ids = body.entity_id === 'all' ? Object.keys(lights) : [body.entity_id ?? '']
        for (const id of ids) if (lights[id] !== undefined) lights[id].state = turn[1]
      }
      const reply = serviceReply
      if (reply.afterwardsStale === true) staleReads = true
      if (reply.readDelayAfterMs !== undefined) readDelayMs = reply.readDelayAfterMs
      if (reply.readBodyStallAfterMs !== undefined) readBodyStallMs = reply.readBodyStallAfterMs
      setTimeout(() => {
        response.writeHead(reply.status, { 'Content-Type': 'application/json', ...reply.headers, ...reply.headersByEntity?.[body.entity_id ?? ''] })
        response.end('[]')
      }, reply.delayMs ?? 0)
      return
    }
    response.writeHead(404)
    response.end('')
  })
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
process.env.AISIS_HA_URL = base
process.env.AISIS_ADAPTER_INTENT_URL = `${base}/intent/decide`

const loaded = await import('./ha-intents.ts') as Layer & { default?: Layer }
const layer = loaded.matchFastIntent === undefined ? loaded.default! : loaded
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
const spoken: string[] = []
const ask = async (reply: Reply, phrase = 'выключи свет'): Promise<Result> => {
  lights['light.gostinaya'].state = 'on'
  lights['light.kukhnya'].state = 'on'
  serviceCalls.length = 0
  serviceReply = reply
  staleReads = false
  readDelayMs = 0
  readBodyStallMs = 0
  const result = await matchFastIntent(phrase)
  if (result?.text) spoken.push(result.text)
  return result
}
const says = (result: Result, text: string) => result?.kind === 'reply' && result.text === text && result.listen === undefined

const STARTING = 'Home Assistant запускается, команду выполню, когда он вернётся.'
const DOWN = 'Home Assistant недоступен, команду выполню, когда он вернётся.'
const NO_EVIDENCE = 'Не получилось проверить ответ Home Assistant, команда ждёт в очереди.'
const UNKNOWN = 'Не получилось проверить ответ Home Assistant.'
const NOT_DONE = 'Команду отправил, но не вижу, чтобы устройство её выполнило.'
const UNAVAILABLE = 'Home Assistant видит это устройство недоступным.'
const TIMEOUT = 'Home Assistant не ответил вовремя, результат команды не проверен.'
const REAL_ERROR = 'Не удалось выполнить команду умного дома.'

// ── 202: ha-cli OBSERVED Home Assistant gone ───────────────────────────────────────────────────────────────────────
for (const down of ['refused', 'reset', 'dns', 'unreachable', 'http_503']) {
  const result = await ask({ headers: { 'x-aisis-down': down, 'x-aisis-eta': '40' }, status: 202 })
  check(`202 down=${down}: says unavailable, no ETA, no reboot`, says(result, DOWN), show(result))
  check(`202 down=${down}: the service call was made once`, serviceCalls.length === 1, serviceCalls.join())
}
let result = await ask({ headers: { 'x-aisis-down': 'starting' }, status: 202 })
check('202 down=starting: says it is starting', says(result, STARTING), show(result))
result = await ask({ status: 202 })
check('202 without evidence (an old ha-cli queued on a timeout): says it could not check', says(result, NO_EVIDENCE), show(result))
check('haRecoveryText is exported: three texts', layer.haRecoveryText?.('starting') === STARTING && layer.haRecoveryText('refused') === DOWN && layer.haRecoveryText(undefined) === NO_EVIDENCE)

// ── 504 / 502: the verdict of the verification, not a guess ────────────────────────────────────────────────────────
result = await ask({ headers: { 'x-aisis-verify': 'unknown', 'x-aisis-verify-reason': 'ha_no_answer' }, status: 504 })
check('504 unknown: says it could not check, not «не удалось выполнить»', says(result, UNKNOWN), show(result))
result = await ask({ headers: { 'x-aisis-verify': 'unknown', 'x-aisis-verify-reason': 'no_answer_unverifiable' }, status: 504 })
check('504 unknown no_answer_unverifiable: same wording', says(result, UNKNOWN), show(result))
result = await ask({ headers: { 'x-aisis-verify': 'failed', 'x-aisis-verify-reason': 'state_mismatch' }, status: 502 })
check('502 failed: says the command was sent but not seen done', says(result, NOT_DONE), show(result))
result = await ask({ headers: { 'x-aisis-verify': 'failed', 'x-aisis-verify-reason': 'device_unavailable' }, status: 502 })
check('502 failed device_unavailable: says Home Assistant sees the device unavailable', says(result, UNAVAILABLE), show(result))
result = await ask({ headers: { 'x-aisis-verify': 'failed' }, status: 502 })
check('502 failed without a reason: still the observed wording', says(result, NOT_DONE), show(result))
result = await ask({ status: 500 })
check('a plain HTTP error without a verdict keeps «не удалось выполнить»', says(result, REAL_ERROR), show(result))
result = await ask({ headers: { 'x-aisis-verify': 'skipped' }, status: 400 })
check('a rejected request (verify skipped) keeps «не удалось выполнить»', says(result, REAL_ERROR), show(result))

// ── 200: verified, the earcon as before ────────────────────────────────────────────────────────────────────────────
result = await ask({ headers: { 'x-aisis-verify': 'ok' }, status: 200 })
check('200 ok: a confirming earcon and no text', result?.kind === 'reply' && result.text === null && (result.quasarDirectives?.length ?? 0) > 0, show(result))

// ── 200 without X-Aisis-Verify (an older ha-cli): the layer's own read-back decides, never the bare status ─────────────
const earcon = (value: Result) => value?.kind === 'reply' && value.text === null && (value.quasarDirectives?.length ?? 0) > 0
const failedToDo = (value: Result) => value?.kind === 'reply' && /^Не получилось (выключить|поставить)/.test(value.text ?? '') && !earcon(value)
const BOTH_ROOMS = 'выключи свет на кухне и в гостиной'
result = await ask({ status: 200 })
check('200 without a header, device changed: success after the layer\'s own read-back', earcon(result), show(result))
result = await ask({ leaveUnchanged: true, status: 200 })
check('200 without a header, device unchanged: no success earcon, the read-back ran and failed', failedToDo(result), show(result))
result = await ask({ leaveUnchanged: true, status: 200 }, 'яркость 50')
check('200 without a header, set-point unchanged: no success earcon', failedToDo(result), show(result))
for (const [phrase, label] of [['выключи свет', 'one light'], ['выключи весь свет', 'whole domain'], ['яркость 50', 'set-point']]) {
  result = await ask({ readDelayAfterMs: 3500, status: 200 }, phrase)
  check(`${label}: 200 without a header, the read-back times out: unknown outcome wording`, says(result, TIMEOUT), `${phrase}: ${show(result)}`)
}
result = await ask({ readBodyStallAfterMs: 3500, status: 200 }, 'выключи свет')
check('200 without a header, the read-back sends headers but stalls its body: unknown outcome wording', says(result, TIMEOUT), show(result))
result = await ask({ headers: { 'x-aisis-verify': 'ok' }, readDelayAfterMs: 3500, status: 200 })
check('200 verified by ha-cli: a slow read afterwards is never looked at', earcon(result), show(result))

// ── several targets: ha-cli confirmed only some of them ───────────────────────────────────────────────────────────
result = await ask({ headers: { 'x-aisis-verify': 'ok' }, status: 200 }, BOTH_ROOMS)
check('two targets, both verified by ha-cli: success', earcon(result) && serviceCalls.length === 2, `${serviceCalls.length} calls ${show(result)}`)
result = await ask({ headersByEntity: { 'light.gostinaya': { 'x-aisis-verify': 'ok' } }, leaveUnchanged: true, status: 200 }, BOTH_ROOMS)
check('two targets, only one verified by ha-cli, the other unchanged: no success earcon', serviceCalls.length === 2 && failedToDo(result), `${serviceCalls.length} calls ${show(result)}`)
result = await ask({ headersByEntity: { 'light.gostinaya': { 'x-aisis-verify': 'ok' } }, status: 200 }, BOTH_ROOMS)
check('two targets, only one verified by ha-cli, the other changed: success only after the read-back', earcon(result) && serviceCalls.length === 2, `${serviceCalls.length} calls ${show(result)}`)
result = await ask({ headersByEntity: { 'light.gostinaya': { 'x-aisis-verify': 'ok' } }, readDelayAfterMs: 3500, status: 200 }, BOTH_ROOMS)
check('two targets, only one verified by ha-cli, the read-back for the other times out: unknown outcome wording', serviceCalls.length === 2 && says(result, TIMEOUT), `${serviceCalls.length} calls ${show(result)}`)

// ── the other call sites ───────────────────────────────────────────────────────────────────────────────────────────
const SITES: Array<[string, string, string]> = [
  ['выключи весь свет', 'whole domain', '/api/services/light/turn_off {"entity_id":"all"}'],
  ['яркость 50', 'set-point', '/api/services/light/turn_on'],
  ['включи ютуб на телевизоре', 'TV application', '/api/services/script/turn_on'],
  ['включи камин на проекторе', 'projector fireplace', '/api/services/script/turn_on']
]
for (const [phrase, label, expected] of SITES) {
  result = await ask({ headers: { 'x-aisis-down': 'refused' }, status: 202 }, phrase)
  check(`${label}: 202 says unavailable`, says(result, DOWN), `${phrase}: ${show(result)}`)
  check(`${label}: reached the expected call site`, serviceCalls.some(call => call.startsWith(expected)), `${phrase}: ${serviceCalls.join(' | ')}`)
  result = await ask({ headers: { 'x-aisis-verify': 'unknown', 'x-aisis-verify-reason': 'state_unreadable' }, status: 504 }, phrase)
  check(`${label}: 504 unknown says it could not check`, says(result, UNKNOWN), `${phrase}: ${show(result)}`)
}

// ── ha-cli verified the call, then Home Assistant went away: the layer's own read-back would only see stale cache ─────
for (const [phrase, label] of [['выключи свет', 'one light'], ['выключи весь свет', 'whole domain'], ['яркость 50', 'set-point']]) {
  result = await ask({ afterwardsStale: true, headers: { 'x-aisis-verify': 'ok' }, status: 200 }, phrase)
  check(`${label}: 200 verified by ha-cli stays a success when the reads afterwards are stale`,
    result?.kind === 'reply' && result.text === null && (result.quasarDirectives?.length ?? 0) > 0, `${phrase}: ${show(result)}`)
}

// ── haFetch gives up (3 s) ────────────────────────────────────────────────────────────────────────────────────────
result = await ask({ delayMs: 3500, status: 200 })
check('a service call that timed out says it did not answer in time, not «не удалось выполнить»', says(result, TIMEOUT), show(result))
// A read that timed out before any command was sent: no command is in doubt, the generic failure text stays.
lights['light.gostinaya'].state = 'on'
readDelayMs = 3500
serviceCalls.length = 0
result = await matchFastIntent('выключи свет на кухне')
readDelayMs = 0
check('a read that timed out before any call keeps «не удалось выполнить»', says(result, REAL_ERROR) && serviceCalls.length === 0, `${show(result)} ${serviceCalls.join()}`)

check('nothing the speaker said claims a reboot', spoken.every(text => !/перезагруж/i.test(text)), spoken.join(' | '))

server.close()
console.log(`ИТОГ ${pass}/${total}`)
for (const failure of failures) console.log(`ПРОВАЛ ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)

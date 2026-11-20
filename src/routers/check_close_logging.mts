// Run inside a quasar image with the overlay mounted over /src (README.md): real WebSocket clients connect to the real router and end
// the connection in each way; the log level and text of every close are checked. The logger and the connection class are replaced by
// recorders, so nothing here needs the database, Home Assistant or the network.
//   docker run --rm --network none --entrypoint /node_modules/.bin/tsx \
//     -v "$PWD/check_close_logging.mts:/src/routers/check_close_logging.mts:ro" \
//     -v "$OVERLAY/routers/uniproxy.alice.yandex.net.ts:/src/routers/uniproxy.alice.yandex.net.ts:ro" IMAGE /src/routers/check_close_logging.mts
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

interface Record { level: string, message: string }
const records: Record[] = []
const recorder = (level: string) => (...args: unknown[]): void => { records.push({ level, message: args.map(String).join(' ') }) }
const fakeLogger = { debug: recorder('debug'), info: recorder('info'), warn: recorder('warn'), error: recorder('error') }

// The router is CommonJS in this image: put the stand-ins in the module cache before it is loaded.
const require = createRequire(import.meta.url)
const stub = (path: string, exports: object): void => {
  require.cache[path] = { id: path, filename: path, loaded: true, exports, children: [], paths: [], path } as unknown as NodeModule
}
stub(`${root}/logger.ts`, { getLogger: () => fakeLogger })
stub(`${root}/routers/uniproxy/uniproxy-connection.ts`, { UniProxyConnection: class { constructor (readonly websocket: unknown, readonly deviceId: string) {} } })
const router = require(`${root}/routers/uniproxy.alice.yandex.net.ts`) as {
  registerUniproxyAliceYandexNetRouter: (parameters: object, server: import('node:http').Server) => unknown
}

const server = createServer()
router.registerUniproxyAliceYandexNetRouter({}, server)
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as AddressInfo).port

let pass = 0
let total = 0
const failures: string[] = []
function check (name: string, ok: boolean, detail?: unknown): void {
  total++
  if (ok) pass++
  else failures.push(`${name}: ${JSON.stringify(detail)}`)
}

const sleep = async (ms: number): Promise<void> => { await new Promise(resolve => setTimeout(resolve, ms)) }
async function until (condition: () => boolean): Promise<boolean> {
  for (let waited = 0; waited < 3000; waited += 20) {
    if (condition()) return true
    await sleep(20)
  }
  return condition()
}
const closes = (): Record[] => records.filter(record => record.message.startsWith('UniProxy WebSocket closed'))

/** Connect as `device`, run `end` on the open client, wait for exactly one new close line and return it. */
async function endConnection (device: string, end: (client: WebSocket) => void): Promise<Record | undefined> {
  const before = closes().length
  const client = new WebSocket(`ws://127.0.0.1:${port}/uni.ws`, { headers: { 'x-uprx-device-id': device, 'x-uprx-device-model': 'check' } })
  client.on('error', () => {})
  await new Promise<void>(resolve => client.once('open', () => { resolve() }))
  end(client)
  await until(() => closes().length > before)
  await sleep(50)   // a second line for the same close would show up here
  check(`${device}: exactly one close line`, closes().length === before + 1, closes().slice(before))
  return closes()[before]
}

// The peer ended the connection itself: INFO, not a warning.
for (const [name, end, code] of [
  ['close(1000)', (c: WebSocket) => { c.close(1000) }, 1000],
  ['close(1001, going away)', (c: WebSocket) => { c.close(1001, 'going away') }, 1001],
  ['close() with no status', (c: WebSocket) => { c.close() }, 1005]
] as const) {
  const line = await endConnection('M00ZRW3008RAJG', end)
  check(`${name}: INFO, not WARN`, line?.level === 'info', line)
  check(`${name}: text`, line?.message.startsWith(`UniProxy WebSocket closed (normal): code=${code} device=M00ZRW3008RAJG `) === true, line)
  check(`${name}: carries the connection age`, /age=\d+ms$/.test(line?.message ?? ''), line)
}
const goingAway = closes().find(record => record.message.includes('code=1001'))
check('the reason text is quoted', goingAway?.message.includes('reason="going away"') === true, goingAway)

// Anything else is still a warning.
for (const [name, end, code] of [
  ['terminate (no close frame)', (c: WebSocket) => { c.terminate() }, 1006],
  ['close(1011, boom)', (c: WebSocket) => { c.close(1011, 'boom') }, 1011],
  ['close(1008)', (c: WebSocket) => { c.close(1008) }, 1008],
  ['close(4000)', (c: WebSocket) => { c.close(4000) }, 4000]
] as const) {
  const line = await endConnection('bg-smoke-1', end)
  check(`${name}: WARN`, line?.level === 'warn', line)
  check(`${name}: text`, line?.message.startsWith(`UniProxy WebSocket closed abnormally: code=${code} device=bg-smoke-1 `) === true, line)
}
const boom = closes().find(record => record.message.includes('code=1011'))
check('an abnormal close keeps its reason', boom?.message.includes('reason="boom"') === true, boom)

// A device id and a reason are peer text: neither can break the line.
const odd = await endConnection('a b"c\\d', c => { c.close(1011, 'two\nlines') })
check('device id is sanitized', odd?.message.includes('device=a?b?c?d ') === true, odd)
check('reason newline is escaped, the line stays one line', odd?.message.includes('\n') === false && odd.message.includes('two\\nlines'), odd)

// The old line is gone: no close is logged without a code.
check('no close line without a code', closes().every(record => /code=\d+/.test(record.message)), closes())
check('no normal close is a WARN', closes().filter(record => record.level === 'warn').every(record => !record.message.includes('(normal)')), closes())

// A connection without a device id is refused by the router itself, before anything is registered; that is unchanged.
const before = records.length
const refused = new WebSocket(`ws://127.0.0.1:${port}/uni.ws`)
refused.on('error', () => {})
const refusedCode = await new Promise<number>(resolve => refused.once('close', code => { resolve(code) }))
await sleep(50)
check('a connection without a device id is closed with 1008', refusedCode === 1008, refusedCode)
check('...and logs no close line', records.slice(before).every(record => !record.message.startsWith('UniProxy WebSocket closed')), records.slice(before))

server.close()
console.log(`ИТОГ ${pass}/${total}`)
for (const failure of failures) console.log('FAIL', failure)
process.exit(pass === total ? 0 : 1)

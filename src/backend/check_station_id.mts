// Offline check (UB-277): the speaker's id reaches the AISIS gateway, so its TV pause scopes itself to that speaker's room.
//   * the STT client names the station in the x-aisis-station header of every websocket it opens;
//   * the voice input handler hands the station of its connection to the STT backend;
//   * the «Dialog <id> started/ended» log lines end with station=<id>, which the gateway reads to release only that station's pauses.
// A real websocket server stands in for the gateway; nothing here needs the database, Home Assistant or the network. Exits 1 on any
// failure. Run: node_modules/.bin/tsx src/backend/check_station_id.mts
import { readFileSync } from 'node:fs'
import Module, { createRequire } from 'node:module'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

import type { AudioMetadataBackend, STTBackend, STTBackendSession } from './backend.ts'

// The native Opus binding is not built where this runs (CI installs with --ignore-scripts); the STT client only opens a websocket here,
// so a stub stands in for it.
const require = createRequire(import.meta.url)
const opusPath = require.resolve('@discordjs/opus')
const opusStub = new Module(opusPath)
opusStub.filename = opusPath
opusStub.loaded = true
opusStub.exports = { OpusEncoder: class { applyDecoderCTL (): void {} } }
require.cache[opusPath] = opusStub

const { GigaAMSTTBackend } = await import('./stt/gigaam.ts')
const { stationIdFor, withStation } = await import('./station-id.ts')
const { VoiceInputHandler } = await import('../routers/uniproxy/voice-input-handler.ts')

const root = dirname(dirname(fileURLToPath(import.meta.url)))
let pass = 0
let total = 0
const failures: string[] = []
function check (name: string, ok: boolean, detail?: unknown): void {
  total++
  if (ok) pass++
  else failures.push(`${name}: ${JSON.stringify(detail)}`)
}

// ── The helper ────────────────────────────────────────────────────────────────────────────────────────────────────────────
check('stationIdFor: a device id is the station id', stationIdFor('M0TESTSPEAKER1') === 'M0TESTSPEAKER1')
for (const bad of ['', 'a b', 'M00\r\nx-evil: 1', 'ё', 'x'.repeat(65), undefined]) {
  check(`stationIdFor: ${JSON.stringify(bad)} names no station`, stationIdFor(bad) === undefined)
}
check('withStation: the station ends the line', withStation('Dialog d started', 'M0TESTSPEAKER1') === 'Dialog d started station=M0TESTSPEAKER1')
check('withStation: a reason keeps its place before the station',
  withStation('Dialog d ended: serverFinished', 'M0TESTSPEAKER1') === 'Dialog d ended: serverFinished station=M0TESTSPEAKER1')
check('withStation: an unusable id leaves the line as it was', withStation('Dialog d started', 'a b') === 'Dialog d started')

// ── The STT client against a websocket server standing in for the gateway ─────────────────────────────────────────────────
const server = createServer()
const gateway = new WebSocketServer({ server })
const seen: Array<string | string[] | undefined> = []
gateway.on('connection', (_socket, request) => { seen.push(request.headers['x-aisis-station']) })
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`
const backend = new GigaAMSTTBackend(endpoint)

async function opened (station?: string): Promise<string | string[] | undefined> {
  const before = seen.length
  const session = await backend.startTranscribing(undefined, station)
  for (let waited = 0; waited < 2000 && seen.length === before; waited += 10) await new Promise(resolve => setTimeout(resolve, 10))
  session.close()
  return seen[before]
}

check('STT client: the station is named in x-aisis-station', await opened('M0TESTSPEAKER1') === 'M0TESTSPEAKER1')
check('STT client: no station, no header', await opened() === undefined)
check('STT client: an unusable id still opens the turn, without the header', await opened('a b') === undefined)
gateway.close()
server.close()

// ── The voice input handler hands the station of its connection to the STT backend ────────────────────────────────────────
const asked: Array<string | undefined> = []
const sttSession = {
  close: () => {},
  setCallback: () => {},
  transcribeChunk: () => {},
  finish: async () => {}
} as unknown as STTBackendSession
const stt: STTBackend = { startTranscribing: async (_span, station) => { asked.push(station); return sttSession } }
const audioMetadata = {
  startCapturing: async () => ({ close: () => {}, processChunk: async () => {}, finish: async () => ({}) })
} as unknown as AudioMetadataBackend
const handler = new VoiceInputHandler({ audioMetadata, stationId: 'M0TESTSPEAKER1', stt })
await handler.handleVoiceInputEvent({ metadata: { internal: {}, readyToUse: {} } })
handler.close()
check('VoiceInputHandler: the STT backend is asked for the station of its connection', asked.length === 1 && asked[0] === 'M0TESTSPEAKER1', asked)

// ── The wiring in the connection ──────────────────────────────────────────────────────────────────────────────────────────
const connection = readFileSync(`${root}/routers/uniproxy/uniproxy-connection.ts`, 'utf8')
check('connection: each connection has its own voice input handler that names its device',
  /new VoiceInputHandler\(\{[^}]*stationId: deviceId[^}]*\}\)/.test(connection))
check('connection: «Dialog … started» names the station', connection.includes('withStation(`Dialog ${this.dialogId} started`, this.deviceId)'))
check('connection: «Dialog … ended» names the station', connection.includes('withStation(`Dialog ${this.dialogId} ended: ${reason}`, this.deviceId)'))
check('connection: no other dialog line is logged without the station', (connection.match(/`Dialog \$\{this\.dialogId\} (started|ended)/g) ?? []).length === 2)

console.log(`ИТОГ ${pass}/${total}`)
for (const failure of failures) console.log('FAIL', failure)
process.exit(pass === total ? 0 : 1)

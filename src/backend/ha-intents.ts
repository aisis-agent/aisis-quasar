// Fast-intent layer in three tiers, in front of the LLM brain:
//
//  1. EXACT   scoreIntent(): verb + noun grammar over the home's entities
//             (exact 1.0 / stem 0.95 / typo 0.8). score >= 0.9 -> execute,
//             0.5..0.9 or ambiguous -> «Ты про …?» (legacy gray zone).
//  2. CATALOG intent-catalog.ts: underspecified or noisy phrases («громкость 10»
//             through ASR damage, «кондей 24», «свет на кухню») are fuzzy-scored
//             against a command catalog generated from the entity map and the
//             control actions -> execute / confirm / clarify (decideFastIntent).
//  3. LLM     nothing close -> the brain.
//
// Executed device/volume commands play the stock-Alice IoT earcon instead of
// speech (text null + local_audio_file_play); questions and errors are spoken.
// State queries («что включено») NEVER execute. Instant local math answers without
// the brain. Confirmations persist in /src/ha.ambiguity.json (a phrase the owner
// confirmed once is executed directly next time). Config: AISIS_HA_URL/
// AISIS_HA_TOKEN env or /src/ha.config.json; no config -> layer disabled.

import { AsyncLocalStorage } from 'node:async_hooks'
import { executeTvAppIntent, parseTvAppIntent, executeFireplaceIntent, parseFireplaceIntent } from './tv-app-intents'
import { readFileSync, writeFileSync } from 'node:fs'

import { getLogger } from '../logger'
import { encodeProtobufStruct } from '../protobuf'
import proto from '../protos/protos'
import { allowCorrection, confirmationQuestion, describeCorrection, eligible, endsMidPhrase, forgetAsked, noteAsked, requestCorrection, shadowOnly } from './asr-correct'
import { parseEndDialog } from './end-dialog'
import { matchEntityQuery } from './entity-index'
import { composeNumeral, editDistance, NUMBER_WORDS, normalize, parseNumbers, splitSentences, tokenize } from './fuzzy-ru'
import { grammarRoute } from './grammar-hook'
import { decideCatalog, DeviceIntent, isNarrativeVerbForm, LIGHT_WORDS, OFF_VERBS, ON_VERBS, parseUtterance, Resolved, Room, Utterance, VolumeIntent, World } from './intent-catalog'
import { tryMediaControl, tryMusicIntent } from './music-intents'
import { type MediaAction, parseMediaControl } from './music-parse'
import { hasNegation, isNegatedAt } from './negation'
import { shadowClassify } from './semantic-shadow'
import { DEFAULT_VOLUME_STEP_PCT, doneText, failureText, findSetting, getSettings, getValue, matchSettingQuery, postValue, queryAnswer, refreshSettings, volumeLevels, volumeStepPct } from './settings-voice'
import { speakerArea } from './speaker-room'
import { ActionRecord, latestAction, latestTurn, parseRepeat, recordTurn, rememberFor, RepeatTarget, stationKey, Turn, TurnOrigin } from './turn-memory'

export type FastIntentResult =
  | { kind: 'llm', text: string } // route this (rewritten) text to the LLM brain
  // `listen`: the turn asks the owner something (confirm/clarify/«не расслышала») and the
  // station must keep the mic open for the answer. Executed commands, state answers and
  // plain replies leave it unset: the dialog ends, no wake-free continuation.
  | { kind: 'reply', listen?: boolean, quasarDirectives: proto.NAlice.NAliceApi.ITDirective[], text: null | string } // null text = silent

interface HaEntity {
  attributes: { brightness?: number, friendly_name?: string, max_temp?: number, min_temp?: number, temperature?: number } & Record<string, unknown>
  last_changed?: string
  last_updated?: string
  entity_id: string
  state: string
}

interface HaRegistry {
  areaByEntity: Map<string, string>
  entities: Map<string, HaEntity>
  fetchedAt: number
  // true when the registry came from the ha-cli local cache because Home
  // Assistant is restarting.
  stale?: boolean
}

// Thrown when ha-cli OBSERVED Home Assistant gone (HTTP 202) and queued the call. `down` is the evidence ha-cli saw
// (X-Aisis-Down: refused|reset|dns|unreachable|starting|http_502|http_503|http_504), undefined when an older ha-cli queued the
// call on a timeout. etaSeconds (X-Aisis-Eta) is only logged: whether Home Assistant is "restarting" is not something anyone observed.
class HaQueuedError extends Error {
  constructor (message: string, readonly etaSeconds: number | undefined, readonly down: string | undefined) {
    super(message)
  }
}

function restartingError (response: Response): HaQueuedError {
  const eta = Number(response.headers.get('x-aisis-eta'))
  return new HaQueuedError('ha-cli queued the call', Number.isFinite(eta) && eta > 0 ? eta : undefined,
    response.headers.get('x-aisis-down') ?? undefined)
}

export function haRecoveryText (down: string | undefined): string {
  if (down === 'starting') return 'Home Assistant запускается, команду выполню, когда он вернётся.'
  if (down !== undefined) return 'Home Assistant недоступен, команду выполню, когда он вернётся.'
  return 'Не получилось проверить ответ Home Assistant, команда ждёт в очереди.'
}

// A service call whose outcome ha-cli checked against the device state and did not confirm. `say` is what the speaker says:
// only what was observed (X-Aisis-Verify: failed = the device did not do it; unknown = nothing could be read).
class HaCommandError extends Error {
  constructor (message: string, readonly say: string) {
    super(message)
  }
}

// Nothing was observed of a command that was sent but not answered in time (or whose read-back timed out).
const HA_NOT_ANSWERED = 'Home Assistant не ответил вовремя, результат команды не проверен.'

function isTimeout (error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError'
}

// A body read cut off by the fetch timeout rejects with AbortError, not TimeoutError; only used where no one else aborts.
function isTimeoutOrBodyAbort (error: unknown): boolean {
  return isTimeout(error) || (error instanceof Error && error.name === 'AbortError')
}

// A service call that did not get an answer in time (haFetch gives up): nothing was observed. Only the call itself is judged so:
// a read that timed out before any command was sent keeps the generic failure text.
async function haServiceFetch (config: { token: string, url: string }, path: string, body: unknown): Promise<Response> {
  try {
    return await haFetch(config, path, body)
  } catch (error) {
    if (isTimeout(error)) throw new HaCommandError(`HA ${path} timed out`, HA_NOT_ANSWERED)
    throw error
  }
}

// The layer's own read-back AFTER a command was sent and ha-cli did not confirm it (an older ha-cli, no X-Aisis-Verify: ok): a
// read that times out here leaves the command's outcome unknown, so it is not the generic failure of a read before any command.
async function readBackAfterCommand (readBack: () => Promise<boolean>): Promise<boolean> {
  try {
    return await readBack()
  } catch (error) {
    if (isTimeoutOrBodyAbort(error)) throw new HaCommandError('read-back after the command timed out', HA_NOT_ANSWERED)
    throw error
  }
}

// ha-cli read the device back after this call and it was in the state the call leads to (X-Aisis-Verify: ok).
function confirmedByHaCli (response: Response): boolean {
  return response.headers.get('x-aisis-verify') === 'ok'
}

function haFailure (response: Response, what: string): Error {
  const verify = response.headers.get('x-aisis-verify')
  const reason = response.headers.get('x-aisis-verify-reason')
  if (verify === 'failed') {
    return new HaCommandError(`${what} not confirmed: ${reason ?? 'no reason'}`, reason === 'device_unavailable'
      ? 'Home Assistant видит это устройство недоступным.'
      : 'Команду отправил, но не вижу, чтобы устройство её выполнило.')
  }
  if (verify === 'unknown') {
    return new HaCommandError(`${what} unverified: ${reason ?? 'no reason'}`, 'Не получилось проверить ответ Home Assistant.')
  }
  return new Error(`${what} -> ${response.status}`)
}

// What the current matchFastIntent call has executed and which phrase it answers: filled by executeResolved,
// read by the outermost matchFastIntent when it records the turn (turn-memory.ts). Per call, not module state,
// because a text turn from the dashboard or an agent can overlap a voice turn.
interface TurnTrace {
  executed: ActionRecord | null
  phrase: string
  skipRecording: boolean
  station: string // `stationKey` of the speaker whose turn this is: the open question and the turn memory are theirs alone
}
const turnTrace = new AsyncLocalStorage<TurnTrace>()

interface PendingClarification {
  declineToBrain: boolean // «нет» to a legacy «Ты про …?» reroutes the phrase to the brain; catalog questions just cancel
  expiresAt: number
  remember?: false // «да» to a repeat question must not teach the phrase «повтори» as a home command
  mode: 'confirm' | 'fill' | 'home-or-music'
  phrase: string
  resolved?: Resolved // confirm / home-or-music: what «да» executes
  fill?: (answer: Utterance) => null | Resolved // fill: the follow-up completes the command
}

// Pure scoring output — exported for the intent test harness.
export interface ScoredIntent {
  kind: 'command' | 'math' | 'state_query' | 'volume'
  score: number
  device?: DeviceIntent
  ambiguous?: boolean
  volume?: VolumeIntent
  lightsOnly?: boolean
}

const logger = getLogger()

// The dashboard's settings registry (voice control of every setting): fetched in the background from the start,
// so the first spoken setting is not lost to a cold cache. Never blocks a turn; empty until it loads.
void refreshSettings()

// ── Vocabulary ────────────────────────────────────────────────────────────────

const ROOMS: Room[] = [
  { area: 'Гостиная', declined: 'в гостиной', keywords: ['гостин'] },
  { area: 'Кухня', declined: 'на кухне', keywords: ['кухн'] },
  { area: 'Спальня', declined: 'в спальне', keywords: ['спальн'] },
  { area: 'Студия', declined: 'в студии', keywords: ['студи'] },
  { area: 'Прихожая', declined: 'в прихожей', keywords: ['прихож', 'коридор'] },
  { area: 'Второй этаж', declined: 'наверху', keywords: ['второй этаж', 'втором этаж', 'наверх'] }
]

// A phrase without a room means the room of the speaker that heard it (speaker-room.ts); this is only the answer
// for a station Home Assistant does not place in a known room (and for the corpus runner, which has no station).
const DEFAULT_AREA = 'Гостиная'
const ROOM_DEFAULT_SCORE = 0.95
const FUZZY_ENTITY_SCORE = 0.8

const LIGHT_STEM = 'свет'

// Explicit entity catalog: stems cover Russian word forms (света/глобуса/...).
interface EntityRule {
  stems: string[]
  label: string
  targets: (reg: HaRegistry) => string[]
  ambiguous?: boolean
}

const ENTITY_RULES: EntityRule[] = [
  { stems: ['люстр'], label: 'люстру', targets: () => ['light.liustra'] },
  { stems: ['глобус'], label: 'глобус', ambiguous: true,
    targets: reg => ['on', 'off'].includes(reg.entities.get('light.gostinaia_globus_socket_1')?.state ?? '')
      ? ['light.gostinaia_globus_socket_1'] : ['switch.globus3'] },
  { stems: ['гирлянд'], label: 'гирлянду', targets: () => ['light.girlianda'] },
  { stems: ['чайник', 'розетк'], label: 'чайник', targets: () => ['switch.kettle_plug_local'] },
  { stems: ['телевизор', 'телек'], label: 'телевизор', targets: () => ['media_player.televizor'] },
  { stems: ['проектор'], label: 'проектор', targets: () => ['media_player.projector'] }
]

const STATE_REPORT: { entity: string, label: string }[] = [
  { entity: 'switch.kettle_plug_local', label: 'чайник' },
  { entity: 'switch.globus3', label: 'глобус' },
  { entity: 'climate.kondei_1', label: 'кондиционер в гостиной' },
  { entity: 'climate.kondei_2', label: 'кондиционер наверху' },
  { entity: 'media_player.televizor', label: 'телевизор' },
  { entity: 'media_player.gostinaia', label: 'музыка в гостиной' }
]

// Overridable so tests can point it at a scratch file.
const AMBIGUITY_FILE = process.env.AISIS_HA_AMBIGUITY_FILE ?? '/src/ha.ambiguity.json'
const AMBIGUITY_TTL_MS = 90_000

const EXECUTE_THRESHOLD = 0.9
const CLARIFY_THRESHOLD = 0.5

// ── Math ─────────────────────────────────────────────────────────────────────

// Longest-first so «умножить на» wins over «умножить».
const WORD_OPS: { re: RegExp, symbol: string }[] = [
  { re: /умножить на|умножь на|умножить|умножь|умножения/g, symbol: '*' },
  { re: /разделить на|поделить на|делить на|разделить|поделить|разделить/g, symbol: '/' },
  { re: /плюс/g, symbol: '+' },
  { re: /минус/g, symbol: '-' },
  // «7 на 7» = multiplication; must stay LAST so «умножить/разделить на» wins.
  { re: / на /g, symbol: '*' }
]

// Turns «сколько будет …» / «посчитай …» into a bare arithmetic expression.
const MATH_QUESTION_RE = /^(сколько будет|скольким будет|сколько это|посчитай|чему равно|чему равняется|вычисли)\s+/

// 1.0 exact/stem-prefix, 0.8 close typo (edit distance <= 2), else 0.
function tokenSimilarity (token: string, stem: string): number {
  if (token === stem || token.startsWith(stem) || stem.startsWith(token) && token.length >= 4) return 1
  if (token.length >= 5 && stem.length >= 5 && editDistance(token, stem) <= 2) return FUZZY_ENTITY_SCORE
  return 0
}

// Tokenize → two-phase precedence (× ÷ before + −) → no eval(), ported from the
// fin-bot calculator pattern. Returns null when the text is not pure arithmetic.
export function evaluateMath (text: string): null | number {
  let expression = normalize(text)
    .replace(MATH_QUESTION_RE, '')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
  // ASR finals end with a sentence period («3 плюс 6.»); that dot is not a
  // decimal point and must not disqualify the whole expression.
  expression = expression.replace(/[.\s]+$/, '')
  for (const { re, symbol } of WORD_OPS) {
    expression = expression.replace(re, ` ${symbol} `)
  }
  expression = expression.replace(/,/g, '.')
  // Space-pad symbols so glued input («2+2») tokenizes; the tokenizer below
  // rejects anything that is not a number, numeral word or operator.
  expression = expression.replace(/([+\-*/])/g, ' $1 ').replace(/\s+/g, ' ').trim()
  if (!expression.includes('+') && !expression.includes('-') && !expression.includes('*') && !expression.includes('/')) {
    return null
  }

  const tokens: (number | string)[] = []
  const parts = expression.split(' ').filter(part => part !== '')
  for (let index = 0; index < parts.length;) {
    const part = parts[index]
    if (/^[+\-*/]$/.test(part)) {
      if (tokens.length === 0 || typeof tokens.at(-1) === 'string') return null // operator at start / double operator
      tokens.push(part)
      index++
      continue
    }
    if (/^\d+(?:\.\d+)?$/.test(part)) {
      tokens.push(Number(part))
      index++
      continue
    }
    // Russian numeral run inside arithmetic («двадцать пять плюс десять»):
    // consume consecutive numeral words as one composed number.
    if (part in NUMBER_WORDS) {
      const run: string[] = []
      while (index < parts.length && parts[index] in NUMBER_WORDS) {
        run.push(parts[index])
        index++
      }
      tokens.push(composeNumeral(run, 0).value)
      continue
    }
    return null
  }
  // Strictly alternating number/operator/number structure.
  if (tokens.length < 3 || typeof tokens.at(-1) === 'string') return null
  for (const [index, token] of tokens.entries()) {
    const expectNumber = index % 2 === 0
    if (expectNumber === (typeof token === 'string')) return null
  }

  // Phase 1: multiplicative operators.
  const values: number[] = []
  const operators: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (typeof token === 'number') {
      values.push(token)
    } else if (token === '*' || token === '/') {
      const left = values.pop()
      const right = tokens[index + 1]
      if (left === undefined || typeof right !== 'number') return null
      if (token === '/' && right === 0) return Number.NaN // division by zero
      values.push(token === '*' ? left * right : left / right)
      index++
    } else {
      operators.push(token)
    }
  }
  // Phase 2: additive operators, left to right.
  let result = values[0]
  for (let index = 0; index < operators.length; index++) {
    const right = values[index + 1]
    if (right === undefined) return null
    result = operators[index] === '+' ? result + right : result - right
  }
  return result
}

// Instant math speaks ONE short word («Девять»), never a chatty sentence.
const ONES_SPELLED = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь',
  'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать',
  'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать']
const TENS_SPELLED = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят',
  'семьдесят', 'восемьдесят', 'девяносто']
const HUNDREDS_SPELLED = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот',
  'семьсот', 'восемьсот', 'девятьсот']

function spellBelowThousand (value: number): string {
  const words: string[] = []
  const hundreds = Math.floor(value / 100)
  const rest = value % 100
  if (hundreds > 0) words.push(HUNDREDS_SPELLED[hundreds])
  if (rest >= 20) {
    words.push(TENS_SPELLED[Math.floor(rest / 10)])
    const ones = rest % 10
    if (ones > 0) words.push(ONES_SPELLED[ones])
  } else if (rest > 0 || words.length === 0) {
    words.push(ONES_SPELLED[rest])
  }
  return words.join(' ')
}

function formatMath (value: number): string {
  const rounded = Math.round(value * 1e10) / 1e10
  // Small integers become words («Девять»); anything else stays numeric.
  if (Number.isInteger(rounded) && Math.abs(rounded) < 1000) {
    const text = rounded < 0 ? `минус ${spellBelowThousand(-rounded)}` : spellBelowThousand(rounded)
    return text[0].toUpperCase() + text.slice(1)
  }
  return String(rounded)
}

// ── Home Assistant client ────────────────────────────────────────────────────

// Real tab/newline separators: HA does not render backslash escapes in templates.
const AREA_TEMPLATE = '{% for e in states %}{% set d = device_id(e.entity_id) %}' +
  '{% if d %}{{ e.entity_id }}\t{{ e.attributes.friendly_name }}\t{{ area_name(d) }}\n{% endif %}{% endfor %}'

const JUNK_LIGHT = /(k1se|snapmaker|cavity)/i

let haConfig: null | { token: string, url: string } = null
let configLoaded = false
let registry: HaRegistry | null = null
// One open question per station: a «да» answers the question the speaker that says it was asked, never another speaker's. The map
// is bounded (turn-memory.ts): station ids come from connections.
const pendingClarifications = new Map<string, PendingClarification>()
let ambiguityMemory: null | Record<string, 'home' | 'llm'> = null

const REGISTRY_TTL_MS = 60_000
const FETCH_TIMEOUT_MS = 3000

const REPROMPT_TEXT = 'Повтори?'
const REPROMPT_LOOP_MS = 60_000
// «ничего», «хватит», «спасибо»: the dialog ends, nothing is said, nothing is played.
const DIALOG_END: FastIntentResult = { kind: 'reply', quasarDirectives: [], text: null }
const lastReprompts = new Map<string, number>()

// The station whose turn is running (matchFastIntent puts it into the turn's trace); '' outside a turn.
function currentStation (): string {
  return turnTrace.getStore()?.station ?? ''
}

function getPending (): PendingClarification | null {
  return pendingClarifications.get(currentStation()) ?? null
}

function setPending (pending: PendingClarification | null): void {
  if (pending === null) pendingClarifications.delete(currentStation())
  else rememberFor(pendingClarifications, currentStation(), pending)
}

function getConfig (): null | { token: string, url: string } {
  if (process.env.AISIS_HA_URL && process.env.AISIS_HA_TOKEN) {
    return { token: process.env.AISIS_HA_TOKEN, url: process.env.AISIS_HA_URL }
  }
  if (!configLoaded) {
    configLoaded = true
    try {
      const parsed = JSON.parse(readFileSync('/src/ha.config.json', 'utf8')) as {
        token?: string, url?: string
      }
      haConfig = parsed.token && parsed.url ? { token: parsed.token, url: parsed.url } : null
    } catch {
      haConfig = null
    }
    logger.info(haConfig ? 'Home Assistant fast intents enabled' : 'Home Assistant fast intents disabled (no config)')
  }
  return haConfig
}

function loadAmbiguityMemory (): Record<string, 'home' | 'llm'> {
  if (ambiguityMemory === null) {
    try {
      ambiguityMemory = JSON.parse(readFileSync(AMBIGUITY_FILE, 'utf8')) as Record<string, 'home' | 'llm'>
    } catch {
      ambiguityMemory = {}
    }
  }
  return ambiguityMemory
}

function rememberAmbiguity (phrase: string, resolution: 'home' | 'llm'): void {
  const memory = loadAmbiguityMemory()
  memory[phrase] = resolution
  try {
    writeFileSync(AMBIGUITY_FILE, `${JSON.stringify(memory, null, 2)}\n`)
  } catch (error) {
    logger.error(`Failed to persist ambiguity memory: ${String(error)}`)
  }
}

async function haFetch (config: { token: string, url: string }, path: string, body?: unknown): Promise<Response> {
  return fetch(`${config.url}${path}`, {
    headers: {
      authorization: `Bearer ${config.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
}

async function getRegistry (config: { token: string, url: string }, forceRefresh = false): Promise<HaRegistry> {
  if (!forceRefresh && registry !== null && Date.now() - registry.fetchedAt < REGISTRY_TTL_MS) {
    return registry
  }
  const [statesResponse, areasResponse] = await Promise.all([
    haFetch(config, '/api/states'),
    haFetch(config, '/api/template', { template: AREA_TEMPLATE })
  ])
  if (!statesResponse.ok || !areasResponse.ok) {
    throw new Error(`HA registry fetch failed: ${statesResponse.status}/${areasResponse.status}`)
  }
  const entities = new Map<string, HaEntity>()
  for (const entity of await statesResponse.json() as HaEntity[]) {
    entities.set(entity.entity_id, entity)
  }
  const areaByEntity = new Map<string, string>()
  for (const line of (await areasResponse.text()).split('\n')) {
    const [entityId, , area] = line.split('\t')
    if (entityId && area && area !== 'None') {
      areaByEntity.set(entityId, area)
    }
  }
  // ha-cli serves its local cache while HA restarts (X-Aisis-Cache header).
  registry = { areaByEntity, entities, fetchedAt: Date.now(),
    stale: statesResponse.headers.get('x-aisis-cache') === 'stale' }
  return registry
}

function entityArea (reg: HaRegistry, entityId: string): string | undefined {
  const area = reg.areaByEntity.get(entityId)
  if (area) return area
  // Fallback for entities without a device: match friendly names («Кухня»).
  const name = reg.entities.get(entityId)?.attributes.friendly_name?.toLowerCase() ?? ''
  return ROOMS.find(item => item.keywords.some(keyword => name.includes(keyword)))?.area
}

function lightLabel (areas: string[]): string {
  const declined = ROOMS.filter(room => areas.includes(room.area)).map(room => room.declined)
  return declined.length === 0 ? 'свет' : `свет ${declined.join(' и ')}`
}

function roomLights (reg: HaRegistry, areas: string[]): string[] {
  return [...reg.entities.keys()]
    .filter(entityId => entityId.startsWith('light.') && !JUNK_LIGHT.test(entityId))
    .filter(entityId => {
      const state = reg.entities.get(entityId)?.state
      return state !== undefined && state !== 'unavailable' && state !== 'unknown'
    })
    .filter(entityId => areas.includes(entityArea(reg, entityId) ?? ''))
}

function mentionedRoomAreas (s: string): string[] {
  return ROOMS.filter(item => item.keywords.some(keyword => s.includes(keyword))).map(item => item.area)
}

async function callService (config: { token: string, url: string }, entityId: string,
  turnOn: boolean): Promise<boolean> {
  const domain = entityId.split('.')[0]
  let path = `/api/services/${domain}/${turnOn ? 'turn_on' : 'turn_off'}`
  let body: Record<string, unknown> = { entity_id: entityId }
  if (domain === 'climate') {
    // turn_on is a no-op on these IR ACs; an explicit mode actually starts them.
    path = '/api/services/climate/set_hvac_mode'
    body = { entity_id: entityId, hvac_mode: turnOn ? 'cool' : 'off' }
  }
  const response = await haServiceFetch(config, path, body)
  if (response.status === 202) throw restartingError(response)
  if (!response.ok) throw haFailure(response, `HA ${path} ${entityId}`)
  return confirmedByHaCli(response)
}

async function callWholeDomain (config: { token: string, url: string },
  wholeDomain: 'light', turnOn: boolean): Promise<boolean> {
  // Domain-wide HA calls require entity_id "all".
  const response = await haServiceFetch(config,
    `/api/services/${wholeDomain}/${turnOn ? 'turn_on' : 'turn_off'}`, { entity_id: 'all' })
  if (response.status === 202) throw restartingError(response)
  if (!response.ok) throw haFailure(response, `HA ${wholeDomain}/${turnOn ? 'turn_on' : 'turn_off'}`)
  return confirmedByHaCli(response)
}

async function currentState (config: { token: string, url: string }, entityId: string): Promise<string | undefined> {
  const response = await haFetch(config, `/api/states/${entityId}`)
  // Stale (cached) state must not drive "already on" dedupe answers.
  if (!response.ok || response.headers.get('x-aisis-cache') === 'stale') return undefined
  return (await response.json() as HaEntity).state
}

async function currentEntity (config: { token: string, url: string }, entityId: string): Promise<HaEntity | undefined> {
  const response = await haFetch(config, `/api/states/${entityId}`)
  if (!response.ok || response.headers.get('x-aisis-cache') === 'stale') return undefined
  return await response.json() as HaEntity
}

// «яркость 50» / «кондиционер на 24»: absolute set-points, not on/off.
async function callSetService (config: { token: string, url: string }, entityId: string, device: DeviceIntent): Promise<boolean> {
  const domain = entityId.split('.')[0]
  let path = '/api/services/light/turn_on'
  let body: Record<string, unknown> = { entity_id: entityId, brightness_pct: device.brightnessPct }
  if (domain === 'climate') {
    path = '/api/services/climate/set_temperature'
    body = { entity_id: entityId, temperature: device.temperature }
    // A powered-off IR AC ignores a set-point; an explicit mode starts it (as for «включи»).
    if ((await currentEntity(config, entityId))?.state === 'off') body.hvac_mode = 'cool'
  }
  const response = await haServiceFetch(config, path, body)
  if (response.status === 202) throw restartingError(response)
  if (!response.ok) throw haFailure(response, `HA ${path} ${entityId}`)
  return confirmedByHaCli(response)
}

function setSatisfied (entity: HaEntity | undefined, device: DeviceIntent): boolean {
  if (entity === undefined) return false
  if (entity.entity_id.startsWith('climate.')) {
    return entity.state !== 'off' && Math.abs((entity.attributes.temperature ?? Number.NaN) - (device.temperature ?? Number.NaN)) < 0.3
  }
  const brightness = entity.attributes.brightness
  return entity.state === 'on' && typeof brightness === 'number' &&
    Math.abs(brightness / 2.55 - (device.brightnessPct ?? Number.NaN)) <= 6
}

async function verifySet (config: { token: string, url: string }, device: DeviceIntent): Promise<boolean> {
  for (let attempt = 0; attempt < 9; attempt++) {
    const entities = await Promise.all(device.targets.map(entityId => currentEntity(config, entityId)))
    if (entities.every(entity => setSatisfied(entity, device))) return true
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  return false
}

// Post-execution verification: Zigbee/IR devices settle for seconds, so poll.
// Returns true once every target reports the desired state.
async function verifyExecution (config: { token: string, url: string }, device: DeviceIntent): Promise<boolean> {
  if (device.kind === 'set') return await verifySet(config, device)
  const desired = device.kind === 'on' ? 'on' : 'off'
  for (let attempt = 0; attempt < 9; attempt++) {
    if (device.wholeDomain) {
      // «весь свет» covers area-less lights too (гирлянда): check them all.
      const reg = await getRegistry(config, true)
      const stillWrong = [...reg.entities.entries()]
        .filter(([entityId, entity]) => entityId.startsWith('light.') && !JUNK_LIGHT.test(entityId) &&
          entity.state !== 'unavailable' && entity.state !== 'unknown')
        .some(([, entity]) => entity.state !== desired)
      if (!stillWrong) return true
    } else {
      let allMatch = true
      for (const entityId of device.targets) {
        const state = await currentState(config, entityId)
        const domain = entityId.split('.')[0]
        const matches = domain === 'climate'
          ? (device.kind === 'on' ? state !== 'off' && state !== undefined : state === 'off')
          : state === desired
        if (!matches) {
          allMatch = false
          break
        }
      }
      if (allMatch) return true
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  return false
}

// ── Intent scoring ───────────────────────────────────────────────────────────

function matchVolume (s: string, tokens: string[]): VolumeIntent | null {
  if (/(какая|сколько|покажи|скажи).{0,12}громкость|громкость сейчас/.test(s)) {
    return { kind: 'query' }
  }
  if (/максимальн[а-я]*\s+громкость|громкость.{0,12}максимум|громкость на полную/.test(s)) {
    return { kind: 'set', target: 1 }
  }
  if (/минимальн[а-я]*\s+громкость|громкость.{0,12}минимум/.test(s)) {
    return { kind: 'set', target: 0.1 }
  }
  if (s.includes('громкость')) {
    const digitIndex = tokens.findIndex(token => /^\d+$/.test(token))
    const wordIndex = tokens.findIndex(token => token in NUMBER_WORDS)
    const number = digitIndex >= 0
      ? Number(tokens[digitIndex])
      : wordIndex >= 0 ? composeNumeral(tokens, wordIndex).value : null
    // Two numbers («громкость 10 и яркость 50») or a value outside 1..100 is not a
    // volume command this layer may guess at: the catalog / brain decide.
    if (parseNumbers(tokens, false).length > 1 || number !== null && number > 100) return null
    if (number !== null && number > 0) {
      // «громкость на пять» = Alice 0..10 scale, «громкость 50» = percent.
      return { kind: 'set', target: number <= 10 ? number / 10 : number / 100 }
    }
    // «прибавь/убавь громкость» without a number. A bare «громкость» (or a typo of it)
    // is NOT a direction: the catalog asks what to do instead of guessing «тише».
    if (/прибав|добав|повыс|увелич|подним|больш/.test(s)) return { kind: 'set', steps: 1 }
    if (/убав|убер|уменьш|пониз|опуст|меньш/.test(s)) return { kind: 'set', steps: -1 }
    return null
  }
  const louder = /громче/.test(s) // substring: covers «погромче» too
  const quieter = /тише/.test(s) // \b does not work with Cyrillic — plain substring
  if (louder !== quieter) { // exactly one of them
    // One step is the configured volume step (speaker.volume_step_pct, 30% = three of ten levels by default): a plain «громче» must be heard, «намного» is two steps.
    const steps = /(значительн|сильн|гораздо|намного)/.test(s) ? 2 : 1
    return { kind: 'set', steps: louder ? steps : -steps }
  }
  return null
}

// Queries answer questions; they NEVER toggle anything (owner bug:
// «какой свет включен» used to fire гирлянда).
const QUERY_WORD_RE = /^(какой|какая|какие|что|чего|сколько|покажи|скажи|состояние|горит|включен[а-я]*|работает|ли)$/

function isStateQuery (s: string, tokens: string[]): boolean {
  const hasQueryWord = tokens.some(token => QUERY_WORD_RE.test(token))
  const hasStateWord = /(включен|горит|горят|работает|работают|состояни)/.test(s)
  return hasQueryWord && hasStateWord
}

function resolveCommand (s: string, tokens: string[], reg: HaRegistry, defaultArea: string): ScoredIntent | null {
  const commands = tokens.filter(token => !isNarrativeVerbForm(token))
  const on = commands.some(token => ON_VERBS.some(verb => token.startsWith(verb)))
  const off = commands.some(token => OFF_VERBS.some(verb => token.startsWith(verb)))
  if (!on && !off) return null
  const kind: 'on' | 'off' = on ? 'on' : 'off'

  // AC resolves by room: kondei_1 — Гостиная, kondei_2 — Второй этаж. Without a room in the phrase: the AC of the
  // speaker's own room, else the first one.
  if (/(кондиционер|кондей|конде|сплит)/.test(s)) {
    const usable = ['climate.kondei_1', 'climate.kondei_2'].filter(id => {
      const state = reg.entities.get(id)?.state
      return state !== undefined && state !== 'unavailable' && state !== 'unknown'
    })
    const areas = mentionedRoomAreas(s)
    const inSpeakerRoom = usable.filter(id => entityArea(reg, id) === defaultArea)
    const targets = areas.length > 0
      ? usable.filter(id => areas.includes(entityArea(reg, id) ?? ''))
      : inSpeakerRoom.length > 0 ? inSpeakerRoom : usable.slice(0, 1)
    if (targets.length > 0) {
      return { kind: 'command', score: 1, device: { kind, label: 'кондиционер', targets } }
    }
  }

  // Entity score: best over explicit rules + the generic «свет» concept.
  let best: { label: string, rule: EntityRule, score: number } | null = null
  for (const rule of ENTITY_RULES) {
    for (const stem of rule.stems) {
      for (const token of tokens) {
        const score = tokenSimilarity(token, stem)
        if (score > 0 && (best === null || score > best.score)) {
          best = { label: rule.label, rule, score }
        }
      }
    }
  }
  let label: string
  let targets: string[]
  let entityScore: number
  let ambiguous = false
  if (best !== null) {
    label = best.label
    entityScore = best.score
    targets = best.rule.targets(reg)
    ambiguous = best.rule.ambiguous === true && kind === 'on'
    if (best.rule.stems.includes('чайник') && s.includes('розетк')) label = 'розетку'
    if (targets.length === 0) return null // entity missing from HA -> let the LLM answer
  } else {
    const lightScore = Math.max(0,
      ...LIGHT_WORDS.map(word => Math.max(0, ...tokens.map(token => tokenSimilarity(token, word)))),
      ...tokens.map(token => tokenSimilarity(token, LIGHT_STEM)))
    if (lightScore === 0) return null
    entityScore = lightScore
    const wantsAll = ['все', 'весь', 'всё', 'всей', 'всех'].some(word => tokens.includes(word)) ||
      ['везде', 'всюду', 'квартире', 'квартиры'].some(word => s.includes(word))
    if (wantsAll) {
      label = 'весь свет'
      targets = []
      return { kind: 'command', score: 1 * entityScore * 1, device: { kind, label, targets, wholeDomain: 'light' } }
    }
    const areas = mentionedRoomAreas(s)
    const effectiveAreas = areas.length > 0 ? areas : [defaultArea]
    targets = roomLights(reg, effectiveAreas)
    if (targets.length === 0) return null
    label = lightLabel(effectiveAreas)
  }

  const roomScore = mentionedRoomAreas(s).length > 0 ? 1 : ROOM_DEFAULT_SCORE
  return {
    ambiguous,
    device: { kind, label, targets },
    kind: 'command',
    score: 1 * entityScore * roomScore
  }
}

export function scoreIntent (rawText: string, reg: HaRegistry, defaultArea: string = DEFAULT_AREA): null | ScoredIntent {
  const s = normalize(rawText)
  const tokens = tokenize(s) // sentence punctuation glued to a word («10.») must not hide the number
  if (s === '') return null

  // Reminders/timers with an embedded command («напомни выключить чайник»)
  // must never execute that command — route to the brain instead.
  if (/(напомни|напомните|разбуди|поставь таймер|установи таймер|поставь будильник|заведи будильник)/.test(s)) {
    return null
  }

  const math = evaluateMath(s)
  if (math !== null) {
    // NaN = division by zero: still math, answered with a spoken message.
    return { kind: 'math', score: 1 }
  }

  const volume = matchVolume(s, tokens)
  if (volume !== null) {
    return { kind: 'volume', score: 1, volume }
  }

  if (isStateQuery(s, tokens)) {
    return { kind: 'state_query', score: 1, lightsOnly: /горит|свет/.test(s) }
  }

  return resolveCommand(s, tokens, reg, defaultArea)
}

// ── Replies ──────────────────────────────────────────────────────────────────

function alreadyText (label: string, desired: 'on' | 'off'): string {
  const nominative = label.endsWith('у') ? `${label.slice(0, -1)}а` : label
  const feminine = nominative.endsWith('а') || nominative.endsWith('я')
  const participle = desired === 'on' ? (feminine ? 'включена' : 'включен') : (feminine ? 'выключена' : 'выключен')
  const subject = nominative[0].toUpperCase() + nominative.slice(1)
  return `${subject} уже ${participle}.`
}

function buildStateReport (reg: HaRegistry, lightsOnly: boolean): string {
  const on: string[] = []
  for (const [entityId, entity] of reg.entities) {
    if (!entityId.startsWith('light.') || JUNK_LIGHT.test(entityId)) continue
    if (entity.state !== 'on') continue
    const area = entityArea(reg, entityId)?.toLowerCase()
    const name = entity.attributes.friendly_name?.toLowerCase() ?? entityId
    on.push(area && !name.includes(area.slice(0, 5)) ? `${name} в ${area}` : name)
  }
  if (!lightsOnly) {
    for (const item of STATE_REPORT) {
      const entity = reg.entities.get(item.entity)
      if (!entity || entity.state === 'unavailable' || entity.state === 'unknown') continue
      if (item.entity.startsWith('switch.') && entity.state === 'on') {
        on.push(item.label)
      } else if (item.entity.startsWith('climate.') && entity.state !== 'off') {
        on.push(item.label)
      } else if (item.entity.startsWith('media_player.') && entity.state === 'playing') {
        on.push(item.label)
      }
    }
  }
  if (on.length === 0) {
    return reg.stale === true ? 'По последним данным, сейчас ничего не включено.' : 'Сейчас ничего не включено.'
  }
  const list = `Сейчас включено: ${on.join(', ')}.`
  return reg.stale === true ? `По последним данным, ${list[0].toLowerCase()}${list.slice(1)}` : list
}

// Stock Alice confirms an executed IoT/volume command with a short chime instead
// of speech (firmware sound AliceIoTSoundsTurnOn/TurnOff via local_audio_file_play,
// the same directive the brain's play_iot_sound function sends). It is NOT the
// tts_play_placeholder waiting jingle: that one stays reserved for turns that speak.
const EARCON_ENABLED = process.env.AISIS_FAST_EARCON !== 'off'

function earconDirectives (sound: 'off' | 'on'): proto.NAlice.NAliceApi.ITDirective[] {
  if (!EARCON_ENABLED) return []
  return [{
    IsLedSilent: true,
    Name: 'local_audio_file_play',
    Payload: encodeProtobufStruct({
      play_times: 1,
      sound_to_play: sound === 'on' ? 'AliceIoTSoundsTurnOn' : 'AliceIoTSoundsTurnOff'
    }),
    Type: 'client_action'
  }]
}

// Media keys. The speaker's own AirPlay playback goes through the adapter; when nothing of ours
// plays, a Home Assistant player that is playing (TV, living-room music) gets the key instead.
const HA_MEDIA_PLAYERS = ['media_player.televizor', 'media_player.gostinaia']
const HA_MEDIA_SERVICES: Record<MediaAction, string> = {
  next: 'media_next_track', pause: 'media_pause', previous: 'media_previous_track', resume: 'media_play', stop: 'media_stop'
}

async function controlHaMedia (config: { token: string, url: string }, action: MediaAction): Promise<boolean> {
  const reg = await getRegistry(config, true)
  const wanted = action === 'resume' ? 'paused' : 'playing'
  const target = HA_MEDIA_PLAYERS.find(entityId => reg.entities.get(entityId)?.state === wanted)
  if (target === undefined) return false
  const response = await haFetch(config, `/api/services/media_player/${HA_MEDIA_SERVICES[action]}`, { entity_id: target })
  return response.ok
}

// null: not a media key for anything that is playing; the caller carries on with the phrase.
// Success is an earcon; stop/pause with nothing playing stays silent (stock firmware answers its
// own player, and a spoken «поставила на паузу» over nothing is exactly the chatter to avoid). The
// silent reply keeps the `clear_queue` directive the TextInput «стоп»/«пауза» spotter turn always got.
async function runMediaControl (config: { token: string, url: string }, action: MediaAction): Promise<FastIntentResult | null> {
  const silent: FastIntentResult = {
    kind: 'reply',
    quasarDirectives: [{ IsLedSilent: true, Name: 'clear_queue', Payload: encodeProtobufStruct({}), Type: 'client_action' }],
    text: null
  }
  const done: FastIntentResult = {
    kind: 'reply', quasarDirectives: earconDirectives(action === 'stop' || action === 'pause' ? 'off' : 'on'), text: null
  }
  const outcome = await tryMediaControl(action)
  if (outcome === 'done') return done
  if (outcome === 'unsupported') return { kind: 'reply', quasarDirectives: [], text: 'Это играет с телефона, управляй с него.' }
  if (outcome === 'failed') return { kind: 'reply', quasarDirectives: [], text: 'Не получилось.' }
  if (await controlHaMedia(config, action)) return done
  return action === 'stop' || action === 'pause' ? silent : null
}

// Executes a device intent against HA, then VERIFIES the resulting state.
// Success is an earcon, never speech; failures are always spoken.
async function executeDeviceIntent (config: { token: string, url: string }, device: DeviceIntent): Promise<FastIntentResult> {
  const desired = device.kind === 'on' ? 'on' : 'off'

  // Single target already in the desired state -> no call, spoken answer.
  // Fresh per-entity GET: the registry is cached for 60s.
  if (device.kind !== 'set' && device.targets.length === 1 && !device.wholeDomain) {
    if (await currentState(config, device.targets[0]) === desired) {
      return { kind: 'reply', quasarDirectives: [], text: alreadyText(device.label, desired) }
    }
  }

  const turnOn = device.kind !== 'off'
  let confirmed: boolean[]
  if (device.kind === 'set') {
    confirmed = await Promise.all(device.targets.map(entityId => callSetService(config, entityId, device)))
  } else if (device.wholeDomain) {
    confirmed = [await callWholeDomain(config, device.wholeDomain, turnOn)]
  } else {
    confirmed = await Promise.all(device.targets.map(entityId => callService(config, entityId, turnOn)))
  }

  // ha-cli already read every device back (X-Aisis-Verify: ok on each call): a second look from here would only add the stale
  // cached reads of a Home Assistant that went away in between, and report a failure nobody observed.
  if (confirmed.every(Boolean) || await readBackAfterCommand(() => verifyExecution(config, device))) {
    logger.info(`Fast intent executed: ${device.kind} [${device.targets.join(', ') || device.wholeDomain}]`)
    return { kind: 'reply', quasarDirectives: earconDirectives(turnOn ? 'on' : 'off'), text: null }
  }
  logger.warn(`Fast intent VERIFY FAILED: ${device.kind} [${device.targets.join(', ') || device.wholeDomain}]`)
  return {
    kind: 'reply',
    quasarDirectives: [],
    text: device.kind === 'set' ? `Не получилось поставить ${device.label}.` : `Не получилось ${turnOn ? 'включить' : 'выключить'} ${device.label}.`
  }
}

// Speaker volume scale: what sound_set_level takes (and the LED draws ×10).
const MAX_LEVEL = 10

// Level the speaker itself reports in the request's DeviceState (null: the request carried none).
export function speakerLevelOf (deviceState: { SoundLevel?: number | null } | null | undefined): null | number {
  const level = deviceState?.SoundLevel
  return typeof level === 'number' ? level : null
}

function setLevelDirective (level: number): proto.NAlice.NAliceApi.ITDirective {
  return {
    IsLedSilent: true,
    Name: 'sound_set_level',
    Payload: encodeProtobufStruct({ new_level: level, new_percent_level: level * 10 }),
    Type: 'client_action'
  }
}

// Volume acts ONLY on the speaker, as client directives (never an HA call: the HA media_player is often
// unavailable, and a guessed base made «громче» always 7 and «тише» always 3).
// Absolute asks: sound_set_level (level 1..10, same payload as the brain's set_sound_volume).
// Relative asks step from the level the speaker reports in the request, clamped to 1..10: «тише» never mutes
// the station (a silent speaker drops the confirmation earcon too), «громче» at the top changes nothing, quietly.
// `steps` is a signed multiple of the configured step (speaker.volume_step_pct, read live by executeResolved):
// «громче» is +1 step, «намного тише» -2. Without a reported level the stock relative directives do the
// stepping, repeated once per level (stepPct 30 = three of them, never fewer than one).
function volumeDirectives (volume: VolumeIntent, speakerLevel: null | number, stepPct: number): proto.NAlice.NAliceApi.ITDirective[] {
  if (volume.target !== undefined) return [setLevelDirective(Math.min(MAX_LEVEL, Math.max(1, Math.round(volume.target * MAX_LEVEL))))]
  const levels = volumeLevels(volume.steps ?? 0, stepPct)
  if (speakerLevel === null) {
    const name = levels < 0 ? 'sound_quiter' : 'sound_louder'
    return Array.from({ length: Math.abs(levels) }, () => ({ IsLedSilent: true, Name: name, Payload: {}, Type: 'client_action' }))
  }
  return [setLevelDirective(Math.min(MAX_LEVEL, Math.max(Math.min(1, speakerLevel), speakerLevel + levels)))]
}

// Confirmation is the earcon, played at the new level.
function volumeResult (volume: VolumeIntent, speakerLevel: null | number, stepPct: number): FastIntentResult {
  const directives = volumeDirectives(volume, speakerLevel, stepPct)
  logger.info(`Fast intent volume: speaker ${speakerLevel ?? 'unknown'}, ${volume.target !== undefined ? `target ${volume.target}` : `steps ${volume.steps ?? 0} × ${stepPct}%`} -> ${directives.map(directive => directive.Name).join('+') || 'no change'}`)
  return { kind: 'reply', quasarDirectives: [...directives, ...earconDirectives('on')], text: null }
}

// A dashboard setting by voice. A change that needs the owner's «да» (the registry's `confirm` risk, or a value
// the voice layer had to correct) asks first; the dashboard refuses an unconfirmed voice change as well.
async function executeSetting (setting: Extract<Resolved, { type: 'setting' }>): Promise<FastIntentResult> {
  if (setting.ask !== undefined && setting.confirmed !== true) {
    setPending({ declineToBrain: false, expiresAt: Date.now() + AMBIGUITY_TTL_MS, mode: 'confirm', phrase: setting.id,
      remember: false, resolved: setting })
    return { kind: 'reply', listen: true, quasarDirectives: [], text: setting.ask }
  }
  const result = await postValue(setting.id, setting.value, { confirmed: setting.confirmed === true })
  const entry = findSetting(setting.id)
  if (!result.ok) {
    logger.warn(`Fast intent setting ${setting.id} refused: ${result.err}`)
    return { kind: 'reply', quasarDirectives: [], text: failureText(entry, result.err) }
  }
  logger.info(`Fast intent setting ${setting.id} changed`)
  // The earcon says «done» unless the change is not otherwise perceivable (a chosen option, an action).
  const done = entry === undefined ? null : doneText(entry, result.value ?? setting.value)
  return { kind: 'reply', quasarDirectives: done === null ? earconDirectives(setting.value === false ? 'off' : 'on') : [], text: done }
}

// «какой шаг громкости»: read live from the dashboard, never from the cache alone; a secret is never read out.
async function answerSettingQuery (id: string): Promise<FastIntentResult> {
  const entry = findSetting(id)
  if (entry === undefined) return { kind: 'reply', quasarDirectives: [], text: 'Такой настройки нет.' }
  const live = await getValue(id)
  return { kind: 'reply', quasarDirectives: [], text: queryAnswer(entry, live.ok ? live.value : entry.value) }
}

async function executeResolved (config: { token: string, url: string }, resolved: Resolved, speakerLevel: null | number): Promise<FastIntentResult> {
  const trace = turnTrace.getStore()
  if (trace !== undefined) trace.executed = { phrase: trace.phrase, resolved: resolved.type === 'setting' ? { ...resolved, confirmed: false } : resolved }
  // The step is read only for a relative ask: live from the dashboard, else the cached value, else 30%.
  if (resolved.type === 'volume') return volumeResult(resolved.volume, speakerLevel, resolved.volume.steps === undefined ? DEFAULT_VOLUME_STEP_PCT : await volumeStepPct())
  if (resolved.type === 'setting') return await executeSetting(resolved)
  if (resolved.type === 'setting-query') return await answerSettingQuery(resolved.id)
  if (resolved.type === 'brain') {
    // A confirmed fuzzy «следущий трек» is still a media key, not a question for the brain.
    const mediaKey = parseMediaControl(resolved.text)
    const handled = mediaKey === null ? null : await runMediaControl(config, mediaKey)
    return handled ?? { kind: 'llm', text: resolved.text }
  }
  if (resolved.type === 'say') return { kind: 'reply', quasarDirectives: [], text: resolved.text }
  return await executeDeviceIntent(config, resolved.device)
}

const YES_WORDS = ['да', 'конечно', 'точно', 'правильно', 'угу', 'ага', 'верно', 'давай', 'ок', 'окей', 'валяй', 'делай', 'именно']
const NO_WORDS = ['нет', 'не', 'неа', 'другое', 'отмена', 'отмени', 'стоп']

// What the owner's answer picks. A choice word under a negator («не свет, а музыку») is not the choice, and a yes word beside a
// negation or a «нет» («не делай», «не давай», «нет, давай») is not a «да»: the question stays unanswered, never run on a misread.
function resolveClarification (tokens: string[]): 'home' | 'llm' | 'yes' | 'no' | null {
  const picked = (isChoice: (token: string) => boolean): boolean => tokens.some((token, index) => isChoice(token) && !isNegatedAt(tokens, index))
  if (picked(token => ['свет', 'света', 'свету', 'лампа', 'лампу'].includes(token))) return 'home'
  if (picked(token => token.startsWith('музык'))) return 'llm'
  const refused = hasNegation(tokens) || tokens.some(token => NO_WORDS.includes(token))
  if (!refused && tokens.some(token => YES_WORDS.includes(token))) return 'yes'
  return refused ? 'no' : null
}

// ── Decision: exact layer → catalog → LLM ────────────────────────────────────

function isUsable (reg: HaRegistry, entityId: string): boolean {
  const state = reg.entities.get(entityId)?.state
  return state !== undefined && state !== 'unavailable' && state !== 'unknown'
}

// The catalog sees the home only through this view, generated from the live
// registry: rooms, entity concepts that actually exist, light groups, the AC range.
function buildWorld (reg: HaRegistry, defaultArea: string): World {
  const acIds = ['climate.kondei_1', 'climate.kondei_2'].filter(id => isUsable(reg, id))
  const acInSpeakerRoom = acIds.filter(id => entityArea(reg, id) === defaultArea)
  const acTargets = (areas: string[]): string[] => areas.length > 0
    ? acIds.filter(id => areas.includes(entityArea(reg, id) ?? ''))
    : acInSpeakerRoom.length > 0 ? acInSpeakerRoom : acIds.slice(0, 1)
  const acAttrs = acIds.length > 0 ? reg.entities.get(acIds[0])?.attributes : undefined
  return {
    acLabel: areas => {
      const declined = ROOMS.filter(room => areas.includes(room.area)).map(room => room.declined)
      return declined.length === 0 ? 'кондиционер' : `кондиционер ${declined.join(' и ')}`
    },
    acRange: [acAttrs?.min_temp ?? 16, acAttrs?.max_temp ?? 30],
    acTargets,
    concepts: ENTITY_RULES.map(rule => ({
      id: rule.stems[0],
      label: rule.label,
      stems: rule.stems,
      targets: rule.targets(reg).filter(id => reg.entities.has(id))
    })),
    defaultArea,
    lightLabel,
    lights: areas => areas === 'all'
      ? [...reg.entities.keys()].filter(id => id.startsWith('light.') && !JUNK_LIGHT.test(id) && isUsable(reg, id))
      : roomLights(reg, areas),
    rooms: ROOMS,
    settings: getSettings()
  }
}

export type FastDecision =
  | { tier: 'llm' }
  | { tier: 'math' }
  | { tier: 'answer', text: string } // spoken read-only answer about an entity
  | { tier: 'query', query: 'state' | 'volume', lightsOnly?: boolean }
  | { tier: 'execute', resolved: Resolved, via: 'catalog' | 'exact', trace?: string }
  | { tier: 'confirm', resolved: Resolved, question: string, via: 'catalog' | 'exact', declineToBrain: boolean, score?: number, trace?: string }
  | { tier: 'clarify', question: string, via: 'catalog' | 'exact', mode: 'fill' | 'home-or-music',
      resolved?: Resolved, fill?: (answer: Utterance) => null | Resolved, score?: number, trace?: string }
  // Command-like but nothing probable (see intent-catalog.ts): «Повтори?», no list.
  | { tier: 'reprompt', reason: string, trace?: string }

// Single decision point shared by matchFastIntent and the corpus runner (so the
// corpus exercises the real routing, not a re-implementation of it). The ASR often
// appends chatter as a second sentence («Кромкость 10. Смотри, вот.»): a command in
// any one sentence counts, the other sentences must not dilute its score.
export function decideFastIntent (rawText: string, reg: HaRegistry, defaultArea: string = DEFAULT_AREA): FastDecision {
  const sentences = splitSentences(rawText)
  if (sentences.length > 1) {
    for (const sentence of sentences) {
      const decision = decideSentence(sentence, reg, defaultArea)
      if (decision.tier !== 'llm' && decision.tier !== 'math') return decision
    }
  }
  return decideSentence(rawText, reg, defaultArea)
}

// «зажги свет в», «включи кондиционер на»: the end was cut off, so what would execute is not what was said (the lost
// word was the room). Ask again rather than act on the part that survived.
function decideSentence (rawText: string, reg: HaRegistry, defaultArea: string): FastDecision {
  const decision = decideSentenceUncut(rawText, reg, defaultArea)
  const words = tokenize(normalize(rawText))
  if (hasNegation(words) && actsOnHome(decision)) return { tier: 'llm' }
  return decision.tier === 'execute' && endsMidPhrase(words) ? { reason: 'cut-off', tier: 'reprompt' } : decision
}

// «не включай чайник», «лучше не включай», «кондиционер не включай» forbid what the verb and the noun name, and the grammar reads only
// those two: left alone it runs the action. A negated phrase is therefore no match for everything that would act (run, confirm,
// ask to fill in or to repeat); answers, state and setting reads and entity questions only talk and stay.
function actsOnHome (decision: FastDecision): boolean {
  switch (decision.tier) {
    case 'execute': return decision.resolved.type !== 'setting-query'
    case 'confirm': return decision.resolved.type !== 'say'
    case 'clarify':
    case 'reprompt': return true
    default: return false
  }
}

function decideSentenceUncut (rawText: string, reg: HaRegistry, defaultArea: string): FastDecision {
  // «какой шаг громкости», «что с озвучкой»: the question words would defeat the catalog, so a dashboard setting
  // asked about is answered here (live value, read-only) before any command grammar sees the phrase.
  const asked = matchSettingQuery(normalize(rawText), getSettings())
  if (asked !== null) return { resolved: { id: asked.id, type: 'setting-query' }, tier: 'execute', trace: `setting-query ${asked.id}`, via: 'catalog' }
  const intent = scoreIntent(rawText, reg, defaultArea)
  if (intent !== null) {
    if (intent.kind === 'math') return { tier: 'math' }
    if (intent.kind === 'state_query') return { lightsOnly: intent.lightsOnly === true, query: 'state', tier: 'query' }
    if (intent.kind === 'volume' && intent.volume !== undefined) {
      return intent.volume.kind === 'query'
        ? { query: 'volume', tier: 'query' }
        : { resolved: { type: 'volume', volume: intent.volume }, tier: 'execute', via: 'exact' }
    }
    if (intent.device !== undefined) {
      if (intent.score >= EXECUTE_THRESHOLD && intent.ambiguous !== true) {
        // «включи свет 50»: a spoken value means a set-point, not a bare switch-on.
        if (parseNumbers(tokenize(normalize(rawText)), false).length > 0) {
          const withValue = catalogDecision(rawText, reg, defaultArea)
          if ((withValue.tier === 'execute' || withValue.tier === 'confirm') &&
            withValue.resolved.type === 'device' && withValue.resolved.device.kind === 'set') return withValue
        }
        return { resolved: { device: intent.device, type: 'device' }, tier: 'execute', via: 'exact' }
      }
      if (intent.ambiguous === true) {
        return { mode: 'home-or-music', question: 'Свет или музыку?', resolved: { device: intent.device, type: 'device' },
          score: intent.score, tier: 'clarify', via: 'exact' }
      }
      if (intent.score >= CLARIFY_THRESHOLD) {
        return { declineToBrain: true, question: `Ты про ${intent.device.label}?`, resolved: { device: intent.device, type: 'device' },
          score: intent.score, tier: 'confirm', via: 'exact' }
      }
    }
  }
  const catalog = catalogDecision(rawText, reg, defaultArea)
  if (catalog.tier !== 'llm') return catalog
  // Last local resort before the brain: read-only questions about named entities
  // («что со стрелицией», «какая температура на улице»). Never executes.
  const entity = matchEntityQuery(rawText, reg.entities, reg.areaByEntity)
  if (entity.kind === 'answer') return { text: entity.text, tier: 'answer' }
  if (entity.kind === 'confirm') {
    return { declineToBrain: true, question: entity.text, resolved: { text: entity.answerText ?? entity.text, type: 'say' },
      tier: 'confirm', via: 'catalog' }
  }
  if (entity.kind === 'reprompt') return { reason: 'entity-ties', tier: 'reprompt' }
  return catalog
}

function catalogDecision (rawText: string, reg: HaRegistry, defaultArea: string): FastDecision {
  const decision = decideCatalog(normalize(rawText), buildWorld(reg, defaultArea))
  if (decision.tier === 'execute') return { resolved: decision.resolved, tier: 'execute', trace: decision.trace, via: 'catalog' }
  if (decision.tier === 'confirm') {
    return { declineToBrain: false, question: decision.question, resolved: decision.resolved, tier: 'confirm', trace: decision.trace, via: 'catalog' }
  }
  if (decision.tier === 'clarify') {
    return { fill: decision.fill, mode: 'fill', question: decision.question, tier: 'clarify', trace: decision.trace, via: 'catalog' }
  }
  if (decision.tier === 'reprompt') return { reason: decision.reason, tier: 'reprompt', trace: decision.trace }
  return { tier: 'llm' }
}

// ── Entry point ──────────────────────────────────────────────────────────────

interface MatchOptions {
  // This turn continues a dialog the station is in (follow-up window opened by a question, or our own speech is
  // still playing): a terminator ends the dialog and leaves the music alone. Absent/false: a fresh turn.
  dialogActive?: boolean
  // Set on the re-run of an already corrected phrase: one repair per utterance.
  noCorrect?: boolean
  // The speaker's own volume (0..10) from the request's DeviceState: the base of «громче»/«тише» and the answer
  // to «какая громкость». Absent when the request carried no device state.
  speakerLevel?: null | number
  // Where the turn came from: a spoken one wins when «повтори» looks for the last turn (turn-memory.ts).
  origin?: TurnOrigin
  // The station that heard the turn (StationInfo.duid): a phrase without a room means the room Home Assistant puts it in.
  // Absent for callers that have no station (the corpus runner).
  deviceId?: string
}

// The room a phrase without one is about: the area Home Assistant gives the speaker that heard it, when that is one of the
// home's rooms; otherwise the legacy default (living room).
function roomOfSpeaker (reg: HaRegistry, deviceId: string | undefined): string {
  const area = speakerArea(reg.areaByEntity, deviceId)
  return area !== undefined && ROOMS.some(room => room.area === area) ? area : DEFAULT_AREA
}

// Repair of a short phrase the fast layer could not decide on (asr-correct.ts). The corrected text meets every
// confirm/clarify rule a spoken phrase would. High confidence («act»): it is routed as if the owner had said it.
// Middle band («confirm»): a device action is offered back («Включи свет», верно?») and only a «да» runs it, because
// a lost first syllable cannot tell «включи» from «выключи». Anything else stays as the fast layer decided.
async function correctionFor (text: string, tier: FastDecision['tier'], options: MatchOptions, reg: HaRegistry): Promise<FastIntentResult | null> {
  // A repair can only turn a negated phrase into its opposite («не включай» heard as «включай»): leave it alone.
  if (options.noCorrect === true || hasNegation(tokenize(normalize(text))) || !eligible(text, tier) || !allowCorrection()) return null
  const correction = await requestCorrection(text, currentStation())
  if (correction === null) return null
  const mode = shadowOnly() ? 'ignore' : correction.mode
  logger.info(describeCorrection(text, correction, mode))
  if (mode === 'ignore') return null
  if (mode === 'confirm') {
    const heard = decideFastIntent(correction.text, reg, roomOfSpeaker(reg, options.deviceId))
    const question = confirmationQuestion(correction.text)
    if (heard.tier !== 'execute' || question === null) return null
    setPending({ declineToBrain: false, expiresAt: Date.now() + AMBIGUITY_TTL_MS, mode: 'confirm',
      phrase: normalize(text), resolved: heard.resolved })
    return { kind: 'reply', listen: true, quasarDirectives: [], text: question }
  }
  const rerun = await matchFastIntent(correction.text, { ...options, noCorrect: true })
  if (rerun !== null) return rerun
  // Nothing local matched the repaired phrase either: the brain gets the repaired text, not the garbled one.
  return tier === 'llm' ? { kind: 'llm', text: correction.text } : null
}

// A repeated hazardous action (kettle, sockets) is asked about first; lights, climate, volume steps and media keys
// are idempotent or bounded and simply run again.
function repeatQuestion (resolved: Resolved): null | string {
  if (resolved.type !== 'device' || resolved.device.kind === 'off') return null
  if (resolved.device.wholeDomain !== undefined || resolved.device.targets.every(entityId => /^(light|climate)\./.test(entityId))) return null
  return `Повторить: ${resolved.device.kind === 'set' ? 'поставить' : 'включить'} ${resolved.device.label}?`
}

// «повтори»: say the last answer again; after a silent command run it again (or ask when that is not safe).
// While a question is still pending the repeat is the question itself.
async function repeatLast (config: { token: string, url: string }, want: RepeatTarget, speakerLevel: null | number): Promise<FastIntentResult | null> {
  const station = currentStation()
  const pending = getPending()
  if (pending !== null && Date.now() < pending.expiresAt) {
    const question = latestTurn('answer', station)
    if (question?.asked === true) {
      pending.expiresAt = Date.now() + AMBIGUITY_TTL_MS
      return { kind: 'reply', listen: true, quasarDirectives: [], text: question.spoken }
    }
  }
  const turn = latestTurn(want, station)
  if (turn === null) return null
  if (want !== 'command' && turn.spoken !== null) return { kind: 'reply', listen: turn.asked, quasarDirectives: [], text: turn.spoken }
  if (turn.action === null) return null
  const question = repeatQuestion(turn.action.resolved)
  if (question === null) return await executeResolved(config, turn.action.resolved, speakerLevel)
  setPending({ declineToBrain: false, expiresAt: Date.now() + AMBIGUITY_TTL_MS, mode: 'confirm',
    phrase: turn.action.phrase, remember: false, resolved: turn.action.resolved })
  return { kind: 'reply', listen: true, quasarDirectives: [], text: question }
}

const FOLLOW_UP_OPENERS = ['а', 'и', 'тоже', 'там']
const FOLLOW_UP_FILLERS = ['а', 'и', 'ну', 'тоже', 'там', 'еще', 'вот']
const ROOM_PREPOSITIONS = ['в', 'во', 'на', 'у']
const ROOM_NOUNS = ['этаже', 'этаж', 'комнате', 'комнату']

function isRoomWord (token: string): boolean {
  return ROOM_NOUNS.includes(token) || ROOMS.some(room => room.keywords.some(keyword => keyword.split(' ').some(part => token.startsWith(part))))
}

// «Включи свет в гостиной» … «а на кухне?»: the previous device command aimed at the room just named.
// Null unless the phrase is nothing but such a room follow-up and a command ran in the last minutes.
function followUpPhrase (tokens: string[]): null | string {
  const prior = latestAction(currentStation())
  if (prior === null || prior.resolved.type !== 'device' || !FOLLOW_UP_OPENERS.includes(tokens[0] ?? '')) return null
  const words = tokens.filter(token => token !== 'алиса' && !FOLLOW_UP_FILLERS.includes(token))
  if (words.length === 0 || words.length > 4 || !words.every(token => ROOM_PREPOSITIONS.includes(token) || isRoomWord(token))) return null
  if (!words.some(isRoomWord)) return null
  const kept: string[] = []
  // The sentence that ran, not the chatter after it («Включи свет в гостиной. Не знаю.»): a negated one would make the follow-up refuse.
  const ran = splitSentences(prior.phrase).find(sentence => !hasNegation(tokenize(sentence))) ?? prior.phrase
  for (const token of tokenize(ran).filter(word => word !== 'алиса')) {
    if (!isRoomWord(token)) {
      kept.push(token)
    } else if (ROOM_PREPOSITIONS.includes(kept[kept.length - 1] ?? '')) {
      kept.pop()
    }
  }
  return [...kept, ...words].join(' ')
}

export async function matchFastIntent (rawText: string, options: MatchOptions = {}): Promise<FastIntentResult | null> {
  const outer = turnTrace.getStore()
  const trace: TurnTrace = outer ?? { executed: null, phrase: '', skipRecording: false, station: stationKey(options.deviceId) }
  const result = outer === undefined
    ? await turnTrace.run(trace, async () => await matchFastIntentCore(rawText, options))
    : await matchFastIntentCore(rawText, options)
  if (result?.kind === 'reply' && result.listen === true && result.text !== null) noteAsked(result.text, trace.station)
  if (outer === undefined && !trace.skipRecording && result?.kind === 'reply') {
    const turn: Turn = {
      action: result.text === null ? trace.executed : null,
      asked: result.listen === true && result.text !== null,
      at: Date.now(),
      heard: rawText,
      origin: options.origin ?? 'voice',
      spoken: result.text,
      station: trace.station
    }
    recordTurn(turn)
  }
  return result
}

async function matchFastIntentCore (rawText: string, options: MatchOptions): Promise<FastIntentResult | null> {
  const config = getConfig()
  if (!config) return null
  const text = rawText?.trim()
  if (!text) return null
  const s = normalize(text)
  const tokens = tokenize(s)
  const speakerLevel = options.speakerLevel ?? null
  const trace = turnTrace.getStore()
  if (trace !== undefined) trace.phrase = s

  try {
    // «ничего», «хватит», «спасибо», «отмена», «пока»: silent end of the dialog, before any pending question and
    // before the brain. Only the stop class on a fresh turn (no dialog in progress) reaches the music.
    const end = parseEndDialog(text)
    if (end !== null) {
      setPending(null)
      forgetAsked(currentStation())
      if (end === 'stop' && options.dialogActive !== true) return await runMediaControl(config, 'stop') ?? DIALOG_END
      return DIALOG_END
    }

    // «повтори», «ещё раз», «прошлую команду»: answered from the last turns, never by a clarifying brain question.
    // Without a recent turn the phrase goes on (to the brain, which has the adapter's dialog list).
    const repeat = parseRepeat(tokens)
    if (repeat !== null) {
      const repeated = await repeatLast(config, repeat, speakerLevel)
      if (repeated !== null) {
        if (trace !== undefined) trace.skipRecording = true
        logger.info(`Fast intent repeat (${repeat}) for '${s}': ${repeated.kind === 'reply' ? repeated.text ?? '(command again)' : repeated.text}`)
        return repeated
      }
    }

    // A question is pending: this turn is the answer.
    const pending = getPending()
    if (pending !== null) {
      setPending(null)
      if (trace !== undefined && pending.mode !== 'fill') trace.phrase = pending.phrase
      if (Date.now() < pending.expiresAt) {
        const answer = resolveClarification(tokens)
        if (pending.mode === 'fill') {
          // «Какую громкость поставить?» → «семь»; «Громкость или яркость?» → «громкость».
          const filled = answer === 'no' || hasNegation(tokens) ? null : pending.fill?.(parseUtterance(s, ROOMS, [])) ?? null
          if (filled !== null) return await executeResolved(config, filled, speakerLevel)
          if (answer === 'no') {
            forgetAsked(currentStation())
            return DIALOG_END
          }
        } else if (pending.mode === 'home-or-music') {
          if (answer === 'home') {
            rememberAmbiguity(pending.phrase, 'home')
            return await executeResolved(config, pending.resolved!, speakerLevel)
          }
          if (answer === 'llm') {
            rememberAmbiguity(pending.phrase, 'llm')
            // Route the ORIGINAL phrase to the brain, not the one-word answer.
            return { kind: 'llm', text: pending.phrase }
          }
        } else {
          if (answer === 'yes') {
            const confirmed = pending.resolved!
            // A setting is never «выучено»: its confirmation is asked every time, and «да» marks that this very change was confirmed.
            if (pending.remember !== false && confirmed.type !== 'setting') rememberAmbiguity(pending.phrase, 'home')
            return await executeResolved(config, confirmed.type === 'setting' ? { ...confirmed, confirmed: true } : confirmed, speakerLevel)
          }
          if (answer === 'no') {
            // An explicit refusal («не делай») cancels; sending the phrase on to the brain is for «нет, я про другое». Either way the
            // refused question is no context for what is said next.
            forgetAsked(currentStation())
            return pending.declineToBrain && !hasNegation(tokens)
              ? { kind: 'llm', text: pending.phrase }
              : DIALOG_END
          }
        }
        // Unrecognized answer: fall through and match the new phrase normally.
      }
    }
    if (trace !== undefined) trace.phrase = s

    // «а на кухне?» right after «включи свет в гостиной»: the same command for the room just named.
    const followUp = followUpPhrase(tokens)
    if (followUp !== null) {
      logger.info(`Fast intent follow-up '${s}' -> '${followUp}'`)
      const rerun = await matchFastIntent(followUp, { ...options, noCorrect: true })
      if (rerun !== null) return rerun
    }

    // Grammar first (adapter /intent/decide, no language model): after a pending answer was handled and the room
    // follow-up («а на кухне?», which needs the previous device command the grammar never sees) had its turn, before
    // the catalog and the brain. Fail-open: null (timeout, adapter down, GRAMMAR_HOOK=shadow|off) means the phrase goes
    // on through the tiers below exactly as before.
    const grammar = await grammarRoute(text, { dialogActive: options.dialogActive === true, speakerLevel })
    if (grammar !== null && grammar.route !== 'none') {
      let grammarResult: FastIntentResult | null = null
      if (grammar.route === 'reply' && grammar.text !== null) {
        grammarResult = grammar.listen
          ? { kind: 'reply', listen: true, quasarDirectives: [], text: grammar.text }
          : { kind: 'reply', quasarDirectives: [], text: grammar.text }
      } else if (grammar.route === 'silent') {
        grammarResult = DIALOG_END
      } else if (grammar.route === 'dialog_end') {
        setPending(null)
        forgetAsked(currentStation())
        grammarResult = DIALOG_END
      } else if (grammar.route === 'volume' && grammar.volume !== null) {
        const asked = grammar.volume
        const volume: VolumeIntent = { kind: 'set' }
        if (asked.target !== undefined) volume.target = asked.target
        else if (asked.deltaLevels !== undefined) {
          // Levels are the speaker's own 0..10 scale; without its reported level only the direction is known.
          if (speakerLevel !== null && Number.isFinite(speakerLevel)) volume.target = Math.min(1, Math.max(0, (speakerLevel + asked.deltaLevels) / MAX_LEVEL))
          else volume.steps = Math.sign(asked.deltaLevels)
        } else if (asked.steps !== undefined) volume.steps = asked.steps
        if (volume.target !== undefined || volume.steps !== undefined) {
          // «повтори» after a level change repeats the level it reached (a target), not the change: the recorded
          // command has no way to carry a delta in levels.
          if (trace !== undefined) trace.executed = { phrase: trace.phrase, resolved: { type: 'volume', volume } }
          // The step is read only for a relative ask, the same way executeResolved does.
          grammarResult = volumeResult(volume, speakerLevel, volume.steps === undefined ? DEFAULT_VOLUME_STEP_PCT : await volumeStepPct())
        }
      }
      if (grammarResult !== null) {
        logger.info(`Grammar route '${s}' -> ${grammar.intent ?? 'none'} (${grammar.route}, ${grammar.ms} ms)`)
        return grammarResult
      }
    }

    // Pure arithmetic answers instantly: no HA roundtrip, no brain.
    const math = evaluateMath(s)
    if (math !== null) {
      return {
        kind: 'reply',
        quasarDirectives: [],
        text: Number.isNaN(math) ? 'На ноль делить нельзя.' : formatMath(math)
      }
    }

    // An explicit TV app request always targets the TV/Chromecast pair, even from another speaker.
    const tvApp = parseTvAppIntent(text)
    if (tvApp !== null) {
      const outcome = await executeTvAppIntent(tvApp, {
        callScript: async entityId => {
          const response = await haServiceFetch(config, '/api/services/script/turn_on', { entity_id: entityId })
          if (response.status === 202) throw restartingError(response)
          if (!response.ok) throw haFailure(response, 'TV application launch')
        },
        readNative: async () => await currentEntity(config, 'media_player.televizor')
      })
      logger.info(`Fast TV application ${tvApp.app}: ${outcome.status}`)
      return outcome.status === 'confirmed'
        ? { kind: 'reply', quasarDirectives: earconDirectives('on'), text: null }
        : { kind: 'reply', quasarDirectives: [], text: `Команда отправлена. Открытие ${tvApp.label} на телевизоре пока не подтверждено.` }
    }

    // The named fireplace is the fixed Kodi video, regardless of the speaker's room.
    const fireplace = parseFireplaceIntent(text)
    if (fireplace !== null) {
      const outcome = await executeFireplaceIntent(fireplace, {
        callScript: async entityId => {
          const response = await haServiceFetch(config, '/api/services/script/turn_on', { entity_id: entityId })
          if (response.status === 202) throw restartingError(response)
          if (!response.ok) throw haFailure(response, 'Projector fireplace launch')
        },
        readNative: async () => await currentEntity(config, 'media_player.home'),
        readReadiness: async () => await currentEntity(config, 'sensor.living_room_fireplace')
      })
      logger.info(`Fast projector fireplace: ${outcome.status}`)
      return outcome.status === 'confirmed'
        ? { kind: 'reply', quasarDirectives: earconDirectives('on'), text: null }
        : { kind: 'reply', quasarDirectives: [], text: 'Команда отправлена. Воспроизведение камина на проекторе пока не подтверждено.' }
    }

    // «стоп», «пауза», «продолжи», «дальше», «назад»: the speaker's own AirPlay playback (Music
    // Assistant or a phone), else a Home Assistant player. Never the brain: it can only talk.
    const mediaKey = parseMediaControl(s)
    if (mediaKey !== null) {
      const handled = await runMediaControl(config, mediaKey)
      if (handled !== null) return handled
    }

    const reg = await getRegistry(config)
    const area = roomOfSpeaker(reg, options.deviceId)
    const decision = decideFastIntent(text, reg, area)
    if (decision.tier !== 'llm') logger.info(`Fast intent room for '${s}': ${area} (station ${options.deviceId ?? 'unknown'})`)
    if (decision.tier !== 'reprompt') lastReprompts.delete(currentStation())
    logger.debug(`Fast intent decision '${s}': ${decision.tier} ${'trace' in decision ? decision.trace ?? '' : ''}`)

    // Gray zone / reprompt: a repaired phrase goes through the same tiers instead of asking or staying unclear.
    // A silenced reprompt (noise loop) is not worth a model call.
    if (decision.tier !== 'llm' && !(decision.tier === 'reprompt' && Date.now() - (lastReprompts.get(currentStation()) ?? 0) < REPROMPT_LOOP_MS)) {
      const repaired = await correctionFor(text, decision.tier, options, reg)
      if (repaired !== null) return repaired
    }

    switch (decision.tier) {
      case 'math':
      case 'llm': {
        // «включи Sex Pistols»: nothing local matched, so try the music catalog before the brain.
        const music = await tryMusicIntent(s)
        if (music !== null) return { kind: 'reply', quasarDirectives: [], text: music.text }
        // Short no-match («ключи свет», «…ставь таймер на пять минут»): one repair attempt before the brain.
        const repaired = await correctionFor(text, decision.tier, options, reg)
        if (repaired !== null) return repaired
        // Short no-match: shadow-classify before falling through to the LLM brain.
        if (tokens.length <= 4) shadowClassify(text, null, 'nomatch')
        return null
      }
      case 'answer':
        return { kind: 'reply', quasarDirectives: [], text: decision.text }
      case 'query': {
        if (decision.query === 'volume') {
          return {
            kind: 'reply',
            quasarDirectives: [],
            // Same units as the dashboard (0..10), short; the only volume turn that speaks.
            text: speakerLevel === null ? 'Не знаю текущую громкость.' : `Громкость ${speakerLevel} из ${MAX_LEVEL}.`
          }
        }
        // State queries only ever ANSWER — execution is impossible by design.
        const fresh = await getRegistry(config, true)
        return { kind: 'reply', quasarDirectives: [], text: buildStateReport(fresh, decision.lightsOnly === true) }
      }
      case 'execute':
        if (decision.via === 'catalog') shadowClassify(text, null, 'catalog')
        return await executeResolved(config, decision.resolved, speakerLevel)
      case 'confirm': {
        if (decision.via === 'exact') shadowClassify(text, decision.score ?? null, 'gray')
        else shadowClassify(text, null, 'catalog')
        // A phrase the owner already confirmed once runs directly («выучено»).
        if (decision.resolved.type !== 'setting' && loadAmbiguityMemory()[s] === 'home') return await executeResolved(config, decision.resolved, speakerLevel)
        setPending({ declineToBrain: decision.declineToBrain, expiresAt: Date.now() + AMBIGUITY_TTL_MS,
          mode: 'confirm', phrase: s, resolved: decision.resolved })
        return { kind: 'reply', listen: true, quasarDirectives: [], text: decision.question }
      }
      case 'clarify': {
        if (decision.via === 'exact') {
          // Legacy «Свет или музыку?»: the remembered choice skips the question.
          shadowClassify(text, decision.score ?? null, 'gray')
          const remembered = loadAmbiguityMemory()[s]
          if (remembered === 'home') return await executeResolved(config, decision.resolved!, speakerLevel)
          if (remembered === 'llm') return { kind: 'llm', text: s }
        } else {
          shadowClassify(text, null, 'catalog')
        }
        setPending({ declineToBrain: false, expiresAt: Date.now() + AMBIGUITY_TTL_MS, fill: decision.fill,
          mode: decision.mode, phrase: s, resolved: decision.resolved })
        return { kind: 'reply', listen: true, quasarDirectives: [], text: decision.question }
      }
      case 'reprompt': {
        // Never a list of guesses. Said once; a second miss right after it stays silent so
        // the station cannot be talked into a «не расслышала» loop by noise.
        if (Date.now() - (lastReprompts.get(currentStation()) ?? 0) < REPROMPT_LOOP_MS) return { kind: 'reply', quasarDirectives: [], text: null }
        rememberFor(lastReprompts, currentStation(), Date.now())
        return { kind: 'reply', listen: true, quasarDirectives: [], text: REPROMPT_TEXT }
      }
    }
  } catch (error) {
    if (error instanceof HaQueuedError) {
      logger.warn(`Fast intent '${s}' queued: Home Assistant unavailable (${error.down ?? 'no evidence'}, eta ${error.etaSeconds ?? '?'}s)`)
      return { kind: 'reply', quasarDirectives: [], text: haRecoveryText(error.down) }
    }
    logger.error(`Fast intent '${s}' failed:`, error)
    if (error instanceof HaCommandError) return { kind: 'reply', quasarDirectives: [], text: error.say }
    return { kind: 'reply', quasarDirectives: [], text: 'Не удалось выполнить команду умного дома.' }
  }
}

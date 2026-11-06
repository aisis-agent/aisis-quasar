// Scored fast-intent layer: candidate interpretations are scored per utterance
// (exact 1.0 / stem 0.95-prefix / fuzzy 0.8 / mismatch 0) and dispatched:
//   score >= 0.9        -> execute silently (state re-verified, errors spoken)
//   0.5 <= score < 0.9  -> clarifying question (ShouldListen follow-up)
//   score < 0.5         -> fall through to the LLM brain
// State queries («что включено», «какой свет включен») NEVER execute. Instant
// local math («сколько будет 2+2») answers without the brain. Ambiguity choices
// persist in /src/ha.ambiguity.json. Config: AISIS_HA_URL/AISIS_HA_TOKEN env or
// /src/ha.config.json; no config -> layer disabled.

import { readFileSync, writeFileSync } from 'node:fs'

import { getLogger } from '../logger'
import { encodeProtobufStruct } from '../protobuf'
import proto from '../protos/protos'
import { shadowClassify } from './semantic-shadow'

export type FastIntentResult =
  | { kind: 'llm', text: string } // route this (rewritten) text to the LLM brain
  | { kind: 'reply', quasarDirectives: proto.NAlice.NAliceApi.ITDirective[], text: null | string } // null text = silent

interface HaEntity {
  attributes: { friendly_name?: string, volume_level?: number }
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

// Thrown when a service call was accepted into the ha-cli queue because HA is
// restarting; measured cold starts (odroid HA logs, 2026-10-27..11-06):
// 78-119s, median ~90s.
class HaRestartingError extends Error {}

const HA_RECOVERY_TEXT =
  'Умный дом перезагружается, обычно примерно через девяносто секунд всё придёт в норму.'

interface DeviceIntent {
  kind: 'on' | 'off'
  label: string
  targets: string[] // entity ids; empty when wholeDomain is set
  wholeDomain?: 'light'
}

interface PendingClarification {
  device: DeviceIntent
  expiresAt: number
  mode: 'confirm' | 'home-or-music'
  phrase: string
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

// ── Vocabulary ────────────────────────────────────────────────────────────────

const ROOMS: { area: string, declined: string, keywords: string[] }[] = [
  { area: 'Гостиная', declined: 'в гостиной', keywords: ['гостин'] },
  { area: 'Кухня', declined: 'на кухне', keywords: ['кухн'] },
  { area: 'Спальня', declined: 'в спальне', keywords: ['спальн'] },
  { area: 'Студия', declined: 'в студии', keywords: ['студи'] },
  { area: 'Прихожая', declined: 'в прихожей', keywords: ['прихож', 'коридор'] },
  { area: 'Второй этаж', declined: 'наверху', keywords: ['второй этаж', 'втором этаж', 'наверх'] }
]

const DEFAULT_AREA = 'Гостиная'
const ROOM_DEFAULT_SCORE = 0.95
const FUZZY_ENTITY_SCORE = 0.8

const ON_VERBS = ['включи', 'включить', 'включай', 'зажги', 'зажечь', 'вруби', 'врубить']
const OFF_VERBS = ['выключи', 'выключить', 'выключай', 'отключи', 'отключить',
  'выруби', 'вырубить', 'потуши', 'погаси', 'погасить']

const LIGHT_WORDS = ['свет', 'освещени', 'лампочк', 'ламп', 'ночник', 'светильник']
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

const STATION_MEDIA_PLAYER = 'media_player.mini_gostinaia'

// Overridable so tests can point it at a scratch file.
const AMBIGUITY_FILE = process.env.AISIS_HA_AMBIGUITY_FILE ?? '/src/ha.ambiguity.json'
const AMBIGUITY_TTL_MS = 30_000

const EXECUTE_THRESHOLD = 0.9
const CLARIFY_THRESHOLD = 0.5

// ── Russian numerals and math ────────────────────────────────────────────────

const NUMBER_WORDS: Record<string, number> = {
  ноль: 0, один: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5,
  шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11,
  двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15,
  шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
  двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60,
  семьдесят: 70, восемьдесят: 80, девяносто: 90, сто: 100, двести: 200,
  триста: 300, четыреста: 400, пятьсот: 500, шестьсот: 600, семьсот: 700,
  восемьсот: 800, девятьсот: 900, тысяча: 1000, тысячи: 1000, тысяч: 1000
}

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

interface VolumeIntent {
  kind: 'query' | 'set'
  relative?: number
  target?: number
}

function levenshtein (a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    let swap = previous[0]
    previous[0] = i
    for (let j = 1; j <= b.length; j++) {
      const temp = previous[j]
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        swap + (a[i - 1] === b[j - 1] ? 0 : 1))
      swap = temp
    }
  }
  return previous[b.length]
}

// 1.0 exact/stem-prefix, 0.8 close typo (Levenshtein <= 2), else 0.
function tokenSimilarity (token: string, stem: string): number {
  if (token === stem || token.startsWith(stem) || stem.startsWith(token) && token.length >= 4) return 1
  if (token.length >= 5 && stem.length >= 5 && levenshtein(token, stem) <= 2) return FUZZY_ENTITY_SCORE
  return 0
}

function normalize (text: string): string {
  return text.toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^a-zа-я0-9\s+\-*/.,×÷]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Composes a Russian numeral run («двести пятьдесят четыре») into one number.
function composeNumeral (tokens: string[], start: number): { end: number, value: number } {
  let total = 0
  let current = 0
  let index = start
  while (index < tokens.length && tokens[index] in NUMBER_WORDS) {
    const value = NUMBER_WORDS[tokens[index]]
    if (value >= 1000) {
      total += (current || 1) * value
      current = 0
    } else {
      current += value
    }
    index++
  }
  return { end: index, value: total + current }
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
let pendingClarification: PendingClarification | null = null
let ambiguityMemory: null | Record<string, 'home' | 'llm'> = null

const REGISTRY_TTL_MS = 60_000
const FETCH_TIMEOUT_MS = 3000

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
  turnOn: boolean): Promise<void> {
  const domain = entityId.split('.')[0]
  let path = `/api/services/${domain}/${turnOn ? 'turn_on' : 'turn_off'}`
  let body: Record<string, unknown> = { entity_id: entityId }
  if (domain === 'climate') {
    // turn_on is a no-op on these IR ACs; an explicit mode actually starts them.
    path = '/api/services/climate/set_hvac_mode'
    body = { entity_id: entityId, hvac_mode: turnOn ? 'cool' : 'off' }
  }
  const response = await haFetch(config, path, body)
  if (response.status === 202) {
    // Accepted into the ha-cli delayed queue: HA is restarting.
    throw new HaRestartingError('ha-cli queued the call')
  }
  if (!response.ok) {
    throw new Error(`HA ${path} ${entityId} -> ${response.status}`)
  }
}

async function callWholeDomain (config: { token: string, url: string },
  wholeDomain: 'light', turnOn: boolean): Promise<void> {
  // Domain-wide HA calls require entity_id "all".
  const response = await haFetch(config,
    `/api/services/${wholeDomain}/${turnOn ? 'turn_on' : 'turn_off'}`, { entity_id: 'all' })
  if (response.status === 202) throw new HaRestartingError('ha-cli queued the call')
  if (!response.ok) {
    throw new Error(`HA ${wholeDomain}/${turnOn ? 'turn_on' : 'turn_off'} -> ${response.status}`)
  }
}

async function currentState (config: { token: string, url: string }, entityId: string): Promise<string | undefined> {
  const response = await haFetch(config, `/api/states/${entityId}`)
  // Stale (cached) state must not drive "already on" dedupe answers.
  if (!response.ok || response.headers.get('x-aisis-cache') === 'stale') return undefined
  return (await response.json() as HaEntity).state
}

// Post-execution verification: Zigbee/IR devices settle for seconds, so poll.
// Returns true once every target reports the desired state.
async function verifyExecution (config: { token: string, url: string }, device: DeviceIntent): Promise<boolean> {
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
  if (/максимальн\w*\s+громкость|громкость.{0,12}максимум|громкость на полную/.test(s)) {
    return { kind: 'set', target: 1 }
  }
  if (/минимальн\w*\s+громкость|громкость.{0,12}минимум/.test(s)) {
    return { kind: 'set', target: 0.1 }
  }
  if (s.includes('громкость')) {
    const digitIndex = tokens.findIndex(token => /^\d+$/.test(token))
    const wordIndex = tokens.findIndex(token => token in NUMBER_WORDS)
    const number = digitIndex >= 0
      ? Number(tokens[digitIndex])
      : wordIndex >= 0 ? composeNumeral(tokens, wordIndex).value : null
    if (number !== null && number > 0) {
      // «громкость на пять» = Alice 0..10 scale, «громкость 50» = percent.
      return { kind: 'set', target: number <= 10 ? number / 10 : number / 100 }
    }
    // «прибавь/убавь громкость» without a number.
    return /прибав|добав|повыс/.test(s) ? { kind: 'set', relative: 0.2 } : { kind: 'set', relative: -0.2 }
  }
  const louder = /громче/.test(s) // substring: covers «погромче» too
  const quieter = /тише/.test(s) // \b does not work with Cyrillic — plain substring
  if (louder !== quieter) { // exactly one of them
    const big = /(значительн|сильн|гораздо|намного)/.test(s) ? 0.4 : 0.1
    const step = /(чуть|немного|слегка)/.test(s) ? 0.1 : big === 0.4 ? 0.4 : 0.2
    return { kind: 'set', relative: louder ? step : -step }
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

function resolveCommand (s: string, tokens: string[], reg: HaRegistry): ScoredIntent | null {
  const on = tokens.some(token => ON_VERBS.some(verb => token.startsWith(verb)))
  const off = tokens.some(token => OFF_VERBS.some(verb => token.startsWith(verb)))
  if (!on && !off) return null
  const kind: 'on' | 'off' = on ? 'on' : 'off'

  // AC resolves by room: kondei_1 — Гостиная, kondei_2 — Второй этаж.
  if (/(кондиционер|кондей|конде|сплит)/.test(s)) {
    const usable = ['climate.kondei_1', 'climate.kondei_2'].filter(id => {
      const state = reg.entities.get(id)?.state
      return state !== undefined && state !== 'unavailable' && state !== 'unknown'
    })
    const areas = mentionedRoomAreas(s)
    const targets = areas.length > 0
      ? usable.filter(id => areas.includes(entityArea(reg, id) ?? ''))
      : usable.slice(0, 1)
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
    const effectiveAreas = areas.length > 0 ? areas : [DEFAULT_AREA]
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

export function scoreIntent (rawText: string, reg: HaRegistry): null | ScoredIntent {
  const s = normalize(rawText)
  const tokens = s.split(' ')
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

  return resolveCommand(s, tokens, reg)
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

// Executes a device intent against HA, then VERIFIES the resulting state.
// Silent only when the action is confirmed; failures are always spoken.
async function executeDeviceIntent (config: { token: string, url: string }, device: DeviceIntent): Promise<FastIntentResult> {
  const desired = device.kind === 'on' ? 'on' : 'off'

  // Single target already in the desired state -> no call, spoken answer.
  // Fresh per-entity GET: the registry is cached for 60s.
  if (device.targets.length === 1 && !device.wholeDomain) {
    if (await currentState(config, device.targets[0]) === desired) {
      return { kind: 'reply', quasarDirectives: [], text: alreadyText(device.label, desired) }
    }
  }

  const turnOn = device.kind === 'on'
  if (device.wholeDomain) {
    await callWholeDomain(config, device.wholeDomain, turnOn)
  } else {
    await Promise.all(device.targets.map(entityId => callService(config, entityId, turnOn)))
  }

  if (await verifyExecution(config, device)) {
    logger.info(`Fast intent executed: ${device.kind} [${device.targets.join(', ') || device.wholeDomain}]`)
    return { kind: 'reply', quasarDirectives: [], text: null }
  }
  logger.warn(`Fast intent VERIFY FAILED: ${device.kind} [${device.targets.join(', ') || device.wholeDomain}]`)
  return {
    kind: 'reply',
    quasarDirectives: [],
    text: `Не получилось ${turnOn ? 'включить' : 'выключить'} ${device.label}.`
  }
}

function resolveClarification (tokens: string[]): 'home' | 'llm' | 'yes' | 'no' | null {
  if (tokens.some(token => ['свет', 'света', 'свету', 'лампа', 'лампу'].includes(token))) return 'home'
  if (tokens.some(token => token.startsWith('музык'))) return 'llm'
  if (tokens.some(token => ['да', 'конечно', 'точно', 'правильно', 'угу', 'ага', 'верно'].includes(token))) return 'yes'
  if (tokens.some(token => ['нет', 'не', 'неа', 'другое', 'отмена'].includes(token))) return 'no'
  return null
}

// ── Entry point ──────────────────────────────────────────────────────────────

export async function matchFastIntent (rawText: string): Promise<FastIntentResult | null> {
  const config = getConfig()
  if (!config) return null
  const text = rawText?.trim()
  if (!text) return null
  const s = normalize(text)
  const tokens = s.split(' ')

  try {
    // A clarifying question is pending: this turn is the answer.
    if (pendingClarification !== null) {
      const pending = pendingClarification
      pendingClarification = null
      if (Date.now() < pending.expiresAt) {
        const answer = resolveClarification(tokens)
        if (pending.mode === 'home-or-music') {
          if (answer === 'home') {
            rememberAmbiguity(pending.phrase, 'home')
            return await executeDeviceIntent(config, pending.device)
          }
          if (answer === 'llm') {
            rememberAmbiguity(pending.phrase, 'llm')
            // Route the ORIGINAL phrase to the brain, not the one-word answer.
            return { kind: 'llm', text: pending.phrase }
          }
        } else {
          if (answer === 'yes') {
            rememberAmbiguity(pending.phrase, 'home')
            return await executeDeviceIntent(config, pending.device)
          }
          if (answer === 'no') {
            return { kind: 'llm', text: pending.phrase }
          }
        }
        // Unrecognized answer: fall through and match the new phrase normally.
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

    const reg = await getRegistry(config)
    const intent = scoreIntent(text, reg)
    if (intent === null) {
      // Short no-match: shadow-classify before falling through to the LLM brain.
      if (tokens.length <= 4) shadowClassify(text, null, 'nomatch')
      return null
    }
    // Gray zone (fuzzy 0.5-0.9 or ambiguity): shadow log only, no behavior change.
    if ((intent.score >= CLARIFY_THRESHOLD && intent.score < EXECUTE_THRESHOLD) || intent.ambiguous === true) {
      shadowClassify(text, intent.score, 'gray')
    }


    if (intent.kind === 'volume' && intent.volume !== undefined) {
      const volume = intent.volume
      if (volume.kind === 'query') {
        const level = reg.entities.get(STATION_MEDIA_PLAYER)?.attributes.volume_level
        const answer = typeof level === 'number'
          ? `Громкость ${Math.round(level * 100)} процентов.`
          : 'Не знаю текущую громкость.'
        return {
          kind: 'reply',
          quasarDirectives: [],
          text: reg.stale === true ? `По последним данным, ${answer[0].toLowerCase()}${answer.slice(1)}` : answer
        }
      }
      let target = volume.target
      if (volume.relative !== undefined) {
        const current = reg.entities.get(STATION_MEDIA_PLAYER)?.attributes.volume_level ?? 0.5
        target = current + volume.relative
      }
      const clamped = Math.round(Math.min(1, Math.max(0.05, target ?? 0.5)) * 100) / 100
      return {
        kind: 'reply',
        quasarDirectives: [{
          Name: 'set_volume',
          Payload: encodeProtobufStruct({ volume: clamped }),
          Type: 'client_action'
        }],
        text: `Громкость ${Math.round(clamped * 100)} процентов.`
      }
    }

    // State queries only ever ANSWER — execution is impossible by design.
    if (intent.kind === 'state_query') {
      const fresh = await getRegistry(config, true)
      return { kind: 'reply', quasarDirectives: [], text: buildStateReport(fresh, intent.lightsOnly === true) }
    }

    // Command: dispatch by score.
    if (intent.score >= EXECUTE_THRESHOLD && !intent.ambiguous) {
      return await executeDeviceIntent(config, intent.device!)
    }
    if (intent.score >= CLARIFY_THRESHOLD || intent.ambiguous === true) {
      const remembered = loadAmbiguityMemory()[s]
      if (intent.ambiguous === true && remembered === 'home') {
        return await executeDeviceIntent(config, intent.device!)
      }
      if (intent.ambiguous === true && remembered === 'llm') {
        return { kind: 'llm', text: s }
      }
      const mode = intent.ambiguous === true ? 'home-or-music' : 'confirm'
      pendingClarification = { device: intent.device!, expiresAt: Date.now() + AMBIGUITY_TTL_MS, mode, phrase: s }
      return {
        kind: 'reply',
        quasarDirectives: [],
        text: mode === 'home-or-music' ? 'Свет или музыку?' : `Ты про ${intent.device!.label}?`
      }
    }
    return null
  } catch (error) {
    if (error instanceof HaRestartingError) {
      logger.warn(`Fast intent '${s}' queued: Home Assistant is restarting`)
      return { kind: 'reply', quasarDirectives: [], text: HA_RECOVERY_TEXT }
    }
    logger.error(`Fast intent '${s}' failed:`, error)
    return { kind: 'reply', quasarDirectives: [], text: 'Не удалось выполнить команду умного дома.' }
  }
}

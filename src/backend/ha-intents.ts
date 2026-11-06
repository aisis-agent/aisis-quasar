// Fast local intent layer: Alice-style smart home commands (lights by room,
// sockets, AC, speaker volume via client_action, "what is on") executed directly
// against the Home Assistant REST API before the LLM brain is consulted.
// On/off commands execute silently (no TTS); informational replies (volume,
// state queries, "already on" answers, clarifying questions) are spoken.
// Unmatched phrases fall through to the LLM unchanged.
// Configuration: AISIS_HA_URL + AISIS_HA_TOKEN env vars, falling back to
// /src/ha.config.json ({ url, token }). No config -> layer disabled.

import { readFileSync, writeFileSync } from 'node:fs'

import { getLogger } from '../logger'
import { encodeProtobufStruct } from '../protobuf'
import proto from '../protos/protos'

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
}

interface DeviceIntent {
  kind: 'on' | 'off'
  label: string
  targets: string[] // entity ids; empty when wholeDomain is set
  wholeDomain?: 'light'
}

interface PendingClarification {
  device: DeviceIntent
  expiresAt: number
  phrase: string
}

const logger = getLogger()

// Room keywords (normalized) -> HA area names + Russian declined form for TTS.
const ROOMS: { area: string, declined: string, keywords: string[] }[] = [
  { area: 'Гостиная', declined: 'в гостиной', keywords: ['гостин'] },
  { area: 'Кухня', declined: 'на кухне', keywords: ['кухн'] },
  { area: 'Спальня', declined: 'в спальне', keywords: ['спальн'] },
  { area: 'Студия', declined: 'в студии', keywords: ['студи'] },
  { area: 'Прихожая', declined: 'в прихожей', keywords: ['прихож', 'коридор'] },
  { area: 'Второй этаж', declined: 'наверху', keywords: ['второй этаж', 'втором этаж', 'наверх'] }
]

// This station («Мини гостиная») stands in the living room: room-less
// "включи свет" targets it, same as genuine Alice does.
const DEFAULT_AREA = 'Гостиная'

const ON_VERBS = ['включи', 'включить', 'включай', 'зажги', 'зажечь', 'вруби', 'врубить']
const OFF_VERBS = ['выключи', 'выключить', 'выключай', 'отключи', 'отключить',
  'выруби', 'вырубить', 'потуши', 'погаси', 'погасить']

const LIGHT_WORDS = ['свет', 'освещени', 'лампочк', 'лампочку', 'лампу', 'лампы',
  'ночник', 'светильник']

// Entities reported by the "what is on" query, besides lights.
const STATE_REPORT: { entity: string, label: string }[] = [
  { entity: 'switch.kettle_plug_local', label: 'чайник' },
  { entity: 'switch.globus3', label: 'глобус' },
  { entity: 'climate.kondei_1', label: 'кондиционер в гостиной' },
  { entity: 'climate.kondei_2', label: 'кондиционер наверху' },
  { entity: 'media_player.televizor', label: 'телевизор' },
  { entity: 'media_player.gostinaia', label: 'музыка в гостиной' }
]

// HA media_player mirroring this very station; source of current volume level.
const STATION_MEDIA_PLAYER = 'media_player.mini_gostinaia'

// On-commands for entities whose noun plausibly names music/media too («Глобус»
// is also an artist): ask once, remember the choice in /src/ha.ambiguity.json.
const AMBIGUOUS_LABELS = ['глобус']
const AMBIGUITY_FILE = '/src/ha.ambiguity.json'
const AMBIGUITY_TTL_MS = 30_000

const NUMBER_WORDS: Record<string, number> = {
  ноль: 0, один: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5,
  шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11,
  двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15,
  шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
  двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60,
  семьдесят: 70, восемьдесят: 80, девяносто: 90, сто: 100
}

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
  registry = { areaByEntity, entities, fetchedAt: Date.now() }
  return registry
}

function normalize (text: string): string {
  return text.toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^a-zа-я0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function entityArea (reg: HaRegistry, entityId: string): string | undefined {
  const area = reg.areaByEntity.get(entityId)
  if (area) return area
  // Fallback for entities without a device: match friendly names («Кухня»).
  const name = reg.entities.get(entityId)?.attributes.friendly_name?.toLowerCase() ?? ''
  return ROOMS.find(item => item.keywords.some(keyword => name.includes(keyword)))?.area
}

// «свет в гостиной»-style label with correct declension.
function lightLabel (areas: string[]): string {
  const declined = ROOMS.filter(room => areas.includes(room.area)).map(room => room.declined)
  if (declined.length === 0) return 'свет'
  return `свет ${declined.join(' и ')}`
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

// Composes tens+units («пятьдесят пять») and digit runs into one number.
function parseNumber (tokens: string[]): number | null {
  let result: number | null = null
  for (const token of tokens) {
    let value: number
    if (/^\d+$/.test(token)) {
      value = Number(token)
    } else if (token in NUMBER_WORDS) {
      value = NUMBER_WORDS[token]
    } else {
      continue
    }
    if (result !== null && result % 10 === 0 && result >= 20 && result < 100 && value < 10) {
      result += value
    } else {
      result = value
    }
  }
  return result
}

interface VolumeIntent {
  kind: 'query' | 'set'
  /** Absolute 0..1 target, or a signed delta when relative. */
  relative?: number
  target?: number
}

function matchVolume (s: string, tokens: string[]): VolumeIntent | null {
  if (/(какая|сколько).{0,12}громкость|громкость сейчас/.test(s)) {
    return { kind: 'query' }
  }
  if (/максимальн\w*\s+громкость|громкость.{0,12}максимум|громкость на полную/.test(s)) {
    return { kind: 'set', target: 1 }
  }
  if (/минимальн\w*\s+громкость|громкость.{0,12}минимум/.test(s)) {
    return { kind: 'set', target: 0.1 }
  }
  if (s.includes('громкость')) {
    const number = parseNumber(tokens)
    if (number !== null && number > 0) {
      // «громкость на пять» = Alice 0..10 scale, «громкость 50» = percent.
      return { kind: 'set', target: number <= 10 ? number / 10 : number / 100 }
    }
    // «прибавь/убавь громкость» without a number.
    return /прибав|добав|повыс/.test(s) ? { kind: 'set', relative: 0.2 } : { kind: 'set', relative: -0.2 }
  }
  const louder = /громче|погромче/.test(s)
  const quieter = /потише|\bтише\b/.test(s)
  if (louder !== quieter) { // exactly one of them
    const big = /(значительн|сильн|гораздо|намного)/.test(s) ? 0.4 : 0.1
    const step = /(чуть|немного|слегка)/.test(s) ? 0.1 : big === 0.4 ? 0.4 : 0.2
    return { kind: 'set', relative: louder ? step : -step }
  }
  return null
}

function resolveDeviceIntent (s: string, tokens: string[], reg: HaRegistry): DeviceIntent | null {
  const on = tokens.some(token => ON_VERBS.some(verb => token.startsWith(verb)))
  const off = tokens.some(token => OFF_VERBS.some(verb => token.startsWith(verb)))
  if (!on && !off) return null
  const kind: 'on' | 'off' = on ? 'on' : 'off'

  const globusUsable = ['on', 'off'].includes(reg.entities.get('light.gostinaia_globus_socket_1')?.state ?? '')
  const explicit: { keywords: string[], label: string, targets: string[] }[] = [
    { keywords: ['люстр'], label: 'люстру', targets: ['light.liustra'] },
    { keywords: ['глобус'], label: 'глобус',
      targets: [globusUsable ? 'light.gostinaia_globus_socket_1' : 'switch.globus3'] },
    { keywords: ['гирлянд'], label: 'гирлянду', targets: ['light.girlianda'] },
    { keywords: ['чайник', 'розетк'], label: s.includes('чайник') ? 'чайник' : 'розетку',
      targets: ['switch.kettle_plug_local'] },
    { keywords: ['телевизор', 'телек'], label: 'телевизор', targets: ['media_player.televizor'] },
    { keywords: ['проектор'], label: 'проектор', targets: ['media_player.projector'] }
  ]
  for (const rule of explicit) {
    if (rule.keywords.some(keyword => s.includes(keyword))) {
      return { kind, label: rule.label, targets: rule.targets }
    }
  }
  if (/(кондиционер|кондей|конде|сплит)/.test(s)) {
    const areas = mentionedRoomAreas(s)
    const candidates = areas.length > 0
      ? ['climate.kondei_1', 'climate.kondei_2'].filter(id => areas.includes(entityArea(reg, id) ?? ''))
      : ['climate.kondei_1']
    const targets = candidates.filter(id => {
      const state = reg.entities.get(id)?.state
      return state !== undefined && state !== 'unavailable' && state !== 'unknown'
    })
    if (targets.length > 0) {
      return { kind, label: 'кондиционер', targets }
    }
  }
  const isLight = LIGHT_WORDS.some(word => tokens.includes(word) || s.includes(word))
  const wantsAll = ['все', 'весь', 'всё', 'всей', 'всех'].some(word => tokens.includes(word)) ||
    ['везде', 'всюду', 'квартире', 'квартиры'].some(word => s.includes(word))
  if (isLight && wantsAll) {
    return { kind, label: 'весь свет', targets: [], wholeDomain: 'light' }
  }
  if (isLight) {
    const areas = mentionedRoomAreas(s)
    const effectiveAreas = areas.length > 0 ? areas : [DEFAULT_AREA]
    const targets = roomLights(reg, effectiveAreas)
    if (targets.length > 0) {
      return { kind, label: lightLabel(effectiveAreas), targets }
    }
  }
  if (wantsAll && !isLight) {
    // «выключи всё» -> every light in the home.
    return { kind, label: 'весь свет', targets: [], wholeDomain: 'light' }
  }
  return null
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
  if (!response.ok) {
    throw new Error(`HA ${path} ${entityId} -> ${response.status}`)
  }
}

async function callWholeDomain (config: { token: string, url: string },
  wholeDomain: 'light', turnOn: boolean): Promise<void> {
  // Domain-wide HA calls require entity_id "all".
  const response = await haFetch(config,
    `/api/services/${wholeDomain}/${turnOn ? 'turn_on' : 'turn_off'}`, { entity_id: 'all' })
  if (!response.ok) {
    throw new Error(`HA ${wholeDomain}/${turnOn ? 'turn_on' : 'turn_off'} -> ${response.status}`)
  }
}

async function currentState (config: { token: string, url: string }, entityId: string): Promise<string | undefined> {
  const response = await haFetch(config, `/api/states/${entityId}`)
  if (!response.ok) return undefined
  return (await response.json() as HaEntity).state
}

// «Чайник уже включён», «Люстра уже выключена» — nominative + gender agreement.
function alreadyText (label: string, desired: 'on' | 'off'): string {
  const nominative = label.endsWith('у') ? `${label.slice(0, -1)}а` : label
  const feminine = nominative.endsWith('а') || nominative.endsWith('я')
  const participle = desired === 'on' ? (feminine ? 'включена' : 'включен') : (feminine ? 'выключена' : 'выключен')
  const subject = nominative[0].toUpperCase() + nominative.slice(1)
  return `${subject} уже ${participle}.`
}

function buildStateReport (reg: HaRegistry): string {
  const on: string[] = []
  for (const [entityId, entity] of reg.entities) {
    if (!entityId.startsWith('light.') || JUNK_LIGHT.test(entityId)) continue
    if (entity.state !== 'on') continue
    const area = entityArea(reg, entityId)?.toLowerCase()
    const name = entity.attributes.friendly_name?.toLowerCase() ?? entityId
    on.push(area && !name.includes(area.slice(0, 5)) ? `${name} в ${area}` : name)
  }
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
  if (on.length === 0) return 'Сейчас ничего не включено.'
  return `Сейчас включено: ${on.join(', ')}.`
}

// Executes a device intent against HA. Silent on success (owner request);
// spoken reply only when the answer carries information (already / error).
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

  logger.info(`Fast intent executed: ${device.kind} [${device.targets.join(', ') || device.wholeDomain}]`)
  return { kind: 'reply', quasarDirectives: [], text: null }
}

// Handles the answer to a pending «Свет или музыку?» question.
function resolveClarification (tokens: string[]): 'home' | 'llm' | null {
  if (tokens.some(token => ['свет', 'света', 'свету', 'лампа', 'лампу'].includes(token))) return 'home'
  if (tokens.some(token => token.startsWith('музык'))) return 'llm'
  return null
}

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
        if (answer === 'home') {
          rememberAmbiguity(pending.phrase, 'home')
          return await executeDeviceIntent(config, pending.device)
        }
        if (answer === 'llm') {
          rememberAmbiguity(pending.phrase, 'llm')
          // Route the ORIGINAL phrase to the brain, not the one-word answer.
          return { kind: 'llm', text: pending.phrase }
        }
        // Neither: fall through and match the new phrase normally.
      }
    }

    const volume = matchVolume(s, tokens)
    if (volume !== null) {
      const reg = await getRegistry(config)
      if (volume.kind === 'query') {
        const level = reg.entities.get(STATION_MEDIA_PLAYER)?.attributes.volume_level
        return {
          kind: 'reply',
          quasarDirectives: [],
          text: typeof level === 'number' ? `Громкость ${Math.round(level * 100)} процентов.` : 'Не знаю текущую громкость.'
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

    if (/(что|чего).{0,10}(включен|горит|работает)|что сейчас активно|состояние дома/.test(s)) {
      const reg = await getRegistry(config, true)
      return { kind: 'reply', quasarDirectives: [], text: buildStateReport(reg) }
    }

    const reg = await getRegistry(config)
    const device = resolveDeviceIntent(s, tokens, reg)
    if (device === null) return null

    // Ambiguous on-command (entity noun may also mean music): ask once,
    // then always use the remembered resolution for this exact phrase.
    if (device.kind === 'on' && AMBIGUOUS_LABELS.includes(device.label)) {
      const remembered = loadAmbiguityMemory()[s]
      if (remembered === 'home') {
        return await executeDeviceIntent(config, device)
      }
      if (remembered === 'llm') {
        return { kind: 'llm', text: s }
      }
      pendingClarification = { device, expiresAt: Date.now() + AMBIGUITY_TTL_MS, phrase: s }
      return { kind: 'reply', quasarDirectives: [], text: 'Свет или музыку?' }
    }

    return await executeDeviceIntent(config, device)
  } catch (error) {
    logger.error(`Fast intent '${s}' failed:`, error)
    return { kind: 'reply', quasarDirectives: [], text: 'Не удалось выполнить команду умного дома.' }
  }
}

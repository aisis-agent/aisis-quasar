// Voice control of the dashboard settings.
//
// The dashboard (dashboard.py :8781) owns ONE declarative registry of every setting
// (id, title, type, options, range, risk, voice names…); the web UI and this module are
// both generated from it. Here:
//
//   client     getSettings() — cached registry, refreshed in the background (never blocks a
//              turn, stale-while-error, empty and silent when it was never loaded);
//              getValue()/postValue() — live GET / POST with via:'voice'.
//   templates  settingTemplates() — one catalog Template per voice-enabled entry
//              (bool «включи X», number «поставь X 20», enum «голос Алиса», clock
//              «начало тихих часов 23:00», action «перезагрузи колонку»); the scoring,
//              clarify and confirm machinery is intent-catalog.ts's, nothing is re-invented.
//   queries    matchSettingQuery() — «какой шаг громкости», «что с озвучкой».
//   phrases    the spoken value / confirmation / error wording.
//
// Risk classes: safe = execute + earcon; confirm = yes/no first (the entry's confirm_text);
// no-voice = say no_voice_text and change nothing. Secrets are never spoken or logged.
//
// Pure apart from the fetch calls (which use the global fetch at call time, so tests can mock it).

import { bestPhraseMatch, normalize, parseNumbers, tokenize, wordSimilarity } from './fuzzy-ru'
import type { Bound, SlotFill, Template, Utterance } from './intent-catalog'

// ── Registry model ───────────────────────────────────────────────────────────

export type SettingValue = boolean | number | string
export type SettingRisk = 'confirm' | 'no-voice' | 'safe'

export interface SettingOption {
  value: string
  label: string
  aliases: string[]
}

export interface SettingEntry {
  id: string
  title: string
  type: 'action' | 'bool' | 'enum' | 'number' | 'text'
  options: SettingOption[]
  min?: number
  max?: number
  step?: number
  unit?: string
  format?: string
  value: null | SettingValue
  risk: SettingRisk
  riskValues: Record<string, SettingRisk>
  confirmText?: string
  noVoiceText?: string
  names: string[]
  onNames: string[]
  mode: 'auto' | 'native' | 'off'
  secret: boolean
  writable: boolean
}

type Json = Record<string, unknown>

function isRecord (value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text (value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function finite (value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function strings (value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : []
}

function riskOf (value: unknown, fallback: SettingRisk): SettingRisk {
  return value === 'safe' || value === 'confirm' || value === 'no-voice' ? value : fallback
}

function parseEntry (raw: unknown): SettingEntry | null {
  if (!isRecord(raw)) return null
  const id = text(raw.id)
  const title = text(raw.title)
  const type = raw.type
  if (id === undefined || title === undefined) return null
  if (type !== 'action' && type !== 'bool' && type !== 'enum' && type !== 'number' && type !== 'text') return null
  const options: SettingOption[] = []
  if (Array.isArray(raw.options)) {
    for (const item of raw.options) {
      if (!isRecord(item)) continue
      const value = text(item.value)
      if (value === undefined) continue
      options.push({ aliases: strings(item.aliases), label: text(item.label) ?? value, value })
    }
  }
  const riskValues: Record<string, SettingRisk> = {}
  if (isRecord(raw.risk_values)) {
    for (const [key, risk] of Object.entries(raw.risk_values)) riskValues[key] = riskOf(risk, 'no-voice')
  }
  const voice = isRecord(raw.voice) ? raw.voice : {}
  const names = [...strings(voice.names), ...strings(voice.phrases)] // phrases: whole sayable commands («перезагрузи колонку»)
  const mode = voice.mode === 'native' || voice.mode === 'off' ? voice.mode : 'auto'
  const value = raw.value
  return {
    confirmText: text(raw.confirm_text),
    format: text(raw.format),
    id,
    max: finite(raw.max),
    min: finite(raw.min),
    mode,
    names: names.length > 0 ? names : [title],
    noVoiceText: text(raw.no_voice_text),
    onNames: strings(voice.on_names),
    options,
    // A missing risk is the most restrictive one: a malformed entry must never become silently writable by voice.
    risk: riskOf(raw.risk, 'no-voice'),
    riskValues,
    secret: raw.secret === true,
    step: finite(raw.step),
    title,
    type,
    unit: text(raw.unit),
    value: typeof value === 'boolean' || typeof value === 'string' || finite(value) !== undefined ? value as SettingValue : null,
    writable: raw.writable !== false
  }
}

// Accepts the GET /registry body ({ok, version, settings:[…]}) and the bare `--dump` list.
export function parseRegistry (body: unknown): SettingEntry[] | null {
  const list = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.settings) ? body.settings : null
  if (list === null) return null
  return list.map(parseEntry).filter((entry): entry is SettingEntry => entry !== null)
}

// ── Client ───────────────────────────────────────────────────────────────────

const DEFAULT_URL = 'http://127.0.0.1:8781/api/settings'
const REFRESH_INTERVAL_MS = 60_000
const RETRY_INTERVAL_MS = 5_000
const REFRESH_TIMEOUT_MS = 1500
const VALUE_TIMEOUT_MS = 1000
const POST_TIMEOUT_MS = 8000

let cache: SettingEntry[] = []
let loaded = false
let injected = false
let lastAttempt = 0
let inflight: Promise<boolean> | null = null
let timerStarted = false

function baseUrl (): string {
  return (process.env.AISIS_SETTINGS_URL ?? DEFAULT_URL).replace(/\/+$/, '')
}

// Fetches the registry now; false = failed (the cache is kept: stale-while-error).
export async function refreshSettings (): Promise<boolean> {
  if (injected) return true
  if (inflight !== null) return await inflight
  lastAttempt = Date.now()
  inflight = (async () => {
    try {
      const response = await fetch(`${baseUrl()}/registry`, { signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) })
      if (!response.ok) return false
      const body: unknown = await response.json()
      const parsed = parseRegistry(body)
      if (parsed === null || injected) return false
      cache = parsed
      loaded = true
      return true
    } catch {
      return false
    } finally {
      inflight = null
    }
  })()
  return await inflight
}

function refreshIfDue (): void {
  if (injected || inflight !== null) return
  if (Date.now() - lastAttempt >= (loaded ? REFRESH_INTERVAL_MS : RETRY_INTERVAL_MS)) void refreshSettings()
}

// The cached registry, synchronously. The first use starts the background refresh; until it
// lands (or when the dashboard is down) the list is empty and every setting phrase falls through.
export function getSettings (): readonly SettingEntry[] {
  if (!injected) {
    refreshIfDue()
    if (!timerStarted) {
      timerStarted = true
      setInterval(refreshIfDue, REFRESH_INTERVAL_MS).unref()
    }
  }
  return cache
}

// Test/corpus hook: a fixed registry, no network. null restores the live client.
export function injectSettings (entries: readonly SettingEntry[] | null): void {
  injected = entries !== null
  cache = entries === null ? [] : [...entries]
  loaded = entries !== null
  lastAttempt = 0
}

export function findSetting (id: string): SettingEntry | undefined {
  return cache.find(entry => entry.id === id)
}

export type ValueResult = { ok: true, value: null | SettingValue } | { ok: false, err: string }

function plainValue (value: unknown): null | SettingValue {
  return typeof value === 'boolean' || typeof value === 'string' || finite(value) !== undefined ? value as SettingValue : null
}

// Live value of one setting (cheap GET, 1 s).
export async function getValue (id: string): Promise<ValueResult> {
  try {
    const response = await fetch(`${baseUrl()}/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(VALUE_TIMEOUT_MS) })
    const body: unknown = await response.json()
    if (!response.ok || !isRecord(body)) return { err: 'недоступно', ok: false }
    if (body.ok !== true) return { err: text(body.err) ?? 'ошибка', ok: false }
    return { ok: true, value: plainValue(body.value) }
  } catch {
    return { err: 'недоступно', ok: false }
  }
}

export type PostResult = { ok: true, value: null | SettingValue } | { ok: false, err: string }

// Applies a voice change. `confirmed` is true only after the owner's «да».
export async function postValue (id: string, value: SettingValue, options: { confirmed?: boolean } = {}): Promise<PostResult> {
  try {
    const response = await fetch(`${baseUrl()}/${encodeURIComponent(id)}`, {
      body: JSON.stringify({ confirmed: options.confirmed === true, value, via: 'voice' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(POST_TIMEOUT_MS)
    })
    const body: unknown = await response.json()
    if (!response.ok || !isRecord(body)) return { err: 'недоступно', ok: false }
    if (body.ok !== true) return { err: text(body.err) ?? 'ошибка', ok: false }
    return { ok: true, value: plainValue(body.value) }
  } catch {
    return { err: 'недоступно', ok: false }
  }
}

// ── Volume step ──────────────────────────────────────────────────────────────

export const VOLUME_STEP_ID = 'speaker.volume_step_pct'
export const DEFAULT_VOLUME_STEP_PCT = 30

// The configured step in percent of the full scale: live GET, else the cached registry value, else 30.
export async function volumeStepPct (): Promise<number> {
  const live = await getValue(VOLUME_STEP_ID)
  if (live.ok && typeof live.value === 'number' && live.value > 0) return live.value
  const cached = findSetting(VOLUME_STEP_ID)?.value
  return typeof cached === 'number' && cached > 0 ? cached : DEFAULT_VOLUME_STEP_PCT
}

// `steps` is the signed multiple of the configured step (+1 «громче», -2 «намного тише»). Speaker
// levels are 10% each; one step always moves at least one level, and never more than the whole scale.
export function volumeLevels (steps: number, stepPct: number): number {
  if (steps === 0) return 0
  return Math.sign(steps) * Math.max(1, Math.round(Math.min(100, Math.abs(steps) * stepPct) / 10))
}

// ── Wording ──────────────────────────────────────────────────────────────────

export const NO_VOICE_DEFAULT = 'Это настраивается в веб-интерфейсе.'

function capital (value: string): string {
  return value === '' ? value : value[0].toUpperCase() + value.slice(1)
}

function plural (value: number, forms: [string, string, string]): string {
  if (!Number.isInteger(value)) return forms[1]
  const mod100 = value % 100
  const mod10 = value % 10
  if (mod100 >= 11 && mod100 <= 14) return forms[2]
  if (mod10 === 1) return forms[0]
  if (mod10 >= 2 && mod10 <= 4) return forms[1]
  return forms[2]
}

const UNIT_FORMS: Record<string, [string, string, string]> = {
  '%': ['процент', 'процента', 'процентов'],
  c: ['секунда', 'секунды', 'секунд'],
  ch: ['час', 'часа', 'часов'],
  ч: ['час', 'часа', 'часов'],
  гц: ['герц', 'герца', 'герц'],
  дб: ['децибел', 'децибела', 'децибел'],
  мин: ['минута', 'минуты', 'минут'],
  мс: ['миллисекунда', 'миллисекунды', 'миллисекунд'],
  с: ['секунда', 'секунды', 'секунд'],
  сек: ['секунда', 'секунды', 'секунд']
}

// Stems of the words that name a unit: they ride along with a spoken number and carry no meaning.
const UNIT_STEMS: Record<string, string[]> = {
  '%': ['процент'],
  c: ['секунд', 'сек'],
  ч: ['час'],
  гц: ['герц', 'гц'],
  дб: ['децибел', 'дб'],
  мин: ['минут', 'мин'],
  мс: ['миллисекунд', 'мс'],
  с: ['секунд', 'сек'],
  сек: ['секунд', 'сек']
}

function spokenNumber (entry: SettingEntry, value: number): string {
  const digits = String(value).replace('.', ',')
  if (entry.unit === undefined) return digits
  const forms = UNIT_FORMS[entry.unit.toLowerCase()]
  return forms === undefined ? `${digits} ${entry.unit}` : `${digits} ${plural(value, forms)}`
}

export function formatClock (minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`
}

export function isClock (entry: SettingEntry): boolean {
  return entry.type === 'text' && entry.format === 'HH:MM'
}

// How a value is said aloud. Never a secret, never free text.
export function describeValue (entry: SettingEntry, value: null | SettingValue): string {
  if (entry.secret || value === null) return ''
  if (typeof value === 'boolean') return value ? 'включено' : 'выключено'
  if (typeof value === 'number') return spokenNumber(entry, value)
  if (entry.type === 'enum') return entry.options.find(option => option.value === value)?.label ?? ''
  return isClock(entry) ? value : ''
}

export function effectiveRisk (entry: SettingEntry, value: SettingValue): SettingRisk {
  if (entry.secret || !entry.writable) return 'no-voice'
  if (entry.type === 'text' && !isClock(entry)) return 'no-voice'
  const override = entry.riskValues[String(value)]
  return override ?? entry.risk
}

export function noVoiceText (entry: SettingEntry): string {
  return entry.noVoiceText ?? NO_VOICE_DEFAULT
}

export function confirmQuestion (entry: SettingEntry, value: SettingValue): string {
  const spoken = describeValue(entry, value)
  const template = entry.confirmText ?? `${capital(entry.title)}: ${spoken}. Подтвердить?`
  return template.replaceAll('{value}', spoken).replaceAll('{title}', entry.title)
}

// Weak-evidence yes/no for a safe setting: «Шаг громкости: 20 процентов?» (the title is a nominative noun).
export function weakQuestion (entry: SettingEntry, value: SettingValue): string {
  if (entry.type === 'action') return `Выполнить: ${entry.title}?`
  return `${capital(entry.title)}: ${entry.type === 'bool' ? (value === true ? 'включить' : 'выключить') : describeValue(entry, value)}?`
}

export function queryAnswer (entry: SettingEntry, value: null | SettingValue): string {
  const spoken = describeValue(entry, value)
  if (spoken === '') return `${capital(entry.title)}: ${entry.secret || entry.type === 'text' ? noVoiceText(entry) : 'значение неизвестно.'}`
  return `${capital(entry.title)}: ${spoken}.`
}

// One short confirmation phrase, only where the change is not otherwise perceivable: an enum
// choice (a voice, a tone) or an action. Bools, numbers and clocks answer with the earcon.
export function doneText (entry: SettingEntry, value: null | SettingValue): null | string {
  if (entry.type === 'action') return `Готово: ${entry.title}.`
  if (entry.type === 'enum') {
    const label = describeValue(entry, value)
    return label === '' ? 'Готово.' : `Готово: ${entry.title} — ${label}.`
  }
  return null
}

export function failureText (entry: SettingEntry | undefined, err: string): string {
  if (err === 'недоступно') return 'Настройки сейчас недоступны.'
  if (err === 'no-voice') return entry === undefined ? NO_VOICE_DEFAULT : noVoiceText(entry)
  if (err === 'confirm-required') return 'Нужно подтверждение, повтори команду.'
  // The server writes these without secrets; a long one is not read out.
  return err.length <= 80 ? `Не получилось: ${err}` : 'Не получилось изменить настройку.'
}

// ── Stems ────────────────────────────────────────────────────────────────────

const ENDINGS = ['ться', 'ится', 'ить', 'ать', 'ять', 'еть', 'уть', 'ыть', 'ами', 'ями', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими',
  'ией', 'ой', 'ей', 'ов', 'ом', 'ем', 'ых', 'их', 'ие', 'ые', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ую', 'юю', 'ам', 'ям', 'ах', 'ях',
  'ть', 'ь', 'й', 'а', 'я', 'у', 'ю', 'е', 'и', 'ы', 'о']
const STOP_WORDS = ['для', 'при', 'про', 'над', 'под', 'без', 'из', 'от', 'до', 'по', 'на', 'в', 'во', 'с', 'со', 'за', 'к', 'о', 'об', 'у', 'и', 'а']

// Crude stemmer: a name is matched as a stem, so the owner may say any case or number of it.
function stemWord (word: string): string {
  if (/[^а-я]/.test(word)) return word
  for (const ending of ENDINGS) {
    if (word.endsWith(ending) && word.length - ending.length >= 4) return word.slice(0, -ending.length)
  }
  return word
}

// «Тихие часы» → «тихи час»: stems joined by spaces, prepositions dropped.
export function stemPhrase (value: string): string {
  const words = tokenize(normalize(value))
  // «тихие часы с» / «тихие часы до»: a trailing «с»/«до» is what tells the two settings apart; any other preposition is noise.
  const keep = (word: string, index: number): boolean => !STOP_WORDS.includes(word) || words.length > 1 && index === words.length - 1 && (word === 'с' || word === 'до')
  return words.filter(keep).map(stemWord).join(' ')
}

function uniqueStems (values: string[]): string[] {
  return [...new Set(values.map(stemPhrase).filter(stem => stem !== ''))]
}

const nounMemo = new WeakMap<SettingEntry, string[]>()

function entryNouns (entry: SettingEntry): string[] {
  const known = nounMemo.get(entry)
  if (known !== undefined) return known
  const nouns = uniqueStems([entry.title, ...entry.names, ...entry.onNames])
  nounMemo.set(entry, nouns)
  return nouns
}

// ── Clock ────────────────────────────────────────────────────────────────────

const DAY_PARTS: Record<string, 'am' | 'night' | 'pm'> = {
  вечера: 'pm', вечером: 'pm', дня: 'pm', днем: 'pm', ночи: 'night', ночью: 'night', утра: 'am', утром: 'am'
}

export interface ClockMention {
  minutes: number
  start: number
  end: number
}

function toMinutes (hour: number, minute: number, part: 'am' | 'night' | 'pm' | undefined): number {
  let h = hour % 24
  if (part === 'pm' && h < 12) h += 12
  if (part === 'am' && h === 12) h = 0
  if (part === 'night') {
    if (h === 12) h = 0
    else if (h >= 6 && h <= 11) h += 12
  }
  return h * 60 + minute
}

// A time of day from the words: «23:00» (normalized to «23 00» / «23.00»), «в 8», «в одиннадцать вечера»,
// «в семь тридцать утра» is NOT parsed (the numeral parser would fuse the words), «в 7 30 утра» is.
export function parseClock (tokens: string[]): ClockMention | null {
  for (let i = 0; i < tokens.length; i++) {
    const glued = /^(\d{1,2})[.,](\d{2})$/.exec(tokens[i])
    if (glued !== null && Number(glued[1]) <= 24 && Number(glued[2]) < 60) {
      return { end: i + 1, minutes: toMinutes(Number(glued[1]), Number(glued[2]), undefined), start: i }
    }
  }
  const semi = tokens.findIndex(token => token === 'полдень' || token === 'полдня')
  if (semi >= 0) return { end: semi + 1, minutes: 12 * 60, start: semi }
  const midnight = tokens.findIndex(token => token === 'полночь')
  if (midnight >= 0) return { end: midnight + 1, minutes: 0, start: midnight }
  const mentions = parseNumbers(tokens, false)
  for (let m = 0; m < mentions.length; m++) {
    const hour = mentions[m]
    if (!Number.isInteger(hour.value) || hour.value < 0 || hour.value > 24) continue
    let end = hour.end
    let minute = 0
    const next = mentions[m + 1]
    if (next !== undefined && next.start === end && next.source === 'digits' && tokens[next.start].length === 2 && next.value < 60) {
      minute = next.value
      end = next.end
    } else {
      if (tokens[end]?.startsWith('час')) end++
      const after = mentions[m + 1]
      if (after !== undefined && after.start === end && Number.isInteger(after.value) && after.value < 60 && tokens[after.end]?.startsWith('минут')) {
        minute = after.value
        end = after.end + 1
      }
    }
    const part = tokens[end] === undefined ? undefined : DAY_PARTS[tokens[end]]
    if (part !== undefined) end++
    return { end, minutes: toMinutes(hour.value, minute, part), start: hour.start }
  }
  return null
}

// ── Templates ────────────────────────────────────────────────────────────────

// Unit words that may follow a spoken number («20 процентов», «500 миллисекунд»).
function unitContext (entry: SettingEntry): string[] {
  const unit = entry.unit?.toLowerCase()
  return unit === undefined ? [] : UNIT_STEMS[unit] ?? [stemPhrase(unit)]
}

const CLOCK_CONTEXT = ['час', 'минут', 'утра', 'утром', 'дня', 'вечер', 'ночи', 'ночью', 'полден', 'полноч']

// What a spoken value turns into: a change (asked first when its risk is `confirm`, or when the value
// had to be corrected: `forceAsk`), or — for a no-voice value — the pointer to the web UI. Never both.
function bound (entry: SettingEntry, value: SettingValue, choiceName: string, forceAsk = false): Bound {
  const risk = effectiveRisk(entry, value)
  if (risk === 'no-voice') return { choiceName, question: `Ты про ${entry.title}?`, resolved: { text: noVoiceText(entry), type: 'say' } }
  const ask = risk === 'confirm' || forceAsk
  const question = risk === 'confirm' ? confirmQuestion(entry, value) : weakQuestion(entry, value)
  return { ask, choiceName, question, resolved: ask ? { ask: question, id: entry.id, type: 'setting', value } : { id: entry.id, type: 'setting', value } }
}

function snapped (entry: SettingEntry, raw: number): number {
  const min = entry.min ?? Number.NEGATIVE_INFINITY
  const max = entry.max ?? Number.POSITIVE_INFINITY
  let value = Math.min(max, Math.max(min, raw))
  if (entry.step !== undefined && entry.step > 0) {
    const origin = entry.min ?? 0
    value = Math.min(max, Math.max(min, origin + Math.round((value - origin) / entry.step) * entry.step))
  }
  return Number(value.toFixed(6))
}

function baseTemplate (entry: SettingEntry): Pick<Template, 'auto' | 'context' | 'id' | 'name' | 'nouns' | 'units'> {
  return {
    auto: true,
    context: [],
    id: `setting.${entry.id}`,
    name: entry.title,
    nouns: entryNouns(entry).map(stem => ({ stem, weight: 1 })),
    units: []
  }
}

function voiceTemplate (entry: SettingEntry): Template | null {
  if (!entry.writable || entry.secret || entry.type === 'text' && !isClock(entry)) return noVoiceTemplate(entry)
  const base = baseTemplate(entry)
  if (entry.type === 'bool') {
    return {
      ...base,
      bind: (_u: Utterance, slot: SlotFill) => slot.verb === undefined ? null
        : bound(entry, slot.verb === 'on', `${slot.verb === 'on' ? 'включить' : 'выключить'} ${entry.title}`),
      slot: 'onoff',
      slotPrompt: () => `Включить или выключить ${entry.title}?`
    }
  }
  if (entry.type === 'number') {
    return {
      ...base,
      bind: (_u: Utterance, slot: SlotFill) => {
        if (slot.value === undefined) return null
        const value = snapped(entry, slot.value)
        return bound(entry, value, `${entry.title} ${describeValue(entry, value)}`, value !== slot.value)
      },
      clamp: true,
      context: unitContext(entry),
      range: [entry.min ?? -1e9, entry.max ?? 1e9],
      slot: 'number',
      slotPrompt: () => 'Какое значение поставить?'
    }
  }
  if (entry.type === 'enum') {
    if (entry.options.length === 0) return null
    return {
      ...base,
      bind: (_u: Utterance, slot: SlotFill) => {
        const option = entry.options.find(item => item.value === slot.choice)
        return option === undefined ? null : bound(entry, option.value, `${entry.title} ${option.label}`)
      },
      choices: entry.options.map(option => ({ phrases: uniqueStems([option.label, ...option.aliases]), value: option.value })),
      slot: 'enum',
      slotPrompt: () => 'Какой вариант выбрать?'
    }
  }
  if (entry.type === 'text') {
    return {
      ...base,
      bind: (_u: Utterance, slot: SlotFill) => slot.value === undefined ? null
        : bound(entry, formatClock(slot.value), `${entry.title} ${formatClock(slot.value)}`),
      context: CLOCK_CONTEXT,
      slot: 'clock',
      slotPrompt: () => 'Во сколько?'
    }
  }
  return {
    ...base,
    bind: () => bound(entry, true, entry.title),
    slot: 'none',
    slotPrompt: () => weakQuestion(entry, true)
  }
}

// Secrets, free text, read-only entries: the phrase is recognised (command verb + the name) so the
// owner gets the pointer to the web UI instead of a guess from the brain. Nothing is ever changed.
function noVoiceTemplate (entry: SettingEntry): Template {
  return {
    ...baseTemplate(entry),
    absorbRest: true,
    bind: () => ({ choiceName: entry.title, question: `Ты про ${entry.title}?`, resolved: { text: noVoiceText(entry), type: 'say' } }),
    needsCommandVerb: true,
    slot: 'none',
    slotPrompt: () => `Ты про ${entry.title}?`
  }
}

// Catalog templates for every voice-enabled entry. `native` entries (volume, mute) are served by the
// existing intents, `off` entries are never voiced. `reserved` are the noun stems of the built-in
// controls: a setting that names itself with the same single word («яркость» for the display light)
// would steal the built-in control's own phrase («яркость 50»), so that name is dropped and the setting
// is reached by its full name («яркость подсветки 50»). Built once per registry (every turn asks).
const templateMemo = new WeakMap<readonly SettingEntry[], Map<string, Template[]>>()

export function settingTemplates (entries: readonly SettingEntry[], reserved: readonly string[] = []): Template[] {
  const key = reserved.join('|')
  const memo = templateMemo.get(entries) ?? new Map<string, Template[]>()
  templateMemo.set(entries, memo)
  const known = memo.get(key)
  if (known !== undefined) return known
  const templates: Template[] = []
  const shadowed = (stem: string): boolean => !stem.includes(' ') && reserved.some(other => wordSimilarity(stem, other) >= 0.8 || wordSimilarity(other, stem) >= 0.8)
  for (const entry of entries) {
    if (entry.mode !== 'auto') continue
    const template = voiceTemplate(entry)
    if (template === null) continue
    template.nouns = template.nouns.filter(noun => !shadowed(noun.stem))
    if (template.nouns.length > 0) templates.push(template)
  }
  memo.set(key, templates)
  return templates
}

// ── Queries ──────────────────────────────────────────────────────────────────

const QUERY_WORDS = ['какой', 'какая', 'какие', 'какое', 'каком', 'какую', 'сколько', 'скажи', 'покажи', 'подскажи', 'узнай', 'проверь',
  'чему', 'что']
const QUERY_FILLERS = ['сейчас', 'теперь', 'у', 'тебя', 'на', 'в', 'с', 'со', 'стоит', 'установлен', 'установлена', 'установлено', 'выбран',
  'выбрана', 'выбрано', 'текущий', 'текущая', 'текущее', 'значение', 'настройка', 'настройки', 'алиса', 'яндекс', 'а', 'ну', 'пожалуйста', 'мне',
  'там', 'тут', 'вообще', 'равен', 'равна', 'равно', 'сделан', 'сделано', 'включен', 'включена', 'включено', 'выключен', 'выключена', 'выключено',
  'ли', 'сегодня', 'нынче', 'скажи', 'колонке', 'колонки', 'моей', 'моем', 'мое']
const COMMAND_STEMS = ['постав', 'сдела', 'установ', 'измени', 'смени', 'поменя', 'включи', 'выключи', 'отключи', 'вруби', 'выруби', 'настрои', 'задай', 'выстав']

function startsWithAny (token: string, stems: string[]): boolean {
  return stems.some(stem => token.startsWith(stem))
}

export function hasCommandVerb (tokens: string[]): boolean {
  return tokens.some(token => startsWithAny(token, COMMAND_STEMS))
}

// «какая озвучка сейчас», «какой шаг громкости», «что с тихими часами»: exactly one setting, nothing else said.
export function matchSettingQuery (normalized: string, entries: readonly SettingEntry[]): SettingEntry | null {
  const tokens = tokenize(normalized)
  if (tokens.length === 0 || tokens.length > 8) return null
  if (!tokens.some(token => QUERY_WORDS.includes(token)) || hasCommandVerb(tokens)) return null
  const scored: { entry: SettingEntry, score: number, span: number[] }[] = []
  for (const entry of entries) {
    if (entry.mode !== 'auto') continue
    let best = { score: 0, span: [] as number[] }
    for (const stem of entryNouns(entry)) {
      const match = bestPhraseMatch(tokens, stem)
      if (match.score > best.score) best = match
    }
    if (best.score >= 0.85) scored.push({ entry, ...best })
  }
  scored.sort((a, b) => b.score - a.score || b.span.length - a.span.length)
  const top = scored[0]
  if (top === undefined) return null
  const rival = scored.find(item => item.entry !== top.entry)
  if (rival !== undefined && (rival.score > top.score - 0.1 && rival.span.length >= top.span.length)) return null
  const explained = new Set(top.span)
  const stray = tokens.filter((token, index) => !explained.has(index) && !QUERY_WORDS.includes(token) && !QUERY_FILLERS.includes(token))
  return stray.length === 0 ? top.entry : null
}

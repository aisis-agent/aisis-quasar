// Filler phrases: short pre-recorded replies spoken while a slow answer (LLM
// brain, HA registry refresh, music search) is still being prepared. Audio is
// synthesized once per voice by gen_fillers.py on the host and mounted at
// /src/fillers (see compose volume); this module only reads files.
//
// Which phrase fits is decided per turn, never on the answer's critical path:
//   math    → «Считаю»      instant calc; spoken only if the answer is >LATE_FILLER_MS late
//   state   → «Проверяю»    smart-home state read
//   ha_down → «Умный дом просыпается…»  state read while Home Assistant does not answer
//   llm     → «Думаю/Минутку»  open question for the brain
//   music   → «Секунду, ищу»   catalog search; spoken only if >LATE_FILLER_MS late
// Fast on/off commands get no filler. Laya (via the adapter /laya endpoint) may refine
// state vs llm but only within FILLER_LAYA_BUDGET_MS; past it the deterministic rules
// below decide, so a slow or dead laya never delays a filler or an answer.

import { readFileSync, statSync } from 'node:fs'
import { getLogger } from '../logger'
import { parseEndDialog } from './end-dialog'
import { haBaseUrl } from './ha-connection'
import { parseMusicIntent } from './music-parse'
import { DOMAIN_QUESTION } from './semantic-shadow'

const logger = getLogger()

export type FillerCategory = 'ha_down' | 'llm' | 'math' | 'music' | 'state'

interface FillerIndex {
  [category: string]: { text: string, file: string }[]
}

export interface Filler {
  category: FillerCategory
  text: string
  audio: Buffer
}

// What to say for a turn: `immediate` right away, else `late` only if the answer
// is still missing after the caller's delay. Both null: stay silent.
export interface FillerPlan {
  immediate: FillerCategory | null
  late: FillerCategory | null
}

const FILLER_DIR = '/src/fillers'
const MIN_GAP_MS = 8000
const LAYA_URL = process.env.AISIS_ADAPTER_LAYA_URL ?? 'http://127.0.0.1:31117/laya'
const LAYA_BUDGET_MS = Number(process.env.FILLER_LAYA_BUDGET_MS ?? 300)
const HA_HEALTH_POLL_MS = 10_000

// Requests answered in <1s by the fast local layer: no filler.
const FAST_COMMAND = /(включ|выключ|отключ|зажг|погас|потуши|вруб|выруб|громкость|тише|громче)/
// Instant local computation: «Считаю» only when it is late.
const MATH_WORDS = /(плюс|минус|умнож|делен|раздели|сколько будет|корень|степен)/
// Smart-home state reads: registry may need a refresh -> «Проверяю».
const STATE_QUERY = /(включен|горит|работает|состояние|температур|влажност|что играет|что сейчас активно|какой свет)/

const PLAN_NONE: FillerPlan = { immediate: null, late: null }
const PLAN_STATE: FillerPlan = { immediate: 'state', late: null }
const PLAN_LLM: FillerPlan = { immediate: 'llm', late: null }

// Laya domain (semantic-shadow DOMAIN_QUESTION) → plan, consulted only for turns the
// rules would give an immediate filler.
const LAYA_PLAN: Record<string, FillerPlan> = {
  ambiguous: PLAN_LLM,
  climate: PLAN_STATE,
  comms: PLAN_LLM,
  edge: PLAN_LLM,
  light: { immediate: null, late: 'state' },
  math: { immediate: null, late: 'math' },
  media_control: { immediate: null, late: 'state' },
  media_device: PLAN_LLM,
  music: { immediate: null, late: 'music' },
  question: PLAN_LLM,
  smalltalk: PLAN_LLM,
  socket: { immediate: null, late: 'state' },
  state: PLAN_STATE,
  timer: { immediate: null, late: 'state' },
  typo: PLAN_LLM,
  unknown_device: PLAN_LLM,
  volume: { immediate: null, late: 'state' },
  weather_time: PLAN_LLM
}

let index: FillerIndex | null = null
let indexMtimeMs = 0
const audioCache = new Map<string, Buffer>()
let lastPlayedAt = 0
let haDown = false
let haPollStarted = false

/** Deterministic classification: instant, no I/O. The fallback for every other path. */
export function ruleClassify (rawText: string): FillerPlan {
  const text = rawText.toLowerCase().replace(/ё/g, 'е')
  // «ничего», «хватит», «спасибо»: the turn ends in silence, a «Думаю» over it would be the chatter we avoid.
  if (parseEndDialog(rawText) !== null) return PLAN_NONE
  if (parseMusicIntent(rawText) !== null) return { immediate: null, late: 'music' }
  // Before FAST_COMMAND: «что сейчас включено» contains «включ» but is a state read.
  if (STATE_QUERY.test(text)) return PLAN_STATE
  if (FAST_COMMAND.test(text)) return PLAN_NONE
  if (MATH_WORDS.test(text)) return { immediate: null, late: 'math' }
  if (/\d/.test(text)) return PLAN_NONE
  return PLAN_LLM
}

interface LayaDomainAnswer {
  action?: { act_probability?: number }
  choice?: string
}

// Laya's verdict as a plan, or null on timeout/error/abstain/unknown domain.
async function layaPlan (rawText: string): Promise<FillerPlan | null> {
  try {
    const res = await fetch(LAYA_URL, {
      body: JSON.stringify({ message: rawText, questions: { domain: DOMAIN_QUESTION } }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(LAYA_BUDGET_MS)
    })
    if (!res.ok) return null
    const data = await res.json() as { ok?: boolean, result?: { answers?: Record<string, LayaDomainAnswer> } }
    const answer = data.result?.answers?.domain
    if (data.ok !== true || answer?.choice === undefined) return null
    if ((answer.action?.act_probability ?? 1) < 0.5) return null
    return LAYA_PLAN[answer.choice] ?? null
  } catch {
    return null
  }
}

/**
 * Home Assistant answers GET /auth/providers (no credentials) whenever it is up: any status below 500 within 2 s is «up»;
 * a refused/unreachable connection, a timeout or a 5xx is «down». Without a connection store the layer is disabled and there is
 * nothing to be down. Exported for the checks; production starts it once through classifyForFiller.
 */
export async function pollHaHealth (): Promise<void> {
  const base = haBaseUrl()
  if (base === null) {
    haDown = false
    return
  }
  try {
    const res = await fetch(`${base}/auth/providers`, { signal: AbortSignal.timeout(2000) })
    await res.body?.cancel()
    haDown = res.status >= 500
  } catch {
    haDown = true
  }
}

// Home Assistant's health is polled in the background so classification never waits for it.
function ensureHaHealthPoll (): void {
  if (haPollStarted) return
  haPollStarted = true
  void pollHaHealth()
  setInterval(() => void pollHaHealth(), HA_HEALTH_POLL_MS).unref()
}

/** Rules first; laya may refine state vs llm within its budget; HA-down swaps «Проверяю». */
export async function classifyForFiller (rawText: string): Promise<FillerPlan> {
  ensureHaHealthPoll()
  let plan = ruleClassify(rawText)
  if (plan.immediate !== null) plan = await layaPlan(rawText) ?? plan
  if (plan.immediate === 'state' && haDown) return { immediate: 'ha_down', late: null }
  return plan
}

function getIndex (): FillerIndex {
  const file = `${FILLER_DIR}/index.json`
  try {
    // gen_fillers.py re-runs on a voice change: follow index.json without a restart.
    const mtimeMs = statSync(file).mtimeMs
    if (index === null || mtimeMs !== indexMtimeMs) {
      index = JSON.parse(readFileSync(file, 'utf8')) as FillerIndex
      indexMtimeMs = mtimeMs
      audioCache.clear()
    }
  } catch {
    if (index === null) {
      logger.warn('Filler index not available at /src/fillers/index.json')
      index = {}
    }
  }
  return index ?? {}
}

function loadAudio (file: string): Buffer | null {
  const cached = audioCache.get(file)
  if (cached !== undefined) return cached
  try {
    const audio = readFileSync(`${FILLER_DIR}/${file}`)
    audioCache.set(file, audio)
    return audio
  } catch {
    return null
  }
}

// Random variant of a category; null when throttled (one filler per MIN_GAP_MS) or absent.
export function pickFiller (category: FillerCategory): Filler | null {
  if (Date.now() - lastPlayedAt < MIN_GAP_MS) return null
  const variants = getIndex()[category]
  if (variants === undefined || variants.length === 0) return null
  const variant = variants[Math.floor(Math.random() * variants.length)]!
  const audio = loadAudio(variant.file)
  if (audio === null) return null
  lastPlayedAt = Date.now()
  return { audio, category, text: variant.text }
}

export interface TurnFiller {
  // The answer is ready: drop a pending decision/late timer, wait for a filler already being sent.
  settle: () => Promise<void>
}

/**
 * Speaks the fitting filler for one turn concurrently with answer preparation.
 * `send` puts the audio on the wire; `lateMs` is the grace before a `late` filler.
 * Call settle() before sending the answer so the filler always precedes it and a
 * not-yet-decided filler never delays a fast answer.
 */
export function startTurnFiller (rawText: string, send: (filler: Filler) => Promise<void>, lateMs: number): TurnFiller {
  let timer: NodeJS.Timeout | undefined
  const { promise: cancelled, resolve: cancel } = Promise.withResolvers<void>()

  const deliver = async (category: FillerCategory): Promise<void> => {
    const filler = pickFiller(category)
    if (filler === null) return
    try {
      await send(filler)
      logger.info(`Filler ${filler.category} '${filler.text}' (${filler.audio.length}b) sent`)
    } catch (error) {
      logger.warn('Failed to send filler TTS: ', error)
    }
  }

  const run = async (): Promise<void> => {
    const plan = await Promise.race([classifyForFiller(rawText), cancelled.then(() => null)])
    if (plan === null) return
    if (plan.immediate !== null) {
      await deliver(plan.immediate)
      return
    }
    if (plan.late === null) return
    const late = plan.late
    const elapsed = Promise.withResolvers<boolean>()
    timer = setTimeout(() => { elapsed.resolve(true) }, lateMs)
    if (await Promise.race([elapsed.promise, cancelled.then(() => false)])) await deliver(late)
  }

  const running = run()
  return {
    settle: async () => {
      cancel()
      clearTimeout(timer)
      await running
    }
  }
}

// Test hook for mock verification.
export function resetFillerState (): void {
  lastPlayedAt = 0
  audioCache.clear()
  index = null
  haDown = false
  haPollStarted = false
}

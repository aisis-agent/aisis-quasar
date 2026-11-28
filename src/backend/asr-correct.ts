// Post-ASR correction client (adapter /asr/correct; logic, prompt and thresholds: backend/yandex/asr_correct.py).
// The speaker is heard from across the room and the start/end of a phrase may be cut off, so a short phrase the
// fast-intent layer could not decide on («ключи свет», «…ставь таймер на пять минут») gets one cheap LLM guess at
// what was meant. The guess is only acted on above the adapter's confidence threshold, and then it is routed
// through the SAME fast-intent tiers as spoken text: a correction can never skip a confirm/clarify rule.
// ASR_CORRECT=on|shadow|off (default on). shadow: call and log, never act. Clear commands never reach this file:
// execute/answer/query/math decisions are not eligible, so they pay no latency. Neither is the clarify tier («Громкость.»):
// that question is asked at once, and waiting ~850 ms for a corrector that times out only delayed it.
import { getLogger } from '../logger'
import { rememberFor } from './turn-memory'

const logger = getLogger()

const MODE = (process.env.ASR_CORRECT ?? 'on').toLowerCase()
const ADAPTER_ASR_URL = process.env.AISIS_ADAPTER_ASR_URL ?? 'http://127.0.0.1:31117/asr/correct'
// Adapter's own budget is 750 ms (haiku answers in ~550-700 ms); this one only guards a hung connection.
const TIMEOUT_MS = 850
export const MAX_TOKENS = 6
// Every question the speaker asks aloud is short (ClarifyFix contract, checked by the corpus runner).
const MAX_QUESTION_WORDS = 6
// A well-formed question is the brain's job and is not helped by a repair; waiting would only delay the answer.
const QUESTION_START = /^(что|как|какой|какая|какое|какие|сколько|когда|где|куда|откуда|почему|зачем|кто|чей|расскажи|объясни|скажи|переведи|посчитай)(\s|$)/
const ELIGIBLE_TIERS: Record<string, true | undefined> = { confirm: true, llm: true, reprompt: true }
const SPOKEN_CONTEXT_MS = 30_000
const MAX_CONTEXT_TURNS = 2

export type CorrectionMode = 'act' | 'confirm' | 'ignore'

export interface Correction {
  changed: boolean
  confidence: number
  intent: string
  mode: CorrectionMode
  ms: number
  status: string
  text: string
}

// What each station was last asked: the next phrase of THAT station may be its answer; another speaker's «давай» is not.
const lastAsked = new Map<string, { at: number, text: string }>()

/** The speaker `station` asked the owner something (confirm / clarify / «не расслышала»): its next phrase may be the answer. */
export function noteAsked (text: string, station: string, now = Date.now()): void {
  rememberFor(lastAsked, station, { at: now, text })
}

/** The owner dismissed the question of `station` («ничего», «хватит»): what is said next is not its answer. */
export function forgetAsked (station: string): void {
  lastAsked.delete(station)
}

/** The Home Assistant the speakers talk to changed: no station's last question is the context of what is said next. */
export function forgetAllAsked (): void {
  lastAsked.clear()
}

export function recentTurns (station: string, now = Date.now()): Array<{ role: 'assistant' | 'user', text: string }> {
  const asked = lastAsked.get(station)
  if (asked === undefined || now - asked.at > SPOKEN_CONTEXT_MS) return []
  return [{ role: 'assistant' as const, text: asked.text }].slice(-MAX_CONTEXT_TURNS)
}

// «Алиса, громкость 5»: the wake word opens the phrase and is neither a word of the command nor a reason to skip it.
const WAKE_WORD = /^\s*(?:алиса|яндекс)(?![а-яё])[\s,.!:-]*/i

export function stripWakeWord (text: string): string {
  return text.replace(WAKE_WORD, '').trim()
}

export function wordCount (text: string): number {
  return stripWakeWord(text).split(/\s+/).filter(Boolean).length
}

// A phrase cannot end on one of these: the word that followed (the room, the device) was cut off.
const DANGLING = /^(в|во|на|по|у|к|ко|с|со|для|из|от|до|за|над|под|при|про)$/

export function endsMidPhrase (tokens: string[]): boolean {
  return tokens.length >= 2 && DANGLING.test(tokens[tokens.length - 1])
}

/** A phrase worth repairing: undecided by the fast layer, short, and not a plain question. */
export function eligible (text: string, tier: string): boolean {
  if (MODE === 'off' || ELIGIBLE_TIERS[tier] !== true) return false
  const words = wordCount(text)
  if (words === 0 || words > MAX_TOKENS) return false
  return !QUESTION_START.test(stripWakeWord(text).toLowerCase().replace(/ё/g, 'е'))
}

// Noise (a TV, a conversation in the room) reaches the no-match tier too: cap the model calls so it cannot run up a bill.
const CALLS_PER_MINUTE = 10
let calls: number[] = []

export function allowCorrection (now = Date.now()): boolean {
  calls = calls.filter(at => now - at < 60_000)
  if (calls.length >= CALLS_PER_MINUTE) return false
  calls.push(now)
  return true
}

export function shadowOnly (): boolean {
  return MODE === 'shadow'
}

/** null on any failure (timeout, adapter down, bad reply): the caller then behaves exactly as without correction. */
export async function requestCorrection (text: string, station: string, fetchImpl: typeof fetch = fetch): Promise<Correction | null> {
  const started = Date.now()
  try {
    const response = await fetchImpl(ADAPTER_ASR_URL, {
      body: JSON.stringify({ recent: recentTurns(station), source: 'quasar', text }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    if (!response.ok) {
      logger.warn(`ASR correction http ${response.status} for '${text}'`)
      return null
    }
    const data = await response.json() as Partial<Correction>
    if (typeof data.text !== 'string' || typeof data.confidence !== 'number') return null
    const mode = data.mode === 'act' || data.mode === 'confirm' ? data.mode : 'ignore'
    return { changed: data.changed === true, confidence: data.confidence, intent: String(data.intent ?? 'unclear'), mode,
      ms: Date.now() - started, status: String(data.status ?? ''), text: data.text }
  } catch (error) {
    logger.warn(`ASR correction failed for '${text}' after ${Date.now() - started}ms: ${String(error)}`)
    return null
  }
}

/** «Включи свет», верно? Gender-neutral, one shape for every command; null when it would run past six spoken words. */
export function confirmationQuestion (corrected: string): null | string {
  const phrase = stripWakeWord(corrected).replace(/[.!?]+$/, '').trim()
  if (phrase === '') return null
  const question = `«${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}», верно?`
  return question.split(/\s+/).length <= MAX_QUESTION_WORDS ? question : null
}

/** One log line the dialog store parses (dialogstore.py: «ASR corrected») and the dashboard shows. */
export function describeCorrection (raw: string, correction: Correction, mode: CorrectionMode): string {
  const what = mode === 'act' ? 'corrected' : mode === 'confirm' ? 'correction to confirm' : 'correction ignored'
  return `ASR ${what} '${raw}' -> '${correction.text}' ` +
    `(conf ${correction.confidence.toFixed(2)}, ${correction.intent}, ${correction.status}, ${correction.ms} ms)`
}

// Short-term memory of what this process just said and did, for the fast-intent layer.
//
// «Алиса, повтори» used to reach the LLM brain, which knew nothing of the fast turn before it (weather,
// a light command) and answered with a clarifying question. The fast layer now keeps the last few turns
// (heard, spoken answer, executed command) and resolves «повтори / ещё раз / то же самое / прошлая
// команда» itself, and «а на кухне?» as the previous command aimed at another room.
//
// Process-level on purpose, like the pending clarification: a speaker reconnecting (every dialog opens a
// fresh websocket) must not lose it. A restart starts empty; the brain then gets the same recent dialogs
// from the adapter's dialog store (dialog_context.py) and repeats from there.

import type { Resolved } from './intent-catalog'

export type TurnOrigin = 'text' | 'voice'

export interface ActionRecord {
  phrase: string // the normalized phrase that produced it (anaphora rewrites it)
  resolved: Resolved
}

export interface Turn {
  action: ActionRecord | null // silent, successfully executed command
  asked: boolean // the spoken text is a question: the mic stayed open for the answer
  at: number
  heard: string
  origin: TurnOrigin
  spoken: null | string // what the speaker said aloud; null for a silent turn
}

export type RepeatTarget = 'answer' | 'any' | 'command'

const RING_SIZE = 8
// Older than this, «повтори» is no longer about the last turn: let the brain (with its dialog list) decide.
export const REPEAT_TTL_MS = 10 * 60_000
export const ANAPHORA_TTL_MS = 3 * 60_000

const turns: Turn[] = []

export function recordTurn (turn: Turn): void {
  turns.push(turn)
  if (turns.length > RING_SIZE) turns.shift()
}

export function resetTurns (): void {
  turns.length = 0
}

// The speaker's owner talks to it by voice; TextInput turns are also what an agent or the dashboard injects.
// A voice turn therefore wins, and a text turn is only used when no voice turn is recent enough.
function newestFirst (now: number): Turn[] {
  return turns.filter(turn => now - turn.at <= REPEAT_TTL_MS).reverse()
}

function matches (turn: Turn, want: RepeatTarget): boolean {
  if (want === 'answer') return turn.spoken !== null
  if (want === 'command') return turn.action !== null
  return turn.spoken !== null || turn.action !== null
}

export function latestTurn (want: RepeatTarget, now = Date.now()): null | Turn {
  const recent = newestFirst(now)
  return recent.find(turn => turn.origin === 'voice' && matches(turn, want)) ?? recent.find(turn => matches(turn, want)) ?? null
}

// The last executed command, for anaphora («а на кухне?»): shorter memory than a repeat.
export function latestAction (now = Date.now()): ActionRecord | null {
  const recent = turns.filter(turn => now - turn.at <= ANAPHORA_TTL_MS).reverse()
  return (recent.find(turn => turn.origin === 'voice' && turn.action !== null) ?? recent.find(turn => turn.action !== null))?.action ?? null
}

const POLITE = new Set(['алиса', 'пожалуйста', 'ну', 'давай', 'можешь', 'а', 'и'])

const ANSWER_RE = [
  /^повтори(ть)? (свой |твой |последний |прошлый |предыдущий )*(ответ|слова)( еще раз)?$/,
  /^что (ты )?(сказал[аи]?|говорил[аи]?|ответил[аи]?)( только что| сейчас)?$/,
  /^что что$/,
  /^(я )?не расслышал[аи]?( что ты сказал[аи]?)?$/
]
const COMMAND_RE = [
  /^(повтори(ть)?|выполни|сделай) (последнюю |прошлую |предыдущую |ту же )?команду( еще раз)?$/,
  /^(повтори(ть)?|выполни|сделай) (то же|еще раз) (самое )?(действие|команду)$/
]
const ANY_RE = [
  /^повтори(ть|те)?( еще раз| снова| опять| последнее| прошлое| то же самое)?$/,
  /^еще раз$/,
  /^(сделай )?(то же самое|тоже самое|так же|как в прошлый раз)( еще раз)?$/,
  /^(сделай )?(еще раз|снова|опять)$/,
  /^повтори(ть)? (прошлую|последнюю|предыдущую)$/
]

// «Алиса, повтори.» -> 'any'; «повтори прошлую команду» -> 'command'; «что ты сказала» -> 'answer'.
// `tokens` are the already normalized, punctuation-free words of the phrase.
export function parseRepeat (tokens: string[]): null | RepeatTarget {
  const words = tokens.filter(token => !POLITE.has(token))
  const phrase = words.join(' ')
  if (phrase === '') return null
  if (COMMAND_RE.some(re => re.test(phrase))) return 'command'
  if (ANSWER_RE.some(re => re.test(phrase))) return 'answer'
  if (ANY_RE.some(re => re.test(phrase))) return 'any'
  return null
}

// The answer to a question («да» to «Повторить что?») came back from the STT gateway as noise-like text it distrusts
// (a lone «Спасибо.» for a 0.2 s «да»): ask once more instead of ending the dialog without a word. Silence (nobody
// answered), a hallucination on silence and a foreign voice stay silent, and the re-ask happens at most once per
// dialog, so noise cannot start a «не расслышала» loop.
export const REASK_TEXT = 'Не расслышала. Скажи ещё раз.'
const REASK_REASONS = ['weak_filler', 'repetition', 'too_many_words']

export function shouldReask (rejected: string, answeringQuestion: boolean, alreadyReasked: boolean): boolean {
  return answeringQuestion && !alreadyReasked && REASK_REASONS.includes(rejected)
}

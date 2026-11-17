// Semantic-intents shadow layer (spec: backend/yandex/semantic-intents-spec.md §5, §8).
// SEMANTIC_INTENTS=off|shadow|on (default: shadow). In shadow mode laya is only
// CALLED and its verdict LOGGED — it never executes anything and never changes
// the fast-intent decision. Fire-and-forget: caller latency is unaffected.
import { getLogger } from '../logger'

const logger = getLogger()

const MODE = (process.env.SEMANTIC_INTENTS ?? 'shadow').toLowerCase()
const ADAPTER_LAYA_URL = process.env.AISIS_ADAPTER_LAYA_URL ?? 'http://127.0.0.1:31117/laya'
const LAYA_TIMEOUT_MS = 5000

export const DOMAIN_QUESTION = {
  type: 'choice',
  instructions: 'Классифицируй русскую голосовую команду умной колонки по домену устройств/действий',
  criteria: {
    light: 'свет, люстра, лампа, включить/выключить/яркость освещения',
    volume: 'громкость: громче, тише, прибавь звук',
    math: 'арифметика: сколько будет, сложить, умножить',
    state: 'состояние устройств: что включено, где горит свет, статус',
    timer: 'таймеры, будильники, напоминания, разбуди',
    question: 'общие вопросы: почему, когда, что такое',
    climate: 'кондиционер, обогреватель, температура, тепло, холодно',
    weather_time: 'погода, который час, время',
    music: 'включить музыку, трек, исполнителя, радио',
    media_control: 'пауза, дальше, перемотай, стоп воспроизведения',
    media_device: 'телевизор, приставка, колонка как устройство',
    socket: 'розетка, чайник, включить прибор в розетку',
    comms: 'звонки, сообщения, написать кому-то',
    smalltalk: 'болтовня, благодарность, приветствие, шутки',
    typo: 'оговорка или бессмысленный набор слов',
    ambiguous: 'двусмысленное, непонятная команда',
    unknown_device: 'упоминание неизвестного устройства',
    edge: 'пограничный, tricky случай'
  }
}

interface LayaAnswer {
  choice?: string
  answer_confidence?: number
  action?: { act_probability?: number }
}

/**
 * Log a shadow classification for a gray-zone or no-match utterance.
 * zone: 'gray' (0.5 <= scoreIntent < 0.9 / ambiguous) | 'nomatch' (score < 0.5, short text) |
 * 'catalog' (the fuzzy command catalog decided execute/confirm/clarify: compare laya's domain
 * with the catalog's choice to find templates/thresholds to tune).
 */
export function shadowClassify (text: string, score: number | null, zone: 'catalog' | 'gray' | 'nomatch'): void {
  if (MODE === 'off' || !text.trim()) return
  void (async () => {
    const started = Date.now()
    try {
      const res = await fetch(ADAPTER_LAYA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, questions: { domain: DOMAIN_QUESTION } }),
        signal: AbortSignal.timeout(LAYA_TIMEOUT_MS)
      })
      if (!res.ok) {
        logger.warn(`SEMANTIC shadow: laya http ${res.status} for '${text}' (zone=${zone})`)
        return
      }
      const data = await res.json() as { ok?: boolean, result?: { answers?: Record<string, LayaAnswer> } }
      const answer = data.result?.answers?.domain
      if (data.ok !== true || answer?.choice === undefined) {
        logger.warn(`SEMANTIC shadow: laya unavailable for '${text}' (zone=${zone})`)
        return
      }
      const conf = answer.answer_confidence ?? 0
      const abstain = (answer.action?.act_probability ?? 1) < 0.5
      logger.info(`SEMANTIC shadow: text='${text}' scoreIntent=${score === null ? 'null' : score} laya=${abstain ? 'abstain' : answer.choice}(${conf.toFixed(2)}) zone=${zone} ms=${Date.now() - started}`)
    } catch (error) {
      logger.warn(`SEMANTIC shadow: laya error for '${text}' (zone=${zone}): ${String(error)}`)
    }
  })()
}

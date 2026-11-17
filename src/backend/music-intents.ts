// Voice «включи <артист/трек/альбом>» → Music Assistant on the speaker's AirPlay player.
// Parsing is local and pure; search/ranking/playback live in the adapter
// (`POST /music/play`, backend/yandex/music_airplay.py) so voice and dashboard share
// one engine. Only called when the fast-intent layer found NO device/state match,
// and returns null (→ LLM brain) when the adapter finds no confident catalog match.
import { getLogger } from '../logger'
import { type MediaAction, type MusicMediaType, parseBareMusicName, parseMusicIntent } from './music-parse'

const logger = getLogger()

const ADAPTER_MUSIC_URL = process.env.AISIS_ADAPTER_MUSIC_URL ?? 'http://127.0.0.1:31117/music/play'
const ADAPTER_MUSIC_TIMEOUT_MS = 50_000
// One env var points both routes at the same adapter (the stage points them at its stand-in).
const ADAPTER_CONTROL_URL = ADAPTER_MUSIC_URL.replace(/\/music\/play$/, '/music/control')
// A voice «стоп» waits for the speaker to actually go quiet (MA ack, then a receiver restart if needed).
const ADAPTER_CONTROL_TIMEOUT_MS = 15_000

interface PlayResponse {
  err?: string
  matched?: { artist?: string, media_type: MusicMediaType, name: string }
  ok: boolean
}

/** Spoken confirmation for a started item; null when the adapter found no confident match. */
export async function tryMusicIntent (rawText: string): Promise<{ text: string } | null> {
  const intent = parseMusicIntent(rawText)
  const bare = intent === null ? parseBareMusicName(rawText) : null
  if (intent === null && bare === null) return null
  const query = (intent ?? bare)!.query
  const started = Date.now()
  try {
    const res = await fetch(ADAPTER_MUSIC_URL, {
      body: JSON.stringify(intent === null ? { query, strict: true } : { media_type: intent.mediaType, query }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(ADAPTER_MUSIC_TIMEOUT_MS)
    })
    const data = await res.json() as PlayResponse
    logger.info(`Music intent '${query}' (${intent?.mediaType ?? (bare === null ? 'any' : 'bare name')}): ok=${data.ok} ` +
      `${data.matched?.name ?? data.err ?? ''} ms=${Date.now() - started}`)
    if (data.ok && data.matched !== undefined) {
      const { artist, name } = data.matched
      return { text: `Включаю ${name}${artist ? `, ${artist}` : ''}.` }
    }
    if (data.err === 'no_match') return null // not in the catalog: let the brain answer
    // A bare name was only a guess at a music request: any failure stays silent for the brain to handle.
    return bare === null ? { text: 'Не получилось включить музыку.' } : null
  } catch (error) {
    logger.warn(`Music intent '${query}' failed: ${String(error)}`)
    return bare === null ? { text: 'Музыка сейчас недоступна.' } : null
  }
}

interface ControlResponse {
  err?: string
  ok: boolean
}

/**
 * done: the speaker's AirPlay playback obeyed. idle: nothing of ours is playing (try Home Assistant).
 * unsupported: a phone owns the AirPlay session and only stop/pause reach it. failed: the adapter
 * answered but could not do it. unreachable: the adapter did not answer at all.
 */
export type MediaOutcome = 'done' | 'failed' | 'idle' | 'unreachable' | 'unsupported'

export async function tryMediaControl (action: MediaAction): Promise<MediaOutcome> {
  const started = Date.now()
  try {
    const res = await fetch(ADAPTER_CONTROL_URL, {
      body: JSON.stringify({ action }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(ADAPTER_CONTROL_TIMEOUT_MS)
    })
    const data = await res.json() as ControlResponse
    logger.info(`Media control '${action}': ok=${data.ok} ${data.err ?? ''} ms=${Date.now() - started}`)
    if (data.ok) return 'done'
    if (data.err === 'idle') return 'idle'
    if (data.err === 'unsupported_sender') return 'unsupported'
    return 'failed'
  } catch (error) {
    logger.warn(`Media control '${action}' failed: ${String(error)}`)
    return 'unreachable'
  }
}

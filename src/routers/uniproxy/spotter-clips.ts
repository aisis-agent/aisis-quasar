// Recordings of the commands the speaker recognises ON the device.
//
// The station's own commands spotter («включи свет», «громче», «пауза») recognises a command locally and sends the
// server text only: the STT gateway never hears it, so no clip reached the archive or the Telegram clip feed (2026-11-16
// 15:53, two «включи свет» with nothing in the chat). The station does upload the audio it spotted, though: a LogSpotter
// event followed by a binary Ogg/Opus stream per mic channel. This collects those streams and hands the best one to the
// gateway's archive (POST /spotter-clip). Best effort: it never sits on the turn's path and a failure is only logged.
import { getLogger } from '../../logger'

// The command model. Wake-word logs («алиса») belong to a voice turn, which the gateway records itself.
const COMMANDS_SOURCE = /quasar-commands/i
const IDLE_FLUSH_MS = 1200
const UTTERANCE_MS = 500
const MAX_STREAM_BYTES = 512 * 1024
const MAX_STREAM_CHUNKS = 2048
const MAX_STREAMS = 16
const POST_TIMEOUT_MS = 5000
const MAX_PENDING_UPLOADS = 8

export interface SpotterClip {
  audio: Uint8Array<ArrayBuffer>
  deviceId: string
  frames: number
  source: string
  startedAt: number
  transcript: string
}

interface Stream {
  bytes: number
  chunks: Buffer[]
  frames: number
  source?: string
  startedAt: number
  announcedAt?: number
  transcript?: string
}

export type SpotterClipSink = (clip: SpotterClip) => Promise<void>

const logger = getLogger()

// The gateway's /spotter-clip: the STT websocket's host and port over http, whatever path or query that url carries.
export function gatewayClipUrl (env: NodeJS.ProcessEnv = process.env): string {
  if (env.AISIS_SPOTTER_CLIP_URL !== undefined) return env.AISIS_SPOTTER_CLIP_URL
  const url = new URL(env.STT_GIGAAM_URL ?? 'ws://127.0.0.1:31121')
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = '/spotter-clip'
  url.search = ''
  url.hash = ''
  return url.toString()
}

type Announced = Stream & { announcedAt: number, source: string, transcript: string }

function isAnnounced (stream: Stream): stream is Announced {
  return stream.announcedAt !== undefined && stream.source !== undefined && stream.transcript !== undefined
}

export async function postToGateway (clip: SpotterClip): Promise<void> {
  const response = await fetch(gatewayClipUrl(), {
    body: clip.audio,
    headers: {
      'content-type': 'audio/ogg',
      'x-aisis-frames': String(clip.frames),
      'x-aisis-source': clip.source,
      'x-aisis-station': clip.deviceId,
      'x-aisis-ts': String(clip.startedAt),
      'x-aisis-transcript': encodeURIComponent(clip.transcript)
    },
    method: 'POST',
    signal: AbortSignal.timeout(POST_TIMEOUT_MS)
  })
  if (!response.ok) throw new Error(`gateway answered ${response.status}`)
}

export class SpotterClipRecorder {
  private pending = 0
  private readonly streams = new Map<number, Stream>()
  private timer: NodeJS.Timeout | undefined

  constructor (private readonly deviceId: string, private readonly sink: SpotterClipSink = postToGateway,
    private readonly now: () => number = Date.now) {}

  // The LogSpotter event that announces what stream `streamId` carries.
  announce (streamId: number, spotter: { source: string, transcript: string }): void {
    const transcript = spotter.transcript.trim()
    if (transcript === '' || !COMMANDS_SOURCE.test(spotter.source)) return
    const stream = this.streamOf(streamId)
    stream.source = spotter.source
    stream.transcript = transcript
    stream.announcedAt = this.now()
    this.rearm()
  }

  // A binary frame of a stream that is not the voice input (the spotter-log audio follows its LogSpotter event).
  addAudio (streamId: number, frame: Buffer): void {
    if (frame.length === 0) return
    const stream = this.streamOf(streamId)
    stream.frames += 1
    if (stream.bytes + frame.length <= MAX_STREAM_BYTES && stream.chunks.length < MAX_STREAM_CHUNKS) {
      stream.chunks.push(frame)
      stream.bytes += frame.length
    }
    this.rearm()
  }

  flush (): void {
    clearTimeout(this.timer)
    this.timer = undefined
    const streams = [...this.streams.values()]
    this.streams.clear()
    this.emit(streams)
  }

  // One clip per spoken command: of the mic channels that carried it, the one with the most audio. The channels of one
  // utterance are announced together; the same words announced later than UTTERANCE_MS after the group began are the next
  // utterance, not another channel of it («громче», «громче» within one idle window are two commands).
  private emit (streams: Stream[]): void {
    const announced = streams.filter(isAnnounced).sort((a, b) => a.announcedAt - b.announcedAt)
    const utterances: Array<{ announcedAt: number, best: Announced }> = []
    for (const stream of announced) {
      const utterance = utterances.findLast(known =>
        known.best.transcript === stream.transcript && stream.announcedAt - known.announcedAt <= UTTERANCE_MS)
      if (utterance === undefined) utterances.push({ announcedAt: stream.announcedAt, best: stream })
      else if (stream.bytes > utterance.best.bytes) utterance.best = stream
    }
    for (const { best: stream } of utterances) {
      const transcript = stream.transcript
      if (stream.bytes === 0) {
        logger.warn(`Spotter clip '${transcript}': the station sent no audio, nothing to archive`)
        continue
      }
      // A gateway that does not answer must not pile up recordings in memory: at most MAX_PENDING_UPLOADS in flight.
      if (this.pending >= MAX_PENDING_UPLOADS) {
        logger.warn(`Spotter clip '${transcript}' dropped: ${this.pending} uploads are still waiting for the gateway`)
        continue
      }
      const clip: SpotterClip = { audio: Buffer.concat(stream.chunks), deviceId: this.deviceId, frames: stream.frames,
        source: stream.source, startedAt: stream.startedAt, transcript }
      this.pending += 1
      this.sink(clip).then(
        () => logger.info(`Spotter clip '${transcript}' archived (${clip.audio.length}B, ${clip.frames} frames)`),
        (error: unknown) => logger.warn(`Spotter clip '${transcript}' not archived: ${String(error)}`)
      ).finally(() => { this.pending -= 1 })
    }
  }

  private streamOf (streamId: number): Stream {
    let stream = this.streams.get(streamId)
    if (stream === undefined) {
      if (this.streams.size >= MAX_STREAMS) this.evictOldest()
      stream = { bytes: 0, chunks: [], frames: 0, startedAt: this.now() }
      this.streams.set(streamId, stream)
    }
    return stream
  }

  // Room for a new stream: the oldest stream goes, with the channels of the same utterance (one clip, not one per channel).
  // Everything else, active streams included, stays.
  private evictOldest (): void {
    const [oldestId, oldest] = this.streams.entries().next().value as [number, Stream]
    const gone: Array<[number, Stream]> = [[oldestId, oldest]]
    if (isAnnounced(oldest)) {
      for (const [id, stream] of this.streams) {
        if (id !== oldestId && isAnnounced(stream) && stream.transcript === oldest.transcript &&
          Math.abs(stream.announcedAt - oldest.announcedAt) <= UTTERANCE_MS) gone.push([id, stream])
      }
    }
    for (const [id] of gone) this.streams.delete(id)
    this.emit(gone.map(([, stream]) => stream))
  }

  private rearm (): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), IDLE_FLUSH_MS)
    this.timer.unref()
  }
}

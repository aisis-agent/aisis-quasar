import { getTraceData, Span, startInactiveSpan } from '@sentry/node'
import { WebSocket } from 'ws'

import { OpusProcessor } from '../../codecs/opus-processor'
import { getLogger } from '../../logger'
import { STTBackend, STTBackendSession } from '../backend'

interface GigaAMMessage {
  end_of_utt: boolean;
  rejected?: string;
  text: string;
}

class GigaAMSTTSession extends STTBackendSession {
  private readonly logger = getLogger<GigaAMSTTSession>()
  private readonly opusProcessor: OpusProcessor
  private spanEnded = false
  private stopped = false
  private rateSent = false
  private finishPromise: Promise<void> | null = null
  private resolveFinish: (() => void) | null = null
  private rejectFinish: ((error: Error) => void) | null = null

  constructor (private readonly webSocket: WebSocket, private readonly span?: Span) {
    super()
    this.opusProcessor = new OpusProcessor(
      data => this.send(data, true),
      sampleRate => {
        // The gateway closes the socket on a second init; a resynced OpusHead
        // re-emits the rate mid-stream (decode always runs on the 48k clock).
        if (this.rateSent) return Promise.resolve()
        this.rateSent = true
        return this.send(JSON.stringify({ sample_rate: sampleRate }), false)
      }
    )

    webSocket.on('message', (message) => {
      if (this.stopped || this.finalSeen) return
      const simplifiedMessage = Array.isArray(message) ? Buffer.concat(message) : Buffer.from(message as ArrayBuffer)
      const response = JSON.parse(simplifiedMessage.toString('utf8')) as GigaAMMessage
      if (!this.stopped) {
        if (response.end_of_utt) {
          this.finalSeen = true
          this.resolveFinish?.()
        }
        this.chunkTranscribed({
          endOfUtt: response.end_of_utt,
          rejected: response.rejected,
          text: response.text
        })
      }
    })
    webSocket.on('close', () => {
      this.stopped = true
      if (!this.finalSeen) this.rejectFinish?.(new Error('STT closed before final result'))
    })
  }

  async finish (): Promise<void> {
    if (this.finalSeen) return
    this.opusProcessor.finish()
    if (this.finishPromise) return this.finishPromise
    if (this.stopped) throw new Error('STT session already closed')
    const timer = setTimeout(() => {
      this.rejectFinish?.(new Error('STT final result timed out'))
      this.close()
    }, 40000)
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    this.resolveFinish = () => { clearTimeout(timer); resolve() }
    this.rejectFinish = error => { clearTimeout(timer); reject(error) }
    this.finishPromise = promise
    // Normal native EOF is explicit; websocket close remains immediate cancel.
    void this.send(JSON.stringify({ type: 'finish' }), false)
    await this.finishPromise
  }

  close (): void {
    this.stopped = true
    if (!this.finalSeen) this.rejectFinish?.(new Error('STT session cancelled'))
    if (!this.spanEnded) {
      this.spanEnded = true
      this.span?.end()
    }
    if (this.webSocket.readyState === this.webSocket.OPEN) {
      this.webSocket.close()
    }
  }

  async transcribeChunk (chunk: Buffer): Promise<void> {
    if (this.stopped) return
    try {
      await this.opusProcessor.handleAudioData(chunk)
    } catch (error) {
      this.logger.warn({ event: 'opus_audio_chunk_failed', error: String(error) })
    }
  }


  private send (data: Buffer | string, binary: boolean): Promise<void> {
    if (this.stopped || this.webSocket.readyState !== this.webSocket.OPEN) {
      return Promise.resolve()
    }
    return new Promise(resolve => {
      this.webSocket.send(data, { binary }, error => {
        if (error && !this.stopped) {
          this.logger.warn({ error: String(error), event: 'gigaam_socket_send_failed' })
        }
        resolve()
      })
    })
  }
}

export class GigaAMSTTBackend implements STTBackend {
  constructor (private readonly endpoint: string) {}

  startTranscribing (parentSpan?: Span): Promise<STTBackendSession> {
    let span: Span | undefined
    if (parentSpan) {
      span = startInactiveSpan({
        name: 'GigaAM STT transcribing',
        op: 'gigaam-stt',
        parentSpan
      })
    }
    const webSocket = new WebSocket(this.endpoint, span
      ? {
          headers: {
            ...getTraceData({
              span: startInactiveSpan({
                name: 'GigaAM STT transcribing connection',
                op: 'gigaam-stt-connection',
                parentSpan: span
              })
            })
          }
        }
      : {})
    return new Promise((resolve, reject) => {
      let opened = false
      webSocket.on('error', error => {
        if (!opened) reject(error)
      })
      webSocket.on('close', () => {
        if (!opened) reject(new Error('Unexpected close'))
      })
      webSocket.on('open', () => {
        opened = true
        resolve(new GigaAMSTTSession(webSocket, span))
      })
    })
  }
}

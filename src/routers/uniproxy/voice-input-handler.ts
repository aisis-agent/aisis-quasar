import { Span, startInactiveSpan } from '@sentry/node'
import { Sema } from 'async-sema'
import EventEmitter from 'node:events'

import { AudioMetadataBackend, AudioMetadataBackendSession, STTBackend, STTBackendSession } from '../../backend/backend'
import { getLogger } from '../../logger'
import { InputMetadata } from './input-handler'

export interface VoiceInputAudioEvent {
  buffer: Buffer
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface VoiceInputCancelEvent {
}

export interface VoiceInputEvent {
  metadata: InputMetadata
  parentSpan?: Span
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface VoiceInputFinishEvent {
}

export interface VoiceInputHandlerErrorEvent {
  error: unknown
}

export interface VoiceInputHandlerEvents {
  error: [VoiceInputHandlerErrorEvent]
  finish: [VoiceInputHandlerFinishEvent]
  transcribed: [VoiceInputHandlerTranscribedEvent]
}

export interface VoiceInputHandlerFinishEvent {
  metadata: InputMetadata
  text: string
}

export interface VoiceInputHandlerProperties {
  audioMetadata: AudioMetadataBackend
  stt: STTBackend
}

export interface VoiceInputHandlerTranscribedEvent {
  text: string
}

export interface VoiceInputSpeakerMetadataEvent {
  metadata: InputMetadata
}

interface AudioMetadata {
  speakerVerification?: {
    label?: string
  }
}

// eslint-disable-next-line unicorn/prefer-event-target
export class VoiceInputHandler extends EventEmitter<VoiceInputHandlerEvents> {
  private audioDataQueue: Buffer[] = []
  private audioMetadataSession: AudioMetadataBackendSession | null = null
  private audioSendingLock = new Sema(1)
  private lastTranscribeResult: string = ''
  private readonly logger = getLogger<VoiceInputHandler>()
  private metadata: InputMetadata = { internal: {}, readyToUse: {} }
  private sttSession: null | STTBackendSession = null
  private voiceSpan: null | Span = null
  private epoch = 0
  private active = false
  private finishing = false
  private starting: Promise<void> | null = null
  private finalizing: Promise<void> | null = null

  constructor (private readonly properties: VoiceInputHandlerProperties) {
    super()
  }

  close (): void {
    // Cancellation invalidates every callback and in-flight finalization first.
    this.epoch += 1
    this.active = false
    this.finishing = false
    this.starting = null
    this.finalizing = null
    this.audioMetadataSession?.close()
    this.audioMetadataSession = null
    this.sttSession?.close()
    this.sttSession = null
    this.audioDataQueue = []
    this.lastTranscribeResult = ''
    this.metadata = { internal: {}, readyToUse: {} }

    this.voiceSpan?.setAttribute('endReason', 'close')
    this.voiceSpan?.end()
    this.voiceSpan = null
  }

  async handleVoiceInputAudioEvent (data: VoiceInputAudioEvent): Promise<void> {
    if (!this.active || this.finishing) return
    const epoch = this.epoch
    await this.audioSendingLock.acquire()
    try {
      if (!this.active || epoch !== this.epoch) return
      if (this.audioMetadataSession && this.sttSession) {
        await Promise.all([
          this.audioMetadataSession.processChunk(data.buffer),
          this.sttSession.transcribeChunk(data.buffer)
        ])
      } else {
        this.audioDataQueue.push(data.buffer)
      }
    } finally {
      this.audioSendingLock.release()
    }
  }

  async handleVoiceInputCancelEvent (_request: VoiceInputCancelEvent): Promise<void> {
    this.close()
  }

  async handleVoiceInputEvent (request: VoiceInputEvent): Promise<void> {
    this.close()
    this.active = true
    const epoch = this.epoch
    this.starting = this.start(request, epoch)
    await this.starting
  }

  private async start (request: VoiceInputEvent, epoch: number): Promise<void> {
    if (request.parentSpan) {
      this.voiceSpan = startInactiveSpan({
        name: 'VoiceInputHandler processing',
        op: 'voice-input-handler',
        parentSpan: request.parentSpan
      })
    }

    this.metadata = {
      ...request.metadata
    }

    let audioMetadataSession: AudioMetadataBackendSession
    let sttSession: STTBackendSession

    try {
      [audioMetadataSession, sttSession] = await Promise.all([
        this.properties.audioMetadata.startCapturing(this.voiceSpan ?? undefined),
        this.properties.stt.startTranscribing(this.voiceSpan ?? undefined)
      ])
    } catch (error) {
      if (epoch === this.epoch && this.active) {
        this.emit('error', { error })
        this.close()
      }
      return
    }
    if (epoch !== this.epoch || !this.active) {
      audioMetadataSession.close()
      sttSession.close()
      return
    }

    sttSession.setCallback(({ endOfUtt, text }) => {
      if (epoch !== this.epoch || !this.active || this.sttSession !== sttSession) return
      this.lastTranscribeResult = text
      this.emit('transcribed', { text })
      if (endOfUtt) void this.finalize(epoch)
    })

    await this.audioSendingLock.acquire()
    try {
      if (epoch !== this.epoch || !this.active) {
        audioMetadataSession.close()
        sttSession.close()
        return
      }
      this.audioMetadataSession = audioMetadataSession
      this.sttSession = sttSession
      while (this.audioDataQueue.length > 0) {
        const data = this.audioDataQueue.shift()!
        await Promise.all([audioMetadataSession.processChunk(data), sttSession.transcribeChunk(data)])
        if (epoch !== this.epoch || !this.active) return
      }
    } finally {
      this.audioSendingLock.release()
    }
  }


  async handleVoiceInputFinishEvent (_request: VoiceInputFinishEvent): Promise<void> {
    // Native StreamControl.Close means normal EOF, never transport cancellation.
    await this.finalize(this.epoch)
  }

  async handleVoiceInputSpeakerMetadataEvent (request: VoiceInputSpeakerMetadataEvent): Promise<void> {
    if (!this.active) return
    this.metadata = {
      internal: {
        ...this.metadata.internal,
        ...request.metadata.internal
      },
      readyToUse: {
        ...this.metadata.readyToUse,
        ...request.metadata.readyToUse
      }
    }
  }

  private finalize (epoch: number): Promise<void> {
    if (!this.active || epoch !== this.epoch) return Promise.resolve()
    if (this.finalizing) return this.finalizing
    this.finishing = true
    this.finalizing = this.finishOnce(epoch)
    return this.finalizing
  }

  private async finishOnce (epoch: number): Promise<void> {
    try {
      await this.starting
      await this.audioSendingLock.acquire()
      try {
        if (epoch !== this.epoch || !this.active || !this.sttSession) return
        const stt = this.sttSession
        const metadataSession = this.audioMetadataSession
        // finish() flushes recognizer input and waits for its bounded final result.
        // The callback updates lastTranscribeResult before this await resumes.
        await stt.finish()
        if (epoch !== this.epoch || !this.active || this.sttSession !== stt) return
        const audioMetadata = await metadataSession?.finish() as AudioMetadata | undefined
        if (epoch !== this.epoch || !this.active || this.sttSession !== stt) return
        const metadata: InputMetadata = {
          internal: {
            ...this.metadata.internal,
            audioMetadata
          },
          readyToUse: {
            ...this.metadata.readyToUse,
            ...(audioMetadata?.speakerVerification?.label
              ? {
                  inputPersonVoiceLabel: {
                    description: 'input person voice label (e.g. name)',
                    value: audioMetadata.speakerVerification.label
                  }
                }
              : {})
          }
        }
        this.active = false
        this.sttSession = null
        this.audioMetadataSession = null
        this.audioDataQueue = []
        stt.close()
        this.metadata = { internal: {}, readyToUse: {} }
        this.voiceSpan?.setAttribute('endReason', 'finish')
        this.voiceSpan?.setAttribute('text', this.lastTranscribeResult)
        this.voiceSpan?.setAttribute('metadata', JSON.stringify(metadata, undefined, 2))
        this.voiceSpan?.end()
        this.voiceSpan = null
        this.emit('finish', { metadata, text: this.lastTranscribeResult })
      } finally {
        this.audioSendingLock.release()
      }
    } catch (error) {
      if (epoch === this.epoch && this.active) {
        this.emit('error', { error })
        this.close()
      }
    }
  }
}

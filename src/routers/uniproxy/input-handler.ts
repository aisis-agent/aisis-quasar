import { Span, startInactiveSpan } from '@sentry/node'

import { ProcessorBackend, ProcessorPartialResponse, ProcessorSession } from '../../backend/backend'
import { matchFastIntent, speakerLevelOf } from '../../backend/ha-intents'
import { recordTurn, TurnOrigin } from '../../backend/turn-memory'
import { getLogger } from '../../logger'
import { Notifier } from '../../notifier'
import proto from '../../protos/protos'
import { StationInfo } from '../../storage/types'
import { textToDirectiveMap } from '../alice/base-provider'
import { DirectiveFunctionProvider, mmSemanticFrame, ttsPlayPlaceholderDirective, WrappedDirective } from '../alice/directives'
import { continueSessionStage1SemanticFrame } from '../alice/typed-payloads'

export interface AlarmMetadata {
  currentlyPlaying: boolean
  days: (number | {
    day?: number
    month?: number
    year?: number
  })[],
  id: string
  time: {
    hours?: number
    minutes?: number
    seconds?: number
  },
}

export interface Input {
  metadata: InputMetadata
}

export interface InputHandlerProperties {
  directiveFunctionProvider: DirectiveFunctionProvider
  processor: ProcessorBackend
}

export type InputMetadata = {
  internal: Partial<{
    age: string
    alarms: AlarmMetadata[]
    audioMetadata: object
    deviceId: string
    deviceState: proto.NAlice.NAliceApi.ITDeviceState
    environmentState: proto.NAlice.NAliceApi.ITEnvironmentState
    gender: string
    info: StationInfo
    timers: TimerMetadata[]
  }>,
  readyToUse: Partial<{
    alarms: InputMetadataEntry
    assistantName: InputMetadataEntry
    deviceName: InputMetadataEntry
    inputPersonAge: InputMetadataEntry
    inputPersonGender: InputMetadataEntry
    inputPersonVoiceLabel: InputMetadataEntry
    timers: InputMetadataEntry
  }>
}

export interface InputMetadataEntry {
  description: string
  value: string
}

export interface InputResult {
  dialogFinished: boolean
  directives: WrappedDirective[]
  shouldListen: boolean
  text: null | string
}

export type TextInput = Input & {
  data: TextInputData
}

export type TextInputData = {
  isPayloadRaw: boolean
  kind: 'syncTimezoneLocation',
  location: boolean
  timezone: boolean,
} | {
  kind: 'continue'
} | {
  kind: 'dummy'
} | {
  kind: 'musicFetchNextTrack'
} | {
  kind: 'musicRecoverCommit'
  recoverCommitToken: string
} | {
  kind: 'playButtonPressPlay'
} | {
  kind: 'text'
  text: string
} | {
  kind: 'tts'
  text: string
}

export interface TimerMetadata {
  currentlyPlaying: boolean
  duration: number
  id: string
  remaining: number
}

export type VoiceInput = Input & {
  text: string
}

const MAX_WAIT = 5000
// A dialog is «in progress» while the follow-up window opened by our last question may still be open, and
// while our last spoken answer is (roughly) playing plus this tail. A terminator («хватит», «ничего») inside
// it ends the dialog; outside it, «стоп» is a media key and stops the music (ha-intents.ts).
const FOLLOW_UP_WINDOW_MS = 20_000
const SPEECH_TAIL_MS = 5000
const SPEECH_MS_PER_CHAR = 70

export class InputHandler {
  private readonly logger = getLogger()
  private notifier: Notifier = new Notifier()
  private partialResponses: ProcessorPartialResponse[] = []
  private requestSent: boolean = false
  private session: null | ProcessorSession = null
  private span: Span | undefined
  // The utterance the brain is answering: recorded with its answer so «повтори» can say it again (turn-memory.ts).
  private brainTurn: null | { heard: string, origin: TurnOrigin } = null
  private followUpOpenedAt = 0
  private spokenUntil = 0

  constructor (private readonly properties: InputHandlerProperties) {}

  private dialogActive (): boolean {
    const now = Date.now()
    return now - this.followUpOpenedAt < FOLLOW_UP_WINDOW_MS || now < this.spokenUntil + SPEECH_TAIL_MS
  }

  // Called with every response sent to the station: what it will say and whether the mic stays open.
  private noteResponse (text: null | string, shouldListen: boolean): void {
    const now = Date.now()
    this.followUpOpenedAt = shouldListen ? now : 0
    if (text) this.spokenUntil = now + text.length * SPEECH_MS_PER_CHAR
  }

  closeSession (closePartially?: boolean): void {
    if (this.session) {
      if (!closePartially) {
        this.partialResponses = []
      }
      this.session.close()
      this.session = null
      this.requestSent = false
      this.logger.debug('Session closed')
      this.span?.end()
      this.span = undefined
    } else {
      this.logger.debug('Session already closed')
    }
  }

  async getPartialResponse (): Promise<null | ProcessorPartialResponse> {
    if (this.partialResponses.length > 0) {
      const response = this.partialResponses[0]
      this.partialResponses = this.partialResponses.slice(1)
      return response ?? null
    }

    if (!this.session || !this.requestSent) {
      return null
    }

    await this.notifier.wait(MAX_WAIT)

    if (this.partialResponses.length > 0) {
      const response = this.partialResponses[0]
      this.partialResponses = this.partialResponses.slice(1)
      return response ?? null
    }

    return null
  }

  async openSession (parentSpan?: Span): Promise<void> {
    if (this.session) {
      this.logger.debug('Session already opened')
    } else {
      if (parentSpan) {
        this.span = startInactiveSpan({
          name: 'InputHandler session processing',
          op: 'input-handler-session',
          parentSpan
        })
      }
      this.logger.debug('Opening new session')
      this.partialResponses = []
      this.session = await this.properties.processor.openSession(parentSpan)
      this.session.addListener('close', () => {
        this.closeSession(true)
      })
      this.session.addListener('partialResponse', data => {
        this.logger.debug(`Received partial response: ${JSON.stringify(data)}`)
        this.partialResponses.push(data)
        this.notifier.notifyAll()
      })
      this.session.addListener('partialResponse', () => {})
      await this.session.prepare(
        Object.fromEntries(Object.entries(this.properties.directiveFunctionProvider.getSupportedFunctions())
          .map(entry => ([entry[0], {
            arguments: entry[1].arguments.toJSONSchema(),
            description: entry[1].description
          }])))
      )
      this.logger.debug('Session opened')
    }
  }

  async processTextInput (input: TextInput, parentSpan?: Span, _dialogSpan?: Span): Promise<InputResult> {
    this.logger.debug(`Received TextInput with kind: ${input.data.kind}`)
    switch (input.data.kind) {
      case 'continue': {
        return await this.getPartialResponseResult(input.metadata, parentSpan)
      }
      case 'dummy': {
        return {
          dialogFinished: true,
          directives: [],
          shouldListen: false,
          text: null
        }
      }
      case 'musicFetchNextTrack': {
        return {
          dialogFinished: true,
          directives: [{
            internalDirective: {
              type: 'music_recover_next_track'
            }
          }],
          shouldListen: false,
          text: null
        }
      }
      case 'musicRecoverCommit': {
        return {
          dialogFinished: true,
          directives: [{
            internalDirective: {
              recoverCommitToken: input.data.recoverCommitToken,
              type: 'music_recover_commit'
            }
          }],
          shouldListen: false,
          text: null
        }
      }
      case 'playButtonPressPlay': {
        return {
          dialogFinished: true,
          directives: [{
            internalDirective: {
              type: 'music_play'
            }
          }],
          shouldListen: false,
          text: null
        }
      }
      case 'syncTimezoneLocation': {
        const directives: WrappedDirective[] = []

        if (input.data.timezone) {
          directives.push({
            internalDirective: {
              isPayloadRaw: input.data.isPayloadRaw,
              type: 'set_timezone'
            }
          })
        }
        if (input.data.location) {
          directives.push({
            internalDirective: {
              isPayloadRaw: input.data.isPayloadRaw,
              type: 'set_location'
            }
          })
        }

        return {
          dialogFinished: true,
          directives,
          shouldListen: false,
          text: null
        }
      }
      case 'text': {
        // The station sends spoken commands as plain text TextInput follow-ups
        // (e.g. «выключи свет» after a silent turn); run them through the same
        // fast-intent layer as voice before giving up on the text.
        const fastIntent = await matchFastIntent(input.data.text,
          { deviceId: input.metadata.internal.deviceId, dialogActive: this.dialogActive(), origin: 'text', speakerLevel: speakerLevelOf(input.metadata.internal.deviceState) })
        if (fastIntent !== null && fastIntent.kind !== 'llm') {
          const listen = fastIntent.listen === true
          this.noteResponse(fastIntent.text, listen)
          this.logger.info(`Fast intent for text '${input.data.text}': ${fastIntent.text ?? '(executed, silent)'} (listen=${listen})`)
          return {
            dialogFinished: !listen,
            directives: [
              ...fastIntent.quasarDirectives.map(directive => ({ quasarDirective: directive })),
              // Silent executions must not trigger the waiting earcon.
              ...(fastIntent.text !== null ? [ttsPlayPlaceholderDirective()] : [])
            ],
            shouldListen: listen,
            text: fastIntent.text
          }
        }
        const directive = textToDirectiveMap[input.data.text]
        if (!directive) {
          this.logger.warn(`Received text TextInput with unknown text: '${input.data.text}'`)
          return {
            dialogFinished: true,
            directives: [],
            shouldListen: false,
            text: null
          }
        }

        return {
          dialogFinished: true,
          directives: [directive],
          shouldListen: false,
          text: null
        }
      }
      case 'tts': {
        return {
          dialogFinished: true,
          directives: [
            ttsPlayPlaceholderDirective()
          ],
          shouldListen: false,
          text: input.data.text
        }
      }
    }
  }

  async processVoiceInput (input: VoiceInput, parentSpan?: Span): Promise<InputResult> {
    this.logger.debug(`Received VoiceInput: ${input.text}`)
    // Fast local intents (lights, sockets, AC, speaker volume, state queries)
    // run before the LLM brain. Commands execute silently (text: null) and END the
    // dialog; only a question (confirm / clarify / «не расслышала», `listen`) keeps
    // the mic open for the answer. A clarified ambiguity reroutes the ORIGINAL
    // phrase to the brain.
    const fastIntent = await matchFastIntent(input.text,
      { deviceId: input.metadata.internal.deviceId, dialogActive: this.dialogActive(), origin: 'voice', speakerLevel: speakerLevelOf(input.metadata.internal.deviceState) })
    let brainText = input.text
    if (fastIntent !== null && fastIntent.kind === 'reply') {
      const listen = fastIntent.listen === true
      this.noteResponse(fastIntent.text, listen)
      this.logger.info(`Fast intent for '${input.text}': ${fastIntent.text ?? '(silent)'} (listen=${listen})`)
      return {
        dialogFinished: !listen,
        directives: [
          ...fastIntent.quasarDirectives.map(directive => ({ quasarDirective: directive })),
          // The placeholder is the station's waiting earcon: only send it when
          // speech follows. Silent executions (text: null) must close the turn
          // with no sound at all, exactly like stock smart-home commands.
          ...(fastIntent.text !== null ? [ttsPlayPlaceholderDirective()] : [])
        ],
        shouldListen: listen,
        text: fastIntent.text
      }
    }
    if (fastIntent !== null && fastIntent.kind === 'llm') {
      this.logger.info(`Fast intent routing '${input.text}' to LLM as '${fastIntent.text}'`)
      brainText = fastIntent.text
    }

    if (!this.session) {
      this.logger.warn('No session opened')
      return {
        dialogFinished: true,
        directives: [
        ],
        shouldListen: false,
        text: null
      }
    }

    this.brainTurn = { heard: input.text, origin: 'voice' }
    await this.session.process({
      metadata: input.metadata,
      text: brainText
    })
    this.requestSent = true
    // The dialog stays open (ShouldListen=true) only when the brain's answer asks
    // something; a plain answer ends it and the next request needs the wake word.
    return await this.getPartialResponseResult(input.metadata, parentSpan)
  }

  private async getPartialResponseResult (metadata: InputMetadata, parentSpan?: Span): Promise<InputResult> {
    if ((!this.session || !this.requestSent) && this.partialResponses.length === 0) {
      return {
        dialogFinished: true,
        directives: [],
        shouldListen: false,
        text: null
      }
    }

    let span: Span | undefined
    if (this.span && parentSpan) {
      span = startInactiveSpan({
        links: [{
          context: this.span?.spanContext()
        }],
        name: 'InputHandler waiting for partial response',
        op: 'input-handler-get-partial-response',
        parentSpan
      })
    }
    const partialResponse = await this.getPartialResponse()

    if (partialResponse === null) {
      span?.setAttribute('endReason', 'no-partial-response')
      span?.end()
      this.logger.debug('No partial response, sending continue')
      return {
        dialogFinished: false,
        directives: [
          mmSemanticFrame(false, continueSessionStage1SemanticFrame)
        ],
        shouldListen: false,
        text: null
      }
    }

    if (partialResponse.finished) {
      span?.setAttribute('endReason', 'partial-response-finished')
      span?.setAttribute('text', partialResponse.text)
      span?.setAttribute('should-listen', partialResponse.shouldListen)
      span?.setAttribute('directives', JSON.stringify(partialResponse.directives, undefined, 2))
      span?.end()
      this.logger.debug('Partial response is finished')
      // A spoken answer that ends in a question expects a reply; anything else closes the dialog.
      const shouldListen = partialResponse.shouldListen || /[?？]["»”')\]\s]*$/.test(partialResponse.text.trim())
      this.noteResponse(partialResponse.text, shouldListen)
      if (this.brainTurn !== null && partialResponse.text) {
        recordTurn({ action: null, asked: shouldListen, at: Date.now(), heard: this.brainTurn.heard, origin: this.brainTurn.origin,
          spoken: partialResponse.text })
      }
      this.brainTurn = null
      if (!shouldListen) {
        this.logger.debug('Partial response is finished, and no more input is required - closing')
        this.closeSession()
      }
      return {
        dialogFinished: !shouldListen,
        directives: [
          ...(partialResponse.directives.map(directive =>
            this.properties.directiveFunctionProvider
              .convertToWrappedDirective(directive, metadata)).filter(Boolean) as WrappedDirective[]),
          // Directive-only finishes (text: null) close silently: the waiting
          // earcon must not play when no TTS is coming.
          ...(partialResponse.text ? [ttsPlayPlaceholderDirective()] : [])
        ],
        shouldListen,
        text: partialResponse.text
      }
    }

    this.logger.debug('Partial response is not finished, sending continue')
    span?.setAttribute('endReason', 'partial-response-not-finished')
    span?.setAttribute('text', partialResponse.text)
    span?.setAttribute('directives', JSON.stringify(partialResponse.directives, undefined, 2))
    span?.end()
    return {
      dialogFinished: false,
      directives: [
        ...(partialResponse.directives.map(directive =>
          this.properties.directiveFunctionProvider.convertToWrappedDirective(directive, metadata))
          .filter(Boolean) as WrappedDirective[]),
        ttsPlayPlaceholderDirective({
          TypedCallbackRequest: continueSessionStage1SemanticFrame
        })
      ],
      shouldListen: false,
      text: partialResponse.text
    }
  }
}

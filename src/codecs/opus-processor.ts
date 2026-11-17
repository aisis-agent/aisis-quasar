import { OpusEncoder } from '@discordjs/opus'

import { OggPage, OggParser } from './ogg-parser'

const OPUS_HEAD_BUFFER = Buffer.from([0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64])

interface OpusHead {
  channelCount: number;
  outputGain: number;
  preSkip: number;
  sampleRate: number;
}

export class OpusProcessor {
  private pageBytes: Buffer = Buffer.alloc(0)
  private encoder: null | OpusEncoder = null
  private packetSegments: Buffer[] = []
  private packetBytes = 0
  private serial: number | null = null
  private nextSequence: number | null = null
  private synthesizedHead = false
  private streamPeak = 0
  private streamSquares = 0
  private streamSamples = 0

  constructor (private readonly onAudioData: (data: Buffer) => Promise<void>,
    private readonly onSampleRate: (sampleRate: number) => Promise<void>) {}

  async handleAudioData (audioData: Buffer): Promise<void> {
    // UniProxy transport messages do not define Ogg page boundaries. Retain
    // only an incomplete page; completed pages keep the existing packet path.
    if (audioData.length > 1024 * 1024) throw new Error('Ogg transport frame exceeds voice input limit')
    const data: Buffer = Buffer.concat([this.pageBytes, audioData])
    this.pageBytes = Buffer.alloc(0)
    let offset = 0
    while (offset < data.length) {
      const remaining = data.length - offset
      if (remaining >= 4 && data.readUInt32BE(offset) !== 0x4F676753) throw new Error('Not an Ogg chunk')
      if (remaining >= 5 && data[offset + 4] !== 0) throw new Error('Wrong Ogg stream structure version')
      if (remaining < 27) break
      const count = data[offset + 26]
      if (remaining < 27 + count) break
      let length = 27 + count
      for (let i = 0; i < count; i++) length += data[offset + 27 + i]
      if (remaining < length) break
      for (const page of OggParser.parse(data.subarray(offset, offset + length))) {
        await this.handleOpusPage(page)
      }
      offset += length
    }
    // Ogg permits at most255 lacing entries of255 bytes, plus282 header bytes.
    // Copy the remainder so a small partial page never retains a large frame.
    this.pageBytes = Buffer.from(data.subarray(offset))
    if (this.pageBytes.length > 65307) throw new Error('Ogg page exceeds format limit')
  }

  finish (): void {
    this.logStreamLevels('eof')
    if (this.pageBytes.length > 0) console.warn('[opus-processor] truncated Ogg page at native EOF, discarding', this.pageBytes.length, 'bytes')
    if (this.packetSegments.length > 0) console.warn('[opus-processor] incomplete Opus packet at native EOF, discarding')
  }

  private async handleOpusPage (page: OggPage): Promise<void> {
    if (this.serial !== null && page.streamSerialNumber !== this.serial) {
      console.warn('[opus-processor] stream serial change: expected', this.serial, 'got', page.streamSerialNumber, '- resyncing')
      this.packetSegments = []
      this.packetBytes = 0
      this.encoder = null
      this.synthesizedHead = false
    }
    if (this.nextSequence !== null && page.pageSequenceNumber !== this.nextSequence) {
      console.warn('[opus-processor] page sequence jump: expected', this.nextSequence, 'got', page.pageSequenceNumber)
    }
    this.serial = page.streamSerialNumber
    this.nextSequence = (page.pageSequenceNumber + 1) >>> 0
    const continuing = this.packetSegments.length > 0
    if (page.segments.length > 0 && page.flags.continuedPacket !== continuing) {
      throw new Error('Ogg continued packet flag does not match prior packet')
    }

    // Ogg lacing255 means MORE bytes of the same packet. Only a lacing value
    // below255 (including zero) terminates the packet; it can span pages.
    // Decode completed packets, never individual255-byte page segments.
    for (const segment of page.segments) {
      this.packetSegments.push(segment)
      this.packetBytes += segment.length
      if (this.packetBytes > 1024 * 1024) throw new Error('Ogg packet exceeds voice input limit')
      if (segment.length === 255) continue
      const packet = Buffer.concat(this.packetSegments, this.packetBytes)
      this.packetSegments = []
      this.packetBytes = 0
      await this.handleOpusPacket(packet)
    }
    if (page.flags.lastPage && this.packetSegments.length > 0) {
      throw new Error('Incomplete Opus packet at end of Ogg stream')
    }
  }

  private async handleOpusPacket (packet: Buffer): Promise<void> {
    if (packet.subarray(0, 8).equals(OPUS_HEAD_BUFFER)) {
      // The station restarts its uplink stream (fresh OpusHead, page 0)
      // whenever the mic reopens mid-session; a repeated head is a resync,
      // not a protocol violation. Drop the unterminated packet, if any.
      this.packetSegments = []
      this.packetBytes = 0
      this.synthesizedHead = false
      this.logStreamLevels('new OpusHead')
      const head = parseOpusHead(packet)
      console.info(`[opus-processor] OpusHead channels=${head.channelCount} preSkip=${head.preSkip} ` +
        `inputRate=${head.sampleRate} outputGain=${head.outputGain} (${(head.outputGain / 256).toFixed(2)} dB)`)
      if (head.channelCount !== 1) {
        throw new Error(`Unsupported number of channels: ${head.channelCount}`)
      }
      // RFC7845: input sample rate is informational, and may be0 or44100.
      // Opus has a48kHz decode clock; the Wyoming gateway accepts48kHz PCM.
      const decodeRate = 48000
      this.encoder = new OpusEncoder(decodeRate, head.channelCount)
      this.encoder.applyDecoderCTL(4034, head.outputGain) // OPUS_SET_GAIN_REQUEST, signed Q8 dB.
      await this.onSampleRate(decodeRate)
      return
    }
    if (this.encoder === null) {
      // After a reconnect the speaker's stream can resume mid-stream without
      // its header page; synthesize the stock uplink defaults (16kHz mono,
      // RFC7845 input rate is informational — decode runs on the 48k clock).
      console.warn('[opus-processor] synthesized default OpusHead (16kHz mono)')
      this.encoder = new OpusEncoder(48000, 1)
      this.synthesizedHead = true
      await this.onSampleRate(48000)
    }
    // The comment header may itself span several pages. Page number alone is
    // not a header boundary, and its continuation must not reach the decoder.
    if (packet.subarray(0, 8).equals(Buffer.from('OpusTags'))) {
      console.info('[opus-processor] OpusTags', JSON.stringify(packet.subarray(8, 8 + 160).toString('latin1').replace(/[^\x20-\x7e]/g, '.')))
      return
    }
    if (packet.length === 0) throw new Error('Empty Opus audio packet')
    const decoded = this.encoder.decode(packet)
    this.measure(decoded)
    await this.onAudioData(decoded)
  }

  // The station's far-field uplink is ~45 dB below full scale. Per-stream
  // peak/RMS of the decoded PCM, next to the OpusHead line, shows whether any
  // gain is carried in the header and what level the recognizer really gets.
  private measure (pcm: Buffer): void {
    for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
      const sample = pcm.readInt16LE(offset)
      const magnitude = Math.abs(sample)
      if (magnitude > this.streamPeak) this.streamPeak = magnitude
      this.streamSquares += sample * sample
      this.streamSamples += 1
    }
  }

  private logStreamLevels (reason: string): void {
    if (this.streamSamples === 0) return
    const rms = Math.sqrt(this.streamSquares / this.streamSamples)
    const dbfs = (value: number): string => value > 0 ? (20 * Math.log10(value / 32768)).toFixed(1) : '-inf'
    console.info(`[opus-processor] decoded stream (${reason}): ${(this.streamSamples / 48000).toFixed(2)}s ` +
      `peak=${this.streamPeak} (${dbfs(this.streamPeak)} dBFS) rms=${rms.toFixed(1)} (${dbfs(rms)} dBFS)`)
    this.streamPeak = 0
    this.streamSquares = 0
    this.streamSamples = 0
  }
}

function parseOpusHead (buffer: Buffer): OpusHead {
  const dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (!buffer.subarray(0, 8).equals(OPUS_HEAD_BUFFER)) {
    throw new Error('OpusHead is not present in zero page')
  }
  if (dataView.getUint8(8) !== 1) {
    throw new Error('Wrong Opus version')
  }
  const channelCount = dataView.getUint8(9)
  const preSkip = dataView.getUint16(10, true)
  const sampleRate = dataView.getUint32(12, true)
  const outputGain = dataView.getInt16(16, true)
  const mappingFamily = dataView.getUint8(18)
  if (mappingFamily !== 0) {
    throw new Error('Unsupported mapping family')
  }
  return {
    channelCount,
    outputGain,
    preSkip,
    sampleRate
  }
}

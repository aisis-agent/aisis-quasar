import { OggParser, OggPage } from './ogg-parser'

// Ogg CRC-32: polynomial 0x04c11db7, non-reflected, init 0, no final xor.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let r = n << 24
    for (let i = 0; i < 8; i++) {
      r = ((r << 1) ^ (r & 0x80000000 ? 0x04c11db7 : 0)) >>> 0
    }
    table[n] = r
  }
  return table
})()

function oggCrc (data: Buffer): number {
  let crc = 0
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ data[i]) & 0xff]) >>> 0
  }
  return crc
}

function isOpusHead (page: OggPage): boolean {
  return page.segments.length > 0 && page.segments[0].length >= 8 &&
    page.segments[0].subarray(0, 8).toString('ascii') === 'OpusHead'
}

function isOpusTags (page: OggPage): boolean {
  return page.segments.length > 0 && page.segments[0].length >= 8 &&
    page.segments[0].subarray(0, 8).toString('ascii') === 'OpusTags'
}

function buildPage (serial: number, sequence: number, granule: bigint,
  continuedPacket: boolean, firstPage: boolean, lastPage: boolean,
  segments: Buffer[]): Buffer {
  const lacing = Buffer.from(segments.map(s => s.length))
  const bodyLength = segments.reduce((sum, s) => sum + s.length, 0)
  const header = Buffer.alloc(27 + lacing.length)
  header.write('OggS', 0, 'ascii')
  header[4] = 0
  header[5] = (continuedPacket ? 1 : 0) | (firstPage ? 2 : 0) | (lastPage ? 4 : 0)
  header.writeBigInt64LE(granule, 6)
  header.writeUInt32LE(serial, 14)
  header.writeUInt32LE(sequence >>> 0, 18)
  header[26] = lacing.length
  lacing.copy(header, 27)
  const page = Buffer.concat([header, ...segments])
  page.writeUInt32LE(oggCrc(page), 22)
  return page
}

/**
 * Restitches independently synthesized Ogg/Opus segments into one continuous
 * Ogg stream (oggSpeech pattern): single serial number, continuous page
 * sequence numbers and granule positions, deferred EOS (lastPage only on the
 * final segment), header pages only from the first segment.
 */
export class OggOpusStreamStitcher {
  private serial: number | null = null
  private nextSequence = 0
  private granule = 0n
  private wroteAnyPage = false

  append (segment: Buffer, isLast: boolean): Buffer {
    const pages = OggParser.parse(segment)
    let headerPagesToSkip = 0
    if (this.serial !== null) {
      // Subsequent segments: drop their OpusHead/OpusTags header pages.
      while (headerPagesToSkip < pages.length &&
        (isOpusHead(pages[headerPagesToSkip]) || isOpusTags(pages[headerPagesToSkip]))) {
        headerPagesToSkip++
      }
    }
    const audioPages = pages.slice(headerPagesToSkip)
    if (audioPages.length === 0) throw new Error('Ogg segment has no audio pages')

    // A page's granule is the number of 48 kHz samples the decoder has produced up to its END. A later segment
    // is decoded in full (only the stream's first pre-skip is dropped), so its granules lie on the running total
    // as they are: the first audio page counts too, and so does the pre-roll of a segment whose first pages end
    // below its pre-skip. The total is the sum of the segments' final granules.
    if (this.serial === null) {
      this.serial = pages[0].streamSerialNumber
    }
    const out: Buffer[] = []
    for (let index = 0; index < audioPages.length; index++) {
      const page = audioPages[index]
      const isFirstOutputPage = !this.wroteAnyPage && index === 0
      const isLastOutputPage = isLast && index === audioPages.length - 1
      // A packet must not span segment boundaries: the first kept page of a
      // later segment must not claim a continued packet.
      const continued = isFirstOutputPage ? false : page.flags.continuedPacket
      const granule = this.granule + page.absoluteGranulePosition
      out.push(buildPage(this.serial, this.nextSequence++, granule,
        continued, isFirstOutputPage, isLastOutputPage, page.segments))
      this.wroteAnyPage = true
    }
    this.granule += audioPages[audioPages.length - 1].absoluteGranulePosition
    return Buffer.concat(out)
  }
}

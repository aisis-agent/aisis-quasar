// Offline check of the two Ogg/Opus codecs: the uplink processor must not keep memory alive for a peer that
// keeps feeding it after its 1 MiB packet limit tripped, and the TTS stitcher must carry every segment's
// duration into the stitched stream. Exits 1 on any failure. Run: node_modules/.bin/tsx src/codecs/check_codecs.mts
import { createRequire } from 'node:module'
import Module from 'node:module'
import { runInNewContext } from 'node:vm'
import { setFlagsFromString } from 'node:v8'

// The native Opus binding is not built where this runs (CI installs with --ignore-scripts, a scratch container
// has no reason to need it): the checks never decode, so a stub stands in for it.
const require = createRequire(import.meta.url)
const opusPath = require.resolve('@discordjs/opus')
const stub = new Module(opusPath)
stub.filename = opusPath
stub.loaded = true
stub.exports = {
  OpusEncoder: class {
    applyDecoderCTL (): void {}
    decode (): Buffer { return Buffer.from([1, 2]) }
  }
}
require.cache[opusPath] = stub

const { OpusProcessor } = await import('./opus-processor.ts')
const { OggOpusStreamStitcher } = await import('./ogg-stitcher.ts')
const { OggParser } = await import('./ogg-parser.ts')

let failures = 0
function check (name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` (${detail})`}`)
}

// Hand-built Ogg page: the parser ignores the CRC and the stitcher recomputes it.
function page (granule: bigint, sequence: number, packets: Buffer[], flags = 0, serial = 7): Buffer {
  const lacing: number[] = []
  for (const packet of packets) {
    let left = packet.length
    while (left >= 255) { lacing.push(255); left -= 255 }
    lacing.push(left)
  }
  return pageOfLacing(granule, sequence, lacing, Buffer.concat(packets), flags, serial)
}

function pageOfLacing (granule: bigint, sequence: number, lacing: number[], body: Buffer, flags: number, serial = 7): Buffer {
  const header = Buffer.alloc(27 + lacing.length)
  header.write('OggS', 0, 'ascii')
  header[5] = flags
  header.writeBigUInt64LE(granule, 6)
  header.writeUInt32LE(serial, 14)
  header.writeUInt32LE(sequence, 18)
  header[26] = lacing.length
  Buffer.from(lacing).copy(header, 27)
  return Buffer.concat([header, body])
}

const PRE_SKIP = 312
const FRAME = 960 // 20 ms at 48 kHz

function opusHead (): Buffer {
  const head = Buffer.alloc(19)
  head.write('OpusHead', 0, 'ascii')
  head[8] = 1
  head[9] = 1
  head.writeUInt16LE(PRE_SKIP, 10)
  head.writeUInt32LE(48000, 12)
  return head
}

// One synthesized segment: head, tags, then one audio page per given END granule. A segment is decoded from its own
// start, so its granules count its pre-skip samples as well (RFC 7845).
function segment (endGranules: number[]): Buffer {
  const packet = Buffer.alloc(40, 9)
  return Buffer.concat([
    page(0n, 0, [opusHead()], 2),
    page(0n, 1, [Buffer.concat([Buffer.from('OpusTags'), Buffer.alloc(8)])]),
    ...endGranules.map((granule, index) => page(BigInt(granule), 2 + index, [packet], index === endGranules.length - 1 ? 4 : 0))
  ])
}

// ── ogg-stitcher: a segment's audio pages lie on the running total, the first one included ──
function stitch (segments: Buffer[]): ReturnType<typeof OggParser.parse> {
  const stitcher = new OggOpusStreamStitcher()
  return OggParser.parse(Buffer.concat(segments.map((data, index) => stitcher.append(data, index === segments.length - 1))))
}

const pages = stitch([segment([1920, 4800]), segment([1920, 4800]), segment([1920, 4800])])
const audioGranules = pages.filter(p => p.absoluteGranulePosition > 0n).map(p => Number(p.absoluteGranulePosition))
check('three segments end at the sum of their granules', audioGranules.join() === [1920, 4800, 6720, 9600, 11520, 14400].join(), audioGranules.join())
check('page sequence is continuous and only the last page ends the stream',
  pages.every((p, i) => p.pageSequenceNumber === i && p.flags.lastPage === (i === pages.length - 1)))
check('headers are written once', pages.filter(p => p.segments[0].subarray(0, 8).toString() === 'OpusHead').length === 1)

// A segment whose first pages end below its pre-skip (312) must not move the granules backwards.
const preRoll = stitch([segment([120, 240, 360]), segment([120, 240, 360])]).filter(p => p.absoluteGranulePosition > 0n)
const preRollGranules = preRoll.map(p => Number(p.absoluteGranulePosition))
check('pre-roll pages of a later segment keep the granules rising', preRollGranules.join() === [120, 240, 360, 480, 600, 720].join(), preRollGranules.join())

// ── opus-processor: nothing stays alive after the limit tripped ──
let sampleRates = 0
let decoded = 0
const healthy = new OpusProcessor(async () => { decoded++ }, async () => { sampleRates++ })
const packet = Buffer.alloc(40, 9)
await healthy.handleAudioData(Buffer.concat([page(0n, 0, [opusHead()], 2), page(0n, 1, [Buffer.concat([Buffer.from('OpusTags'), Buffer.alloc(8)])]), page(1000n, 2, [packet, packet])]))
check('a normal stream is decoded', sampleRates === 1 && decoded === 2, `${sampleRates} head, ${decoded} packets`)

setFlagsFromString('--expose-gc')
const collect = runInNewContext('gc') as () => void
const arrayBuffers = (): number => { collect(); return process.memoryUsage().arrayBuffers }

// Below the limit: every message adds one 255-byte segment to a packet that never ends, then junk up to the
// 1 MiB frame limit. A segment that is a view into its frame pins the whole frame, so these 100 messages
// (25 KB of packet) held 100 MiB.
const slow = new OpusProcessor(async () => {}, async () => {})
const slowBefore = arrayBuffers()
for (let i = 0; i < 100; i++) {
  const frame = Buffer.concat([pageOfLacing(0n, i, [255], Buffer.alloc(255, 2), i === 0 ? 0 : 1), Buffer.alloc(1024 * 1024 - 300)])
  try { await slow.handleAudioData(frame) } catch { /* the junk after the page is refused */ }
}
const slowMiB = (arrayBuffers() - slowBefore) / 1048576
check('100 messages below the limit retain under 20 MiB', slowMiB < 20, `${slowMiB.toFixed(1)} MiB retained`)

// A packet whose lacing never drops below 255 never ends; 17 full pages are over 1 MiB.
const endless = new Array<number>(255).fill(255)
const endlessBody = Buffer.alloc(255 * 255, 1)
const processor = new OpusProcessor(async () => {}, async () => {})
let tripped = ''
for (let i = 0; i < 20 && tripped === ''; i++) {
  try {
    await processor.handleAudioData(pageOfLacing(0n, i, endless, endlessBody, i === 0 ? 0 : 1))
  } catch (error) {
    tripped = String(error)
  }
}
check('an endless packet trips the 1 MiB limit', tripped.includes('exceeds voice input limit'), tripped)

const before = arrayBuffers()
// The peer keeps going: every message is a continued page with one 255-byte segment, then junk up to the
// 1 MiB frame limit. Each such frame used to stay pinned by the segment it contributed, so every message is
// its own allocation (one shared buffer would pin a single 1 MiB block however many segments referenced it).
const abuseFrame = (): Buffer => Buffer.concat([pageOfLacing(0n, 99, [255], Buffer.alloc(255, 2), 1), Buffer.alloc(1024 * 1024 - 300)])
let latched = 0
for (let i = 0; i < 150; i++) {
  try { await processor.handleAudioData(abuseFrame()) } catch (error) { if (String(error).includes('closed after an oversized packet')) latched++ }
}
const retainedMiB = (arrayBuffers() - before) / 1048576
check('every message after the limit hits the latched failure', latched === 150, `${latched}/150`)
check('150 more 1 MiB messages retain under 20 MiB', retainedMiB < 20, `${retainedMiB.toFixed(1)} MiB retained`)
// Not only the continuation of the oversized packet: an empty message and a well-formed new page are refused too.
const refusedLater = async (message: Buffer): Promise<boolean> => {
  try { await processor.handleAudioData(message) } catch (error) { return String(error).includes('closed after an oversized packet') }
  return false
}
check('an empty message and a normal page are refused after the limit',
  await refusedLater(Buffer.alloc(0)) && await refusedLater(page(0n, 0, [Buffer.alloc(40, 9)])))

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('codecs: all checks passed')

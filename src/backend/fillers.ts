// Filler phrases: short pre-recorded replies spoken IMMEDIATELY while a slow
// answer (LLM brain, HA registry refresh) is still being prepared. Audio is
// synthesized once per deploy by gen_fillers.py on the host and baked in at
// /src/fillers (see compose volume mount); this module only reads files.
// Math is instant (calc path) and on/off commands are silent — neither gets
// a filler. Owner request: many variants, picked at random per category.

import { readFileSync } from 'node:fs'
import { getLogger } from '../logger'

const logger = getLogger()

interface FillerIndex {
  [category: string]: { text: string, file: string }[]
}

const FILLER_DIR = '/src/fillers'

// Requests answered in <1s by the fast local layer: no filler.
const FAST_COMMAND = /(включ|выключ|отключ|зажг|погас|потуши|вруб|выруб|громкость|тише|громче)/
// Instant local computation: no filler.
const MATH = /(\d|плюс|минус|умнож|делен|раздели|процент|сколько будет|корень|степен)/
// Smart-home state reads: registry may need a refresh -> «Проверяю».
const STATE_QUERY = /(включен|горит|работает|состояние|температур|влажност|что играет|что сейчас активно|какой свет)/

let index: FillerIndex | null = null
const audioCache = new Map<string, Buffer>()
let lastPlayedAt = 0
const MIN_GAP_MS = 8000

export interface Filler {
  category: string
  text: string
  audio: Buffer
}

function getIndex (): FillerIndex | null {
  if (index === null) {
    try {
      index = JSON.parse(readFileSync(`${FILLER_DIR}/index.json`, 'utf8')) as FillerIndex
    } catch {
      logger.warn('Filler index not available at /src/fillers/index.json')
      index = {}
    }
  }
  return index
}

function loadAudio (file: string): Buffer | null {
  const cached = audioCache.get(file)
  if (cached !== undefined) return cached
  try {
    const audio = readFileSync(`${FILLER_DIR}/${file}`)
    audioCache.set(file, audio)
    return audio
  } catch {
    return null
  }
}

// Chooses a filler for a voice turn that is predicted to take >2s.
// Returns null when the turn is expected to be fast or fillers are absent.
export function pickFiller (rawText: string, forceCategory?: string): Filler | null {
  const text = rawText.toLowerCase().replace(/ё/g, 'е')
  if (Date.now() - lastPlayedAt < MIN_GAP_MS) return null
  let category = forceCategory
  if (category === undefined) {
    if (FAST_COMMAND.test(text) || MATH.test(text)) return null
    category = STATE_QUERY.test(text) ? 'state' : 'llm'
  }
  const variants = getIndex()?.[category]
  if (variants === undefined || variants.length === 0) return null
  const variant = variants[Math.floor(Math.random() * variants.length)]!
  const audio = loadAudio(variant.file)
  if (audio === null) return null
  lastPlayedAt = Date.now()
  return { category, text: variant.text, audio }
}

// Test hook for mock verification.
export function resetFillerRateLimit (): void {
  lastPlayedAt = 0
  audioCache.clear()
  index = null
}

// Russian text primitives for the fast-intent layer: normalization, fuzzy word
// similarity (edit distance + phonetic key + trigrams), token-set coverage and a
// Duckling-style numeral parser. Pure functions, no I/O: used by ha-intents.ts
// (exact layer, math) and intent-catalog.ts (fuzzy partial-utterance matching).
//
// What is borrowed from where (see backend/yandex/README.md «Fast intents»):
//   rapidfuzz/fuzzywuzzy  token_set_ratio semantics: extra utterance words never
//                          lower the score, only missing template words do
//                          (tokenCoverage), with fuzzy token alignment on top.
//   Duckling               numeral grammar: «двадцать два с половиной», «полтора»,
//                          digits with decimal comma, %-suffix, unit words.
//   hassil/Rhasspy         templates + slot lists generated from the entity map
//                          (see intent-catalog.ts).

export const NUMBER_WORDS: Record<string, number> = {
  ноль: 0, один: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5,
  шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10, одиннадцать: 11,
  двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15,
  шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
  двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60,
  семьдесят: 70, восемьдесят: 80, девяносто: 90, сто: 100, двести: 200,
  триста: 300, четыреста: 400, пятьсот: 500, шестьсот: 600, семьсот: 700,
  восемьсот: 800, девятьсот: 900, тысяча: 1000, тысячи: 1000, тысяч: 1000
}

export function normalize (text: string): string {
  return text.toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^a-zа-я0-9\s+\-*/.,×÷]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ASR punctuates: «Кромкость 10.  Смотри, вот.» is two sentences. A dot inside a
// number («22.5») is not followed by whitespace and stays.
export function splitSentences (raw: string): string[] {
  return raw.split(/(?<=[.!?…])\s+/).map(part => part.trim()).filter(part => part !== '')
}

// Words of a normalized string. Sentence punctuation glued to a word («10.»,
// «свет,») is dropped; a dot or comma between digits stays (decimal «22,5»).
export function tokenize (normalized: string): string[] {
  return normalized.replace(/(?<!\d)[.,]|[.,](?!\d)/g, ' ').split(/\s+/).filter(token => token !== '')
}

// Optimal-string-alignment distance: Levenshtein where one adjacent swap
// («гормкость») costs 1 — the commonest ASR/typo slip.
export function editDistance (a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) => {
    const row = new Array<number>(b.length + 1).fill(0)
    row[0] = i
    return row
  })
  for (let j = 0; j <= b.length; j++) rows[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, rows[i - 2][j - 2] + 1)
      }
      rows[i][j] = best
    }
  }
  return rows[a.length][b.length]
}

// Phonetic key for Russian: unstressed-vowel reduction and final devoicing, the
// substitutions speech recognizers and fast speakers actually make
// («громкасть», «дисять», «кандиционер»).
export function phoneticKey (word: string): string {
  return word
    .replace(/[ьъ]/g, '')
    .replace(/[оё]/g, 'а')
    .replace(/[еэ]/g, 'и')
    .replace(/ы/g, 'и')
    .replace(/я/g, 'а')
    .replace(/ю/g, 'у')
    .replace(/(.)\1+/g, '$1')
    .replace(/б$/, 'п').replace(/д$/, 'т').replace(/г$/, 'к').replace(/в$/, 'ф').replace(/ж$/, 'ш').replace(/з$/, 'с')
}

function trigrams (word: string): Set<string> {
  const padded = `  ${word} `
  const grams = new Set<string>()
  for (let i = 0; i + 3 <= padded.length; i++) grams.add(padded.slice(i, i + 3))
  return grams
}

export function trigramDice (a: string, b: string): number {
  const left = trigrams(a)
  const right = trigrams(b)
  let shared = 0
  for (const gram of left) if (right.has(gram)) shared++
  return 2 * shared / (left.size + right.size)
}

// Similarity of an utterance word to a vocabulary STEM, 0..1.
//   1.0   exact, or the word is the stem plus an ending (громкость → громкости)
//   <1.0  fuzzy: edit distance on the stem-length prefix or on the phonetic key
//         (at most 1 edit for 5-letter stems, 2 for 6-8, 3 for 9+), trigram overlap
//         as a tie-breaker for garbled long stems. Stems under 5 letters are exact
//         only: «свет»/«сват», «пауза»/«пока» are false friends otherwise.
export function wordSimilarity (word: string, stem: string): number {
  if (word === stem) return 1
  if (word.length >= 3 && word.startsWith(stem)) return 1
  if (stem.length < 5 || word.length < 4) return 0
  const allowed = stem.length >= 9 ? 3 : stem.length >= 6 ? 2 : 1
  const heads = [word, word.slice(0, stem.length + 1), word.slice(0, stem.length)]
  const rawDistance = Math.min(...heads.map(head => editDistance(head, stem)))
  const stemKey = phoneticKey(stem)
  const phoneticDistance = Math.min(...heads.map(head => editDistance(phoneticKey(head), stemKey)))
  let best = 0
  if (rawDistance <= allowed) best = 1 - rawDistance / Math.max(stem.length, 5)
  if (phoneticDistance <= allowed) best = Math.max(best, 0.97 * (1 - phoneticDistance / Math.max(stemKey.length, 5)))
  if (stem.length >= 8 && Math.min(rawDistance, phoneticDistance) <= allowed + 1) {
    best = Math.max(best, 0.9 * trigramDice(word.slice(0, stem.length + 1), stem))
  }
  return best < 0.6 ? 0 : Math.min(best, 0.97)
}

// Best similarity of any single word, and of two adjacent words glued together
// («гром кость»: ASR splits words), against a stem. Returns the matching span.
export function bestWordMatch (tokens: string[], stem: string): { index: number, length: number, score: number } {
  let best = { index: -1, length: 1, score: 0 }
  for (let index = 0; index < tokens.length; index++) {
    const single = wordSimilarity(tokens[index], stem)
    if (single > best.score) best = { index, length: 1, score: single }
    if (index + 1 < tokens.length && tokens[index].length <= 6 && tokens[index + 1].length <= 6) {
      const glued = wordSimilarity(tokens[index] + tokens[index + 1], stem) * 0.95
      if (glued > best.score) best = { index, length: 2, score: glued }
    }
  }
  return best
}

// A noun PHRASE of space-separated stems («тих час»): every stem must be found in the utterance
// (any order, each word used once), otherwise the phrase scores 0 — a lone «часы» is not the quiet
// hours. A one-word phrase is exactly bestWordMatch. `span` lists the matched token indexes.
export function bestPhraseMatch (tokens: string[], phrase: string): { score: number, span: number[] } {
  const words = phrase.split(' ').filter(word => word !== '')
  if (words.length === 0) return { score: 0, span: [] }
  const free = [...tokens]
  const span: number[] = []
  let total = 0
  for (const word of words) {
    // A one-or-two-letter word of a phrase («с», «до» in «тихие часы с») is matched exactly, never as a prefix.
    const index = words.length > 1 && word.length <= 2 ? free.indexOf(word) : -1
    const match = words.length > 1 && word.length <= 2 ? { index, length: 1, score: index >= 0 ? 1 : 0 } : bestWordMatch(free, word)
    if (match.score <= 0 || words.length > 1 && match.score < 0.75) return { score: 0, span: [] }
    for (let i = 0; i < match.length; i++) {
      free[match.index + i] = ''
      span.push(match.index + i)
    }
    total += match.score
  }
  return { score: total / words.length, span: span.sort((a, b) => a - b) }
}

// rapidfuzz token_set_ratio, fuzzy-aligned: how well do the TEMPLATE words
// appear in the utterance? Extra utterance words do not matter (that is what
// distinguishes token_set from plain ratio); typos are matched one-to-one.
export function tokenSetScore (utterance: string[], template: string[]): number {
  if (template.length === 0) return 0
  const taken = new Set<number>()
  let total = 0
  for (const stem of template) {
    let bestIndex = -1
    let bestScore = 0
    for (let i = 0; i < utterance.length; i++) {
      if (taken.has(i)) continue
      const score = wordSimilarity(utterance[i], stem)
      if (score > bestScore) { bestScore = score; bestIndex = i }
    }
    if (bestIndex >= 0) taken.add(bestIndex)
    total += bestScore
  }
  return total / template.length
}

// ── Numerals (Duckling-style) ────────────────────────────────────────────────

export interface NumberMention {
  start: number // token index, inclusive
  end: number // token index, exclusive
  value: number
  source: 'digits' | 'words'
}

// Composes a numeral run («двести пятьдесят четыре») into one number.
export function composeNumeral (tokens: string[], start: number): { end: number, value: number } {
  let total = 0
  let current = 0
  let index = start
  while (index < tokens.length && tokens[index] in NUMBER_WORDS) {
    const value = NUMBER_WORDS[tokens[index]]
    if (value >= 1000) {
      total += (current || 1) * value
      current = 0
    } else {
      current += value
    }
    index++
  }
  return { end: index, value: total + current }
}

const NUMBER_WORD_KEYS = Object.keys(NUMBER_WORDS)

// A recognizer-damaged numeral word («дисять», «пятьнадцать») → the one number
// word it is closest to; ties between different values are rejected.
function fuzzyNumberWord (token: string): string | null {
  if (token in NUMBER_WORDS) return token
  if (token.length < 4 || /\d/.test(token)) return null
  let best: string | null = null
  let bestScore = 0
  let tie = false
  for (const word of NUMBER_WORD_KEYS) {
    if (word.length < 4) continue
    const distance = Math.min(editDistance(token, word), editDistance(phoneticKey(token), phoneticKey(word)))
    const score = 1 - distance / Math.max(word.length, token.length)
    if (score > bestScore + 1e-9) { best = word; bestScore = score; tie = false } else if (Math.abs(score - bestScore) < 1e-9 && best !== null && NUMBER_WORDS[best] !== NUMBER_WORDS[word]) {
      tie = true
    }
  }
  return best !== null && !tie && bestScore >= 0.75 ? best : null
}

const HALF_SUFFIX: Record<string, true> = { половиной: true, половинкой: true }

// Finds every number in the token list: digits («10», «22,5»), word runs
// («двадцать два»), «N с половиной», «полтора». `fuzzy` repairs ASR-damaged
// numeral words but never touches a word that a caller already claimed.
export function parseNumbers (tokens: string[], fuzzy = true, isClaimed: (token: string) => boolean = () => false): NumberMention[] {
  const numberWordOf = (token: string): null | string => {
    if (token in NUMBER_WORDS) return token
    return fuzzy && !isClaimed(token) ? fuzzyNumberWord(token) : null
  }
  const mentions: NumberMention[] = []
  for (let index = 0; index < tokens.length;) {
    const token = tokens[index]
    if (/^\d+(?:[.,]\d+)?$/.test(token)) {
      mentions.push({ end: index + 1, source: 'digits', start: index, value: Number(token.replace(',', '.')) })
      index++
      continue
    }
    if (token === 'полтора' || token === 'полторы') {
      mentions.push({ end: index + 1, source: 'words', start: index, value: 1.5 })
      index++
      continue
    }
    const first = numberWordOf(token)
    if (first === null) { index++; continue }
    const run: string[] = []
    let end = index
    while (end < tokens.length) {
      const word = numberWordOf(tokens[end])
      if (word === null) break
      run.push(word)
      end++
    }
    let value = composeNumeral(run, 0).value
    if (tokens[end] === 'с' && tokens[end + 1] in HALF_SUFFIX) {
      value += 0.5
      end += 2
    }
    mentions.push({ end, source: 'words', start: index, value })
    index = end
  }
  return mentions
}

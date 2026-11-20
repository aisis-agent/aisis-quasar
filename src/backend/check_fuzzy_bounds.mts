// Offline check: the fuzzy-ru primitives stay cheap on attacker-sized text. One huge word (or a huge number of
// words) heard by the Station or typed into a text turn must not stall the single process that serves every
// speaker. Exits 1 on any failure. Run: node_modules/.bin/tsx src/backend/check_fuzzy_bounds.mts
import ha from './ha-intents.ts'
import fz from './fuzzy-ru.ts'

const { editDistance, normalize, splitSentences, tokenize, wordSimilarity } = fz
let failures = 0

function check (name: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` (${detail})`}`)
}

function timed<T> (run: () => T): { ms: number, value: T } {
  const start = performance.now()
  const value = run()
  return { ms: performance.now() - start, value }
}

// The full-matrix optimal-string-alignment distance this module had before the rolling rows.
function referenceDistance (a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      let best = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2][j - 2] + 1)
      rows[i][j] = best
    }
  }
  return rows[a.length][b.length]
}

// 1. Real words: the rolling rows give exactly the old answers.
check('swap costs one edit', editDistance('гормкость', 'громкость') === 1)
check('substitution and insertion', editDistance('свет', 'сват') === 1 && editDistance('кондиционер', 'кандиционер') === 1 && editDistance('', 'абв') === 3)
let seed = 12345
// Math.imul keeps the multiply in 32 bits; the high bits are drawn because the low bits of an LCG are weak.
const next = (limit: number): number => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return (seed >>> 8) % limit }
const randomWord = (): string => Array.from({ length: next(14) }, () => 'абвг'[next(4)]).join('')
let mismatches = 0
const distinct = new Set<string>()
for (let i = 0; i < 3000; i++) {
  const a = randomWord()
  const b = randomWord()
  distinct.add(a)
  if (editDistance(a, b) !== referenceDistance(a, b)) mismatches++
}
check('the random words are varied', distinct.size > 1500, `${distinct.size} distinct of 3000`)
check('rolling rows agree with the full matrix on 3000 random pairs', mismatches === 0, `${mismatches} mismatches`)
const atBound = 'а'.repeat(64)
check('a 64-letter word is still measured', editDistance(atBound, atBound.slice(0, 63) + 'б') === 1)

// 2. Over the bound there is no table: "far apart" at once.
const huge = 'с'.repeat(1_000_000)
const far = timed(() => editDistance(huge, 'громкость'))
check('a 1M-letter word is far from any stem', far.value >= 1_000_000 - 1, `distance ${far.value}`)
check('editDistance of two 5000-letter words is instant', timed(() => editDistance('с'.repeat(5000), 'д'.repeat(5000))).ms < 50)

// 3. normalize, the entry point of every router, refuses text over the bounds: a remainder must never be routed.
const words = (count: number, word = 'а'): string => Array.from({ length: count }, () => word).join(' ')
check('normalize refuses a 1M-letter word', normalize(`включи ${huge} свет`) === '')
check('a 64-letter word is a word, a 65-letter one is not', normalize('а'.repeat(64)) === 'а'.repeat(64) && normalize('а'.repeat(65)) === '')
check('a phrase of 200 words is kept, 201 words are refused', tokenize(normalize(words(200))).length === 200 && normalize(words(201)) === '')
check('words joined by commas count as the tokenizer splits them', normalize(`громкость 10 ${'пожалуйста,пожалуйста '.repeat(100)}`) === '')
check('16 sentences are kept, 17 are refused', normalize('Раз. '.repeat(16)) !== '' && normalize('Раз. '.repeat(17)) === '')
check('16 sentences are routed one by one, 17 are not routed at all', splitSentences('Раз. '.repeat(16)).length === 16 && splitSentences('Раз. '.repeat(17)).length === 0)
const dots = timed(() => normalize('.'.repeat(100_000) + 'а').replace(/[.\s]+$/, ''))
check('a 100k-dot run never reaches the calculator\'s trailing-dot cleanup (quadratic: 2.5 s at 60k)', normalize('.'.repeat(100_000) + 'а') === '' && splitSentences('.'.repeat(100_000) + 'а').length === 0 && dots.ms < 100, `${dots.ms.toFixed(0)} ms`)
check('up to 2000 characters are kept, more are refused', normalize(`${'а'.repeat(60)} `.repeat(32).trim()) !== '' && normalize(`${'а'.repeat(60)} `.repeat(33).trim()) === '')
check('ordinary phrases are untouched', normalize('  Включи свет в гостиной, пожалуйста. Ёлка 22,5 ') === 'включи свет в гостиной, пожалуйста. елка 22,5')
const similar = timed(() => wordSimilarity(huge, 'громкость'))
check('wordSimilarity of a 1M-letter word is instant', similar.ms < 100 && similar.value === 0, `${similar.ms.toFixed(0)} ms`)

// 4. The real routing with hostile text.
const areaByEntity = new Map([['light.gostinaia_potolok', 'Гостиная'], ['switch.kettle_plug_local', 'Кухня'], ['climate.kondei_1', 'Гостиная']])
const entities = new Map([...areaByEntity.keys()].map(id => [id, { attributes: { friendly_name: id }, entity_id: id, state: 'off' }]))
const reg = { areaByEntity, entities, fetchedAt: Date.now() }
const oneWord = timed(() => ha.decideFastIntent(`включи ${'с'.repeat(300_000)}`, reg))
check('decideFastIntent on one 300k-letter word returns within 500 ms', oneWord.ms < 500, `${oneWord.ms.toFixed(0)} ms, tier ${oneWord.value.tier}`)
const manyWords = timed(() => ha.decideFastIntent(Array.from({ length: 100_000 }, () => 'включиии').join(' '), reg))
check('decideFastIntent on 100k words returns within 500 ms', manyWords.ms < 500, `${manyWords.ms.toFixed(0)} ms, tier ${manyWords.value.tier}`)
const manySentences = timed(() => ha.decideFastIntent('абвг дежз ийкл. '.repeat(2000), reg))
check('decideFastIntent on 2000 sentences returns within 500 ms', manySentences.ms < 500, `${manySentences.ms.toFixed(0)} ms, tier ${manySentences.value.tier}`)
// What the refusal must not turn into: a command read from the remainder of an over-long text.
check('a cut-off command is asked again', ha.decideFastIntent('включи кондиционер на', reg).tier === 'reprompt')
check('a volume phrase is executed', ha.decideFastIntent('громкость 10', reg).tier === 'execute')
const hostile: Record<string, string> = {
  'a cut-off command behind 198 filler words': `включи кондиционер ${'пожалуйста '.repeat(198)}на`,
  'a cut-off volume phrase behind 198 filler words': `максимальная громкость ${'пожалуйста '.repeat(198)}на`,
  'a numeral of 65 digits (10 after the zeros)': `громкость ${'0'.repeat(63)}10`,
  'a cut-off command in the 17th sentence': `${'абвг дежз ийкл. '.repeat(16)}включи кондиционер на. абвг дежз ийкл.`,
  'a reversing verb in the 17th sentence': `включи. ${'бла. '.repeat(15)}выключи чайник`,
  'a volume command in the FIRST of 17 sentences': `громкость 10. ${'бла. '.repeat(16)}`,
  'a volume command before a 65-letter word in the next sentence': `громкость 10. ${'а'.repeat(65)}`,
  'a volume command before 210 words spread over 16 sentences': `громкость 10. ${`${'слово '.repeat(14)}. `.repeat(15)}`
}
for (const [name, text] of Object.entries(hostile)) {
  const decision = ha.decideFastIntent(text, reg)
  check(`${name} is not executed`, decision.tier !== 'execute', `tier ${decision.tier}`)
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('fuzzy bounds: all checks passed')

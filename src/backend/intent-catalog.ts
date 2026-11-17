// Declarative command catalog + fuzzy matcher for UNDERSPECIFIED utterances.
//
// The exact layer (ha-intents.ts: verb + noun grammar) handles complete commands.
// Everything it does not recognise («громкость десять» with ASR noise, «кондей 24»,
// «свет на кухню», «вклчи люстру») comes here. Instead of one more regex per phrase
// the catalog is GENERATED from the home (rooms, entity concepts, light groups,
// the climate range) plus a short list of control actions (volume, brightness,
// setpoint, light/switch on-off, media), and the utterance is scored against every
// template:
//
//   noun evidence   fuzzy stem match (edit distance / phonetic key / trigrams,
//                   fuzzy-ru.ts) or a unit word («градусов» → setpoint)
//   slot fill       number in the template's range (Duckling-style numerals),
//                   or an on/off verb for switch templates
//   coverage        unexplained words lower the score (token_set semantics)
//
// Result tiers (see decideCatalog):
//   execute  clear noun + in-range value on an `auto` control (volume, brightness,
//            setpoint) and no rival within MARGIN → run now, earcon instead of speech
//   confirm  one clear best but weaker evidence («Сделать громкость 10?»), yes/no
//   clarify  exactly two PROBABLE rivals within MARGIN («Громкость или яркость?»; three
//            or more → reprompt) or a missing slot («Какую громкость поставить?»), answered by
//            a follow-up utterance
//   reprompt something command-like but no probable candidate (rivals tie below
//            PROBABLE_THRESHOLD, or too many probable rivals): «Повтори?», never a list of guesses
//   none     nothing close → the LLM brain
//
// Pure module: the home enters only through `World`, so the corpus runner and the
// production path share exactly this code.

import { bestPhraseMatch, bestWordMatch, NumberMention, parseNumbers, tokenize, wordSimilarity } from './fuzzy-ru'
import { hasCommandVerb, parseClock, type SettingEntry, settingTemplates, type SettingValue } from './settings-voice'

export interface DeviceIntent {
  kind: 'off' | 'on' | 'set'
  label: string
  targets: string[] // entity ids; empty when wholeDomain is set
  wholeDomain?: 'light'
  brightnessPct?: number // kind 'set' on lights
  temperature?: number // kind 'set' on climate
}

export interface VolumeIntent {
  kind: 'query' | 'set'
  steps?: number // relative ask: signed multiple of the configured step (speaker.volume_step_pct): +1 «громче», -2 «намного тише»
  target?: number // absolute ask: fraction of the range
}

export type Resolved =
  | { type: 'device', device: DeviceIntent }
  | { type: 'volume', volume: VolumeIntent }
  | { type: 'brain', text: string } // execute by routing canonical text to the LLM brain
  | { type: 'say', text: string } // read-only answer spoken on confirmation (entity queries)
  // A dashboard setting by voice (settings-voice.ts). `confirmed` is set only after the owner's «да»;
  // `ask` is the yes/no wording of a change that needs the confirmation first.
  | { type: 'setting', id: string, value: SettingValue, confirmed?: boolean, ask?: string }
  | { type: 'setting-query', id: string } // spoken answer from a live read of the value

export interface Room { area: string, declined: string, keywords: string[] }

export interface Concept { // an entity noun the user can name: люстра, глобус, телевизор…
  id: string
  label: string // accusative, for «Включить люстру?»
  stems: string[]
  targets: string[]
}

export interface World {
  rooms: Room[]
  defaultArea: string
  lights: (areas: string[] | 'all') => string[]
  lightLabel: (areas: string[]) => string // «свет в гостиной»
  concepts: Concept[]
  acTargets: (areas: string[]) => string[]
  acLabel: (areas: string[]) => string // «кондиционер», «кондиционер наверху»
  acRange: [number, number]
  settings?: readonly SettingEntry[] // dashboard settings the owner may control by voice (settings-voice.ts)
}

export const ON_VERBS = ['включи', 'включить', 'включай', 'зажги', 'зажечь', 'вруби', 'врубить']
export const OFF_VERBS = ['выключи', 'выключить', 'выключай', 'отключи', 'отключить',
  'выруби', 'вырубить', 'потуши', 'погаси', 'погасить']
// Only the imperative and the infinitive command the home: «включи», «включите», «включить», «вруби-ка».
// «включили свет в подъезде», «кто-то включил», «включит», «включу», «выключен» tell a story or a plan and
// must never act. Matched by ending, not by whitelist, so an ASR-damaged imperative («вклчи», «включы») is
// still a command word for the fuzzy matcher.
const NARRATIVE_VERB_FORM = new RegExp('^(?:' +
  '(?:включ|выключ|отключ|вруб|выруб|потуш|погас)(?:ил[аои]?|ал[аио]?|али|ит|ишь|у|ат|ут|ют|ят|ает|ают|аешь|ается|ится|иться|ился|илась|ились|ен[аоы]?|ён|ав|ив|ая|ившись)' +
  '|зажг(?:ли|ла|ло|л|ут|у)|зажёг|зажег|зажж(?:ёт|ет|у|ём|ем|ёшь|ешь)|погасл[аио]?|погас' +
  ')$')

/** True for a form of an on/off verb that is NOT a command (past, present, future, participle…). */
export function isNarrativeVerbForm (token: string): boolean {
  return NARRATIVE_VERB_FORM.test(token.replace(/-ка$/, ''))
}

export const LIGHT_WORDS = ['свет', 'освещени', 'лампочк', 'ламп', 'ночник', 'светильник']

// ── Utterance ────────────────────────────────────────────────────────────────

const SET_VERBS = ['постав', 'сдела', 'установ', 'выстав', 'задай', 'измени', 'настрои', 'выстави', 'хочу', 'нужн', 'давай']
const FILLERS = ['пожалуйста', 'пожалуиста', 'алиса', 'яндекс', 'ну', 'а', 'и', 'эй', 'мне', 'нам', 'бы', 'ка', 'там',
  'тут', 'плиз', 'быстро', 'сейчас', 'теперь', 'только', 'можешь', 'можно', 'будь', 'добр', 'пожалуи', 'вот', 'еще',
  'смотри', 'слушай', 'глянь', 'короче', 'значит', 'ладно', 'окей', 'вообще', 'просто', 'же', 'ведь']
const PREPOSITIONS = ['на', 'в', 'во', 'до', 'по', 'с', 'у', 'для', 'при', 'около', 'где']
const UNIT_WORDS = ['процент', 'градус', 'уровен', 'значени', 'балл', 'деления', 'делени', 'единиц', 'цельси']
const ROOM_WORDS = ['комнат', 'этаж', 'втором', 'второй', 'наверх', 'квартир', 'везде', 'всюду', 'все', 'всех', 'весь', 'всю', 'всем', 'всей']
// Question words: an utterance asking something is never an underspecified command.
const QUESTION_WORDS = ['какой', 'какая', 'какие', 'какое', 'сколько', 'что', 'чего', 'почему', 'когда', 'где', 'зачем',
  'как', 'ли', 'кто', 'чем', 'куда', 'скажи', 'расскажи', 'покажи', 'напомни', 'разбуди']
const MAX_TOKENS = 8

export interface Utterance {
  tokens: string[]
  numbers: NumberMention[]
  areas: string[]
  everywhere: boolean
  roomKeywords: string[]
}

function startsWithAny (token: string, stems: string[]): boolean {
  return stems.some(stem => token === stem || (stem.length >= 3 && token.startsWith(stem)))
}

// `vocabulary`: words that belong to some template. A word close to one of them is
// never read as a damaged numeral («звук» must not become «сорок»).
export function parseUtterance (normalized: string, rooms: Room[], vocabulary: string[]): Utterance {
  const tokens = tokenize(normalized.replace(/(\d)\s*%/g, '$1 процентов'))
  const claimed = (token: string): boolean => vocabulary.some(stem => wordSimilarity(token, stem) >= 0.8)
  const text = tokens.join(' ')
  return {
    areas: rooms.filter(room => room.keywords.some(keyword => text.includes(keyword))).map(room => room.area),
    everywhere: tokens.some(token => ['все', 'всех', 'всё', 'весь', 'всю', 'везде', 'всюду'].includes(token)),
    numbers: parseNumbers(tokens, true, claimed),
    roomKeywords: rooms.flatMap(room => room.keywords),
    tokens
  }
}

// ── Templates ────────────────────────────────────────────────────────────────

export interface Noun { stem: string, weight: number } // `stem` may be a phrase of space-separated stems («тих час»)

export interface Bound {
  resolved: Resolved
  question: string // yes/no wording: «Сделать громкость 10?»
  choiceName: string // wording inside «Громкость 10 или яркость 10?»
  ask?: boolean // the change must be confirmed (yes/no) whatever the score
}

export interface SlotFill {
  value?: number // number slot; minutes since midnight for a clock
  verb?: 'off' | 'on'
  choice?: string // enum option value
}

export interface Choice { value: string, phrases: string[] }

export interface Template {
  id: string
  name: string // nominative: «громкость колонки»
  nouns: Noun[]
  units: string[] // unit stems that stand in for the noun («градусов»)
  context: string[] // words that belong to the template but carry no meaning («колонки», «света»)
  slot: 'clock' | 'enum' | 'none' | 'number' | 'onoff'
  range?: [number, number]
  clamp?: boolean // number slot: a value outside the range is bound clamped (and asked), not rejected
  choices?: Choice[] // enum slot: the options, each as stem phrases
  needsCommandVerb?: boolean // only a phrase with a command verb («поставь», «включи»…) counts
  absorbRest?: boolean // every other word is part of the value («смени ключ …»): never a stray
  auto: boolean // may execute silently at high confidence
  slotPrompt: (u: Utterance) => string
  bind: (u: Utterance, slot: SlotFill) => Bound | null
}

const EXEC_THRESHOLD = 0.8
const CONFIRM_THRESHOLD = 0.55
const MARGIN = 0.15
// A candidate worth saying aloud; below it a lone best is still asked yes/no, but is
// never listed next to rivals. At most MAX_LISTED (two) options are ever enumerated.
const PROBABLE_THRESHOLD = 0.65
const MAX_LISTED = 2
// Whatever the speaker asks aloud stays this short; the corpus checks it on every row.
const MAX_QUESTION_WORDS = 6
const STRAY_PENALTY = 0.25

function plural (value: number, forms: [string, string, string]): string {
  if (!Number.isInteger(value)) return forms[1]
  const mod100 = value % 100
  const mod10 = value % 10
  if (mod100 >= 11 && mod100 <= 14) return forms[2]
  if (mod10 === 1) return forms[0]
  if (mod10 >= 2 && mod10 <= 4) return forms[1]
  return forms[2]
}

function say (value: number): string {
  return String(value).replace('.', ',')
}

function volumeTemplate (): Template {
  return {
    auto: true,
    bind: (_u, { value }) => {
      if (value === undefined) return null
      // «громкость 5» = Alice 0..10 scale, «громкость 50» = percent.
      const target = value <= 10 ? value / 10 : value / 100
      const level = Math.min(10, Math.max(1, Math.round(target * 10)))
      const spoken = value <= 10 ? `громкость ${level}` : `громкость ${say(value)} ${plural(value, ['процент', 'процента', 'процентов'])}`
      return {
        choiceName: spoken,
        question: `Сделать ${spoken}?`,
        resolved: { type: 'volume', volume: { kind: 'set', target } }
      }
    },
    context: ['колонк', 'станци', 'звука', 'музык'],
    id: 'volume.set',
    name: 'громкость колонки',
    nouns: [{ stem: 'громкост', weight: 1 }, { stem: 'звук', weight: 1 }, { stem: 'громкаст', weight: 1 }],
    range: [1, 100],
    slot: 'number',
    slotPrompt: () => 'Какую громкость поставить?',
    units: ['процент', 'уровен']
  }
}

function brightnessTemplate (world: World): Template {
  return {
    auto: true,
    bind: (u, { value }) => {
      if (value === undefined) return null
      const pct = Math.round(value)
      const areas = u.areas.length > 0 ? u.areas : [world.defaultArea]
      const targets = world.lights(u.everywhere ? 'all' : areas)
      if (targets.length === 0) return null
      const where = u.everywhere ? 'везде' : world.rooms.filter(room => areas.includes(room.area)).map(room => room.declined).join(' и ')
      const spoken = `яркость ${pct} ${plural(pct, ['процент', 'процента', 'процентов'])}${u.areas.length > 0 || u.everywhere ? ` ${where}` : ''}`
      return {
        choiceName: spoken,
        question: `Сделать ${spoken}?`,
        resolved: { device: { brightnessPct: pct, kind: 'set', label: 'яркость', targets }, type: 'device' }
      }
    },
    context: ['света', 'освещения', 'лампы', 'лампочки', 'свет', 'лампу'],
    id: 'light.brightness',
    name: 'яркость света',
    // «свет 50» is plausible but weaker than «яркость 50».
    nouns: [{ stem: 'яркост', weight: 1 }, { stem: 'свет', weight: 0.75 }, { stem: 'освещени', weight: 0.75 }],
    range: [1, 100],
    slot: 'number',
    slotPrompt: () => 'Какую яркость поставить?',
    units: ['процент']
  }
}

function setpointTemplate (world: World): Template {
  const [min, max] = world.acRange
  return {
    auto: true,
    bind: (u, { value }) => {
      if (value === undefined) return null
      const areas = u.areas
      const targets = world.acTargets(areas)
      if (targets.length === 0) return null
      const label = world.acLabel(areas)
      const spoken = `${label} на ${say(value)} ${plural(value, ['градус', 'градуса', 'градусов'])}`
      return {
        choiceName: `температура ${say(value)}`,
        question: `Поставить ${spoken}?`,
        resolved: { device: { kind: 'set', label, targets, temperature: value }, type: 'device' }
      }
    },
    context: ['воздуха', 'комнате'],
    id: 'climate.setpoint',
    name: 'температура кондиционера',
    nouns: [{ stem: 'температур', weight: 1 }, { stem: 'кондиц', weight: 1 }, { stem: 'конде', weight: 1 },
      { stem: 'сплит', weight: 1 }, { stem: 'климат', weight: 1 }],
    range: [min, max],
    slot: 'number',
    slotPrompt: () => 'Какую температуру поставить?',
    units: ['градус']
  }
}

function toggleTemplate (id: string, name: string, stems: string[], label: (u: Utterance) => string,
  targets: (u: Utterance) => { targets: string[], wholeDomain?: 'light' } | null): Template {
  return {
    auto: false,
    bind: (u, { verb }) => {
      if (verb === undefined) return null
      const resolved = targets(u)
      if (resolved === null) return null
      const what = label(u)
      const word = verb === 'on' ? 'Включить' : 'Выключить'
      return {
        choiceName: `${verb === 'on' ? 'включить' : 'выключить'} ${what}`,
        question: `${word} ${what}?`,
        resolved: { device: { kind: verb, label: what, ...resolved }, type: 'device' }
      }
    },
    context: [],
    id,
    name,
    nouns: stems.map(stem => ({ stem, weight: 1 })),
    slot: 'onoff',
    slotPrompt: u => `Включить или выключить ${label(u)}?`,
    units: []
  }
}

function brainTemplate (id: string, name: string, stems: string[], canonical: string, question: string, context: string[]): Template {
  return {
    auto: false,
    bind: () => ({ choiceName: name, question, resolved: { text: canonical, type: 'brain' } }),
    context,
    id,
    name,
    nouns: stems.map(stem => ({ stem, weight: 1 })),
    slot: 'onoff', // no slot to fill: evaluated as complete
    slotPrompt: () => question,
    units: []
  }
}

// Generated from the home: one switch template per entity concept that exists in
// the registry, one per light group, AC; plus the control actions.
export function buildCatalog (world: World): Template[] {
  const templates: Template[] = [volumeTemplate(), brightnessTemplate(world), setpointTemplate(world)]
  templates.push(toggleTemplate('light.switch', 'свет', LIGHT_WORDS,
    u => u.everywhere ? 'весь свет' : world.lightLabel(u.areas.length > 0 ? u.areas : [world.defaultArea]),
    u => {
      if (u.everywhere) return { targets: [], wholeDomain: 'light' }
      const targets = world.lights(u.areas.length > 0 ? u.areas : [world.defaultArea])
      return targets.length > 0 ? { targets } : null
    }))
  templates.push(toggleTemplate('climate.switch', 'кондиционер', ['кондиц', 'конде', 'сплит', 'климат'],
    u => world.acLabel(u.areas),
    u => {
      const targets = world.acTargets(u.areas)
      return targets.length > 0 ? { targets } : null
    }))
  for (const concept of world.concepts) {
    if (concept.targets.length === 0) continue
    templates.push(toggleTemplate(`entity.${concept.id}`, concept.label, concept.stems, () => concept.label,
      () => ({ targets: concept.targets })))
  }
  templates.push(
    brainTemplate('media.pause', 'пауза', ['пауз', 'пауза'], 'поставь на паузу', 'Поставить на паузу?', []),
    brainTemplate('media.next', 'следующий трек', ['следующ', 'дальше'], 'следующий трек', 'Включить следующий трек?', ['трек', 'серия', 'серию', 'песн', 'композици']),
    brainTemplate('media.previous', 'предыдущий трек', ['предыдущ'], 'предыдущий трек', 'Включить предыдущий трек?', ['трек', 'серия', 'серию', 'песн', 'композици']),
    brainTemplate('media.play', 'продолжить', ['продолж'], 'продолжай', 'Продолжить воспроизведение?', [])
  )
  return [...templates, ...settingTemplates(world.settings ?? [], templates.flatMap(template => template.nouns.map(noun => noun.stem)))]
}

// ── Scoring ──────────────────────────────────────────────────────────────────

export interface Candidate {
  template: Template
  score: number
  nounScore: number
  complete: boolean
  needs: 'choice' | 'none' | 'number' | 'verb'
  exact: boolean // every word explained by an exact (stem) match: nothing for fuzzy to add
  bound: Bound | null
  nounTokens: number[]
  stray: number
  slotValue?: number
}

// «вкл»/«выкл» are real spoken abbreviations; not added to ON_VERBS/OFF_VERBS because
// the exact layer matches those by plain prefix («вкл» would catch «вклад»).
const ON_STEMS = [...ON_VERBS, 'вкл']
const OFF_STEMS = [...OFF_VERBS, 'выкл']

// index >= 0 whenever some word is close to a verb; `verb` is set only when the
// on/off decision is unambiguous («вылючи» is one letter from both → clarify).
function matchVerb (tokens: string[], claimed: Set<number>): { index: number, score: number, verb: 'off' | 'on' | undefined } {
  let on = { index: -1, score: 0 }
  let off = { index: -1, score: 0 }
  tokens.forEach((token, index) => {
    if (claimed.has(index) || isNarrativeVerbForm(token)) return
    for (const stem of ON_STEMS) {
      // Same first two letters as the stem breaks a tie: «вклчи» is «включи», not «выключи».
      const score = wordSimilarity(token, stem) + (token.slice(0, 2) === stem.slice(0, 2) ? 0.05 : 0)
      if (score > on.score) on = { index, score }
    }
    for (const stem of OFF_STEMS) {
      const score = wordSimilarity(token, stem) + (token.slice(0, 2) === stem.slice(0, 2) ? 0.05 : 0)
      if (score > off.score) off = { index, score }
    }
  })
  const best = on.score > off.score ? on : off
  if (best.score < 0.8) return { index: -1, score: 0, verb: undefined }
  if (Math.abs(on.score - off.score) < 0.1) return { index: best.index, score: 0, verb: undefined }
  return { ...best, score: Math.min(1, best.score), verb: on.score > off.score ? 'on' : 'off' }
}

// The enum option an utterance names: best phrase match over the option's label and aliases; two options
// equally close are not a choice. `taken` tokens (the noun, already explained) are not offered again.
function matchChoice (template: Template, tokens: string[], taken: ReadonlySet<number>): { value: string, score: number, span: number[] } | null {
  const free = tokens.map((token, index) => taken.has(index) ? '' : token)
  const scored = (template.choices ?? []).map(choice => {
    let best = { score: 0, span: [] as number[] }
    for (const phrase of choice.phrases) {
      const match = bestPhraseMatch(free, phrase)
      if (match.score > best.score) best = match
    }
    return { span: best.span, score: best.score, value: choice.value }
  }).filter(item => item.score >= 0.85).sort((a, b) => b.score - a.score || b.span.length - a.span.length)
  const top = scored[0]
  if (top === undefined) return null
  const rival = scored[1]
  return rival !== undefined && rival.score > top.score - 0.1 && rival.span.length >= top.span.length ? null : top
}

// ASR-damaged real words that look like a media stem: «Продолжение следует…» (the
// recognizer's hallucination on silence) is not «продолжи», «следует» is not «следующий».
const NOT_MEDIA_WORDS = ['продолжение', 'продолжения', 'продолжению', 'продолжении', 'продолжается', 'следует']

function evaluate (template: Template, u: Utterance): Candidate | null {
  if (template.id.startsWith('media.') && u.tokens.some(token => NOT_MEDIA_WORDS.includes(token))) return null
  const explained = new Set<number>()
  const numberTokens = new Set<number>()
  for (const mention of u.numbers) for (let i = mention.start; i < mention.end; i++) numberTokens.add(i)
  const free = u.tokens.map((token, index) => numberTokens.has(index) ? '' : token)

  // Noun evidence: stems, or unit words standing in for the noun.
  let nounScore = 0
  let nounSpan: number[] = []
  for (const noun of template.nouns) {
    const match = bestPhraseMatch(free, noun.stem)
    const score = match.score * noun.weight
    if (score > nounScore) {
      nounScore = score
      nounSpan = match.span
    }
  }
  let viaUnit = false
  for (const unit of template.units) {
    const match = bestWordMatch(free, unit)
    const score = match.score * 0.7
    if (score > nounScore) {
      nounScore = score
      nounSpan = Array.from({ length: match.length }, (_, i) => match.index + i)
      viaUnit = true
    }
  }
  if (nounScore < CONFIRM_THRESHOLD - 0.05) return null
  for (const index of nounSpan) explained.add(index)
  if (template.needsCommandVerb === true && !hasCommandVerb(u.tokens)) return null

  let needs: Candidate['needs'] = 'none'
  let slotValue: number | undefined
  let verb: 'off' | 'on' | undefined
  let choice: string | undefined
  let slotQuality = 1
  if (template.slot === 'number' && template.range !== undefined) {
    const [min, max] = template.range
    const inRange = template.clamp === true ? u.numbers : u.numbers.filter(mention => mention.value >= min && mention.value <= max)
    if (u.numbers.length > 0 && inRange.length === 0) return null // a number, but not this template's kind of number
    if (inRange.length === 0) {
      needs = 'number'
    } else {
      const anchor = nounSpan.length > 0 ? nounSpan[0] : 0
      const chosen = [...inRange].sort((a, b) => Math.abs(a.start - anchor) - Math.abs(b.start - anchor))[0]
      slotValue = chosen.value
      for (let i = chosen.start; i < chosen.end; i++) explained.add(i)
    }
  } else if (template.slot === 'enum') {
    const found = matchChoice(template, u.tokens, explained)
    if (found === null) {
      needs = 'choice'
    } else {
      choice = found.value
      slotQuality = Math.min(1, found.score)
      for (const index of found.span) explained.add(index)
    }
  } else if (template.slot === 'clock') {
    const clock = parseClock(u.tokens)
    if (clock === null) {
      needs = 'number'
    } else {
      slotValue = clock.minutes
      for (let i = clock.start; i < clock.end; i++) explained.add(i)
    }
  } else if (template.slot === 'none' || template.id.startsWith('media.')) {
    needs = 'none'
    if (template.slot === 'none') for (const index of numberTokens) explained.add(index)
  } else {
    const found = matchVerb(u.tokens, explained)
    if (found.index >= 0) explained.add(found.index) // a damaged on/off verb is still the verb
    if (found.verb === undefined) {
      needs = 'verb'
    } else {
      verb = found.verb
      slotQuality = found.score
    }
  }

  if (template.absorbRest === true) u.tokens.forEach((_, index) => explained.add(index))

  // Words that are part of the command shape but carry no information.
  u.tokens.forEach((token, index) => {
    if (explained.has(index)) return
    if (startsWithAny(token, UNIT_WORDS) || (startsWithAny(token, [...ON_VERBS, ...OFF_VERBS]) && !isNarrativeVerbForm(token)) || FILLERS.includes(token) || PREPOSITIONS.includes(token) ||
      startsWithAny(token, SET_VERBS) || startsWithAny(token, ROOM_WORDS) ||
      template.context.some(stem => token.startsWith(stem)) || u.roomKeywords.some(keyword => token.startsWith(keyword))) {
      explained.add(index)
    }
  })

  const stray = u.tokens.length - explained.size
  // «20 градусов» alone is a set-point; «мне 30 градусов жарко» is chat.
  if (viaUnit && stray > 0) return null
  // A spoken value belongs to a set-point template, not to a plain on/off switch.
  const valuePenalty = template.slot === 'onoff' && !template.id.startsWith('media.') && u.numbers.length > 0 ? 0.7 : 1
  const score = nounScore * slotQuality * valuePenalty * Math.max(0.3, 1 - STRAY_PENALTY * stray)
  const bound = needs === 'none' ? template.bind(u, { choice, value: slotValue, verb }) : null
  if (needs === 'none' && bound === null) return null
  return {
    bound,
    complete: needs === 'none',
    exact: nounScore >= 1 && slotQuality >= 1 && stray === 0 && !viaUnit,
    needs,
    nounScore,
    nounTokens: nounSpan,
    score,
    slotValue,
    stray,
    template
  }
}


// ── Decision ─────────────────────────────────────────────────────────────────

export type CatalogDecision =
  | { tier: 'none', reason: string }
  | { tier: 'execute', resolved: Resolved, trace: string }
  | { tier: 'confirm', resolved: Resolved, question: string, trace: string }
  | { tier: 'clarify', question: string, fill: (answer: Utterance) => null | Resolved, trace: string }
  // Something command-like was heard but no candidate is probable: say «Повтори?», list nothing.
  | { tier: 'reprompt', reason: string, trace: string }

function describe (candidate: Candidate): string {
  return `${candidate.template.id}=${candidate.score.toFixed(2)}`
}

export function decideCatalog (normalized: string, world: World): CatalogDecision {
  const templates = buildCatalog(world)
  // One entry per word (a noun may be a phrase of stems): every utterance word is compared against all of them.
  const vocabulary = [...new Set([...ON_VERBS, ...OFF_VERBS, ...SET_VERBS, ...UNIT_WORDS, ...ROOM_WORDS,
    ...templates.flatMap(template => [...template.nouns.flatMap(noun => noun.stem.split(' ')), ...template.context])])]
  const u = parseUtterance(normalized, world.rooms, vocabulary)
  if (u.tokens.length === 0 || u.tokens.length > MAX_TOKENS) return { reason: 'length', tier: 'none' }
  if (u.tokens.some(token => QUESTION_WORDS.includes(token))) return { reason: 'question', tier: 'none' }
  const candidates = templates.map(template => evaluate(template, u)).filter((c): c is Candidate => c !== null)
    .sort((a, b) => b.score - a.score)
  if (candidates.length === 0) return { reason: 'no-noun', tier: 'none' }
  const trace = candidates.slice(0, 3).map(describe).join(' ')

  const complete = candidates.filter(candidate => candidate.complete && candidate.score >= CONFIRM_THRESHOLD)
  // Two controls each claiming their own words and number («громкость 5 яркость 50»)
  // is a compound command: the brain handles it, never a guess.
  const strong = complete.filter(candidate => candidate.nounScore >= 0.85 && candidate.slotValue !== undefined)
  if (strong.length >= 2 && strong[0].nounTokens.every(token => !strong[1].nounTokens.includes(token))) {
    return { reason: 'compound', tier: 'none' }
  }

  const best = complete[0]
  if (best !== undefined) {
    // Probable = strong enough to be worth saying aloud. Rivals below the bar are
    // noise («70 кроцентов» → громкость 0.60 / яркость 0.60) and never enumerated:
    // one probable → a plain yes/no, none → «Повтори?» instead of a guess list.
    const rivals = complete.slice(1).filter(candidate => best.score - candidate.score < MARGIN)
    if (best.score < PROBABLE_THRESHOLD && rivals.length > 0) return { reason: 'improbable-tie', tier: 'reprompt', trace }
    const close = [best, ...rivals.filter(candidate => candidate.score >= PROBABLE_THRESHOLD)]
    // Three or more probable rivals mean the phrase says too little to ask about: «Повтори?».
    if (close.length > MAX_LISTED) return { reason: 'too-many-rivals', tier: 'reprompt', trace }
    if (close.length === 1) {
      const bound = best.bound!
      if (best.template.id.startsWith('media.') && best.exact) return { reason: 'exact-media', tier: 'none' }
      if (best.template.auto && best.score >= EXEC_THRESHOLD && bound.ask !== true) {
        return { resolved: bound.resolved, tier: 'execute', trace }
      }
      return { question: bound.question, resolved: bound.resolved, tier: 'confirm', trace }
    }
    const list = (names: string[]): string => {
      const sentence = `${names.join(' или ')}?`
      return sentence[0].toUpperCase() + sentence.slice(1)
    }
    // At most MAX_QUESTION_WORDS: «Громкость 50 процентов или яркость 50 процентов?» → «Громкость или яркость?»
    let question = list(close.map(candidate => candidate.bound!.choiceName))
    if (question.split(/\s+/).length > MAX_QUESTION_WORDS) {
      const heads = close.map(candidate => candidate.template.name.split(' ')[0])
      // Two settings that start with the same word («яркость света / яркость подсветки») are told apart by their whole name.
      question = list(new Set(heads).size === heads.length ? heads : close.map(candidate => candidate.template.name))
    }
    return {
      fill: answer => pickChoice(close, answer),
      question,
      tier: 'clarify',
      trace
    }
  }

  // A clear noun with a missing slot: noun-only utterance («громкость», «люстра»).
  // Noun-only «кондей»: asking on/off beats asking for a number.
  const missing = candidates.filter(candidate => !candidate.complete && candidate.nounScore >= 0.85 && candidate.stray === 0 && u.tokens.length <= 4)
    .sort((a, b) => b.score - a.score || (a.needs === 'verb' ? -1 : 0) - (b.needs === 'verb' ? -1 : 0))[0]
  if (missing !== undefined) {
    const template = missing.template
    return {
      fill: answer => fillSlot(template, u, answer),
      question: template.slotPrompt(u),
      tier: 'clarify',
      trace
    }
  }
  return { reason: 'weak', tier: 'none' }
}

// The follow-up to a missing-slot question: a number, an option, a time of day (or an on/off verb).
function fillSlot (template: Template, original: Utterance, answer: Utterance): null | Resolved {
  const merged = { ...original, ...answer, areas: original.areas.length > 0 ? original.areas : answer.areas }
  if (template.slot === 'enum') {
    const found = matchChoice(template, answer.tokens, new Set())
    return found === null ? null : template.bind(merged, { choice: found.value })?.resolved ?? null
  }
  if (template.slot === 'clock') {
    const clock = parseClock(answer.tokens)
    return clock === null ? null : template.bind(merged, { value: clock.minutes })?.resolved ?? null
  }
  if (template.slot === 'number' && template.range !== undefined) {
    const [min, max] = template.range
    const mention = answer.numbers.find(item => template.clamp === true || item.value >= min && item.value <= max)
    return mention === undefined ? null : template.bind(merged, { value: mention.value })?.resolved ?? null
  }
  const found = matchVerb(answer.tokens, new Set())
  if (found.verb === undefined) return null
  return template.bind(merged, { verb: found.verb })?.resolved ?? null
}

// The follow-up to «Громкость 10 или яркость 10?»: the noun that names one option.
function pickChoice (options: Candidate[], answer: Utterance): null | Resolved {
  const scored = options.map(option => ({
    option,
    score: Math.max(0, ...option.template.nouns.map(noun => bestPhraseMatch(answer.tokens, noun.stem).score),
      ...option.template.units.map(unit => bestWordMatch(answer.tokens, unit).score))
  })).sort((a, b) => b.score - a.score)
  if (scored[0].score < 0.85 || scored.length > 1 && scored[0].score - scored[1].score < 0.1) return null
  return scored[0].option.bound!.resolved
}

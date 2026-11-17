// Entity-name state queries: «Что со стрелицией?», «как стрелиция», «сколько
// влажность у стрелиции», «какая температура на улице».
//
// Pure and synchronous: the caller (ha-intents.ts) passes the Home Assistant
// registry maps it already holds; nothing here performs I/O and nothing here can
// ever execute a service call — it only READS state and phrases it in Russian.
//
// Pipeline:
//   1. parse the utterance into scaffold («что со», «какая … у»), measure
//      (влажность, температура, …) and subject words (the rest);
//   2. entities are clustered into «subjects» (devices) by the first token of
//      their entity id («strelitsiia», «strelitzia» → one plant), with a display
//      name taken from the Russian friendly names;
//   3. every subject word is matched against subject names with Russian
//      inflection stripping, Latin→Cyrillic transliteration and the phonetic /
//      edit-distance similarity from fuzzy-ru.ts (the same one the command
//      catalog uses), so ASR slips like «стерлица» still land on «Стрелиция»;
//   4. a confident match is answered from state + attributes + units +
//      last_changed; a doubtful one becomes «Ты про Стрелицию?» whose answer is
//      spoken on «да».

import { editDistance, normalize, NUMBER_WORDS, phoneticKey, tokenize, trigramDice } from './fuzzy-ru'

export interface EntityLike {
  attributes: Record<string, unknown>
  entity_id: string
  last_changed?: string
  last_updated?: string
  state: string
}

export interface EntityQueryResult {
  // Spoken on «да» for kind 'confirm'.
  answerText?: string
  confidence: number
  entityId?: string
  // 'reprompt': a state question whose subject matches too many devices equally well to
  // list (more than MAX_LISTED): the caller says «Повтори?», it enumerates nothing.
  kind: 'answer' | 'confirm' | 'none' | 'reprompt'
  // The answer, or the clarifying question for 'confirm'.
  text: string
}

const NONE: EntityQueryResult = { confidence: 0, kind: 'none', text: '' }

export const ANSWER_CONFIDENCE = 0.8
export const CONFIRM_CONFIDENCE = 0.7
// At most this many candidate devices are ever read out as «Ты про A или B?».
export const MAX_LISTED = 2

// ── Text primitives ──────────────────────────────────────────────────────────

const LAT_MULTI: [string, string][] = [
  ['shch', 'щ'], ['tsch', 'ч'], ['sch', 'ш'], ['kh', 'х'], ['zh', 'ж'], ['ch', 'ч'], ['sh', 'ш'],
  ['ts', 'ц'], ['tz', 'ц'], ['yu', 'ю'], ['ya', 'я'], ['yo', 'ё'], ['ye', 'е'], ['ph', 'ф'],
  ['th', 'т'], ['ck', 'к'], ['ee', 'и'], ['oo', 'у'], ['ia', 'ия'], ['ie', 'ие'], ['iu', 'ию']
]
const LAT_SINGLE: Record<string, string> = {
  a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'ж', k: 'к', l: 'л',
  m: 'м', n: 'н', o: 'о', p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс',
  y: 'и', z: 'з'
}

// Latin letters → Cyrillic as a Russian ear would hear them; digits and
// Cyrillic pass through. «strelitsiia» and «Strelitzia» both end up «стрелиция»-ish.
export function latinToCyrillic (word: string): string {
  let out = ''
  let index = 0
  scan: while (index < word.length) {
    for (const [lat, cyr] of LAT_MULTI) {
      if (word.startsWith(lat, index)) {
        out += cyr
        index += lat.length
        continue scan
      }
    }
    const char = word[index]
    out += LAT_SINGLE[char] ?? char
    index++
  }
  return out
}

const hasLatin = (word: string): boolean => /[a-z]/.test(word)

// Inflection endings, longest first; a stem keeps at least 3 letters.
const ENDINGS = ['иями', 'ями', 'ами', 'ией', 'иях', 'ому', 'ого', 'ему', 'его', 'ыми', 'ими', 'ией',
  'ой', 'ей', 'ий', 'ый', 'ая', 'яя', 'ое', 'ее', 'ие', 'ые', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях',
  'ов', 'ев', 'ию', 'ия', 'ии', 'ью', 'ею', 'ою', 'ую', 'юю', 'ы', 'и', 'а', 'я', 'у', 'ю', 'е', 'о', 'ь', 'й']

export function stemRu (word: string): string {
  if (/\d/.test(word) || word.length < 5) return word
  for (const ending of ENDINGS) {
    if (word.length - ending.length >= 3 && word.endsWith(ending)) return word.slice(0, -ending.length)
  }
  return word
}

// Similarity of two words (query word vs name word) in 0..1.
export function nameSimilarity (queryWord: string, nameWord: string): number {
  if (queryWord === nameWord) return 1
  if (/\d/.test(queryWord) || /\d/.test(nameWord)) return 0
  const left = stemRu(queryWord)
  const right = stemRu(nameWord)
  if (left === right) return 0.98
  const shortest = Math.min(left.length, right.length)
  if (shortest < 4) return 0
  const leftKey = phoneticKey(left)
  const rightKey = phoneticKey(right)
  const phoneticDistance = editDistance(leftKey, rightKey)
  if (shortest < 6) {
    // Short stems («свет»/«сват») are false friends: only the vowel-reduction
    // and ending slips the phonetic key already erases count.
    return phoneticDistance === 0 ? 0.95 : 0
  }
  const longest = Math.max(left.length, right.length)
  let best = 1 - editDistance(left, right) / longest
  best = Math.max(best, 1 - phoneticDistance / Math.max(leftKey.length, rightKey.length, 4))
  best = Math.max(best, 0.9 * trigramDice(left, right))
  return best < 0.7 ? 0 : Math.min(best, 0.96)
}

// ── Vocabulary ───────────────────────────────────────────────────────────────

type Measure = 'battery' | 'energy' | 'health' | 'humidity' | 'level' | 'power' | 'pressure' | 'progress' | 'temperature' | 'watering'

const MEASURE_STEMS: [string, Measure][] = [
  ['влажн', 'humidity'], ['температур', 'temperature'], ['градус', 'temperature'], ['тепло', 'temperature'],
  ['холодно', 'temperature'], ['жарко', 'temperature'], ['давлен', 'pressure'], ['заряд', 'battery'],
  ['батаре', 'battery'], ['аккумулят', 'battery'], ['мощност', 'power'], ['потребля', 'power'],
  ['ватт', 'power'], ['энерги', 'energy'], ['киловатт', 'energy'], ['расход', 'energy'], ['полив', 'watering'],
  ['полит', 'watering'], ['поливать', 'watering'], ['здоров', 'health'], ['самочувств', 'health'],
  ['прогресс', 'progress'], ['уровен', 'level']
]

const MEASURE_WORD: Record<Measure, string> = {
  battery: 'заряд', energy: 'энергия', health: 'здоровье', humidity: 'влажность', level: 'уровень',
  power: 'мощность', pressure: 'давление', progress: 'прогресс', temperature: 'температура', watering: 'полив'
}

// Words that are query scaffolding, not part of the subject.
const SCAFFOLD = new Set(['что', 'как', 'какой', 'какая', 'какое', 'какие', 'каков', 'какова', 'каково', 'сколько',
  'скажи', 'скажите', 'расскажи', 'покажи', 'проверь', 'проверить', 'глянь', 'посмотри', 'узнай', 'дай', 'мне',
  'нам', 'там', 'тут', 'сейчас', 'сегодня', 'в', 'во', 'на', 'у', 'со', 'с', 'по', 'про', 'о', 'об', 'насчет',
  'ли', 'же', 'вообще', 'текущая', 'текущий', 'текущее', 'дела', 'поживает', 'поживают', 'себя', 'чувствует',
  'чувствуют', 'происходит', 'творится', 'слышно', 'состояние', 'статус', 'показатели', 'данные', 'информация',
  'информацию', 'мой', 'моя', 'мое', 'мои', 'моего', 'моей', 'моему', 'наш', 'наша', 'нашего', 'есть', 'а', 'и',
  'алиса', 'пожалуйста', 'ну', 'вот', 'еще', 'все', 'всё', 'такое', 'самое', 'когда'])

// Whole categories belong to the command catalog, not to a named device.
const GENERIC_CATEGORY = ['свет', 'ламп', 'освещ', 'музык', 'включен', 'выключен', 'горит', 'горят', 'работа']

const PROGRAMME_WORDS = ['телев', 'телик', 'телек', 'канал', 'тв', 'радио', 'эфир']

// Subject words that are about the speaker or the world, never about a device.
const NOT_A_DEVICE = new Set(['я', 'ты', 'мы', 'вы', 'меня', 'тебя', 'нас', 'вас', 'мной', 'тобой', 'жизнь',
  'жизни', 'настроение', 'мир', 'сам', 'сама', 'день', 'ночь', 'утро', 'вечер', 'время', 'времени', 'завтра',
  'вчера', 'неделя', 'это', 'новости', 'нового'])

const COMMAND_VERBS = ['включи', 'выключи', 'поставь', 'установи', 'сделай', 'убавь', 'прибавь', 'запомни',
  'напомни', 'разбуди', 'открой', 'закрой', 'запусти', 'останови', 'смени', 'переключи', 'добавь', 'найди',
  'позвони', 'отправь', 'вруби', 'выруби', 'погаси', 'зажги', 'потуши', 'отключи', 'увеличь', 'уменьши']

const OUTDOOR_STEMS = ['улиц', 'уличн', 'снаружи', 'двор', 'окном', 'окно', 'балкон']
const WEATHER_STEMS = ['погод']
const PLANT_STEMS = ['цветок', 'цветк', 'цветочек', 'цветочк', 'цветы', 'цвет', 'растен', 'фикус', 'орхиде']

// Query word → name words it may stand for in entity names.
const SUBJECT_ALIASES: Record<string, string[]> = {
  кондиционер: ['кондей'], кондер: ['кондей'], сплит: ['кондей'], телек: ['телевизор'], лампа: ['свет'],
  лампочка: ['свет'], светильник: ['свет'], розетка: ['розетка']
}

// English words that appear in entity names → the Russian word a person says.
const EN_RU: Record<string, string> = {
  printer: 'принтер', kettle: 'чайник', plug: 'розетки', light: 'свет', lamp: 'лампа', door: 'дверь',
  window: 'окно', motion: 'движение', camera: 'камера', weather: 'погода', forecast: 'погода', fan: 'вентилятор',
  humidity: 'влажность', temperature: 'температура', battery: 'заряд', pressure: 'давление', power: 'мощность',
  energy: 'энергия', moisture: 'влажность', soil: 'почвы', progress: 'прогресс', nozzle: 'сопла', bed: 'стола',
  cavity: 'камеры', chamber: 'камеры', filament: 'пластика', online: 'на связи', level: 'уровень',
  volume: 'громкость', brightness: 'яркость', speed: 'скорость', watered: 'полив', watering: 'полив',
  health: 'здоровье', last: 'последний', next: 'следующий', name: 'название', total: 'всего', water: 'воды'
}

// Words in entity names that mark configuration or noise, never a headline value.
const NOISE_RE = /(_adc|resistance|smoothed|_index|_raw|target|max_|min_|profile|offset|calibrat|dry_|wet_|interval|heap|diagnos|_count|snooze|notes|latin_name|early_|consecutive|freshness|memory|mcu|stepper|fan)/

const SKIP_DOMAINS = new Set(['automation', 'script', 'button', 'update', 'scene', 'event', 'conversation', 'tts',
  'stt', 'notify', 'todo', 'image', 'camera', 'input_text', 'text', 'input_button', 'time', 'zone', 'device_tracker',
  'remote', 'assist_satellite', 'input_datetime', 'counter', 'person', 'input_select', 'number', 'sun'])

// ── Russian phrasing helpers ─────────────────────────────────────────────────

function plural (value: number, forms: [string, string, string]): string {
  if (!Number.isInteger(value)) return forms[1]
  const n = Math.abs(value) % 100
  const last = n % 10
  if (n > 10 && n < 20) return forms[2]
  if (last === 1) return forms[0]
  if (last >= 2 && last <= 4) return forms[1]
  return forms[2]
}

function formatNumber (value: number, decimals = 1): string {
  const fixed = Number.isInteger(value) ? String(value) : value.toFixed(decimals).replace(/\.?0+$/, '')
  return fixed.replace('.', ',')
}

const UNIT_FORMS: Record<string, [string, string, string]> = {
  '%': ['процент', 'процента', 'процентов'], '°C': ['градус', 'градуса', 'градусов'],
  '°F': ['градус по Фаренгейту', 'градуса по Фаренгейту', 'градусов по Фаренгейту'],
  W: ['ватт', 'ватта', 'ватт'], kW: ['киловатт', 'киловатта', 'киловатт'],
  kWh: ['киловатт-час', 'киловатт-часа', 'киловатт-часов'], Wh: ['ватт-час', 'ватт-часа', 'ватт-часов'],
  hPa: ['гектопаскаль', 'гектопаскаля', 'гектопаскалей'], ppm: ['ppm', 'ppm', 'ppm'],
  lx: ['люкс', 'люкса', 'люкс'], V: ['вольт', 'вольта', 'вольт'], A: ['ампер', 'ампера', 'ампер'],
  days: ['день', 'дня', 'дней'], d: ['день', 'дня', 'дней'], min: ['минута', 'минуты', 'минут'],
  h: ['час', 'часа', 'часов'], s: ['секунда', 'секунды', 'секунд'], times: ['раз', 'раза', 'раз'],
  'km/h': ['километр в час', 'километра в час', 'километров в час'], 'µg/m³': ['микрограмм', 'микрограмма', 'микрограмм']
}

function withUnit (value: number, unit: string | undefined): string {
  const rounded = unit === '%' ? Math.round(value) : value
  const number = formatNumber(rounded)
  const forms = unit === undefined ? undefined : UNIT_FORMS[unit]
  if (forms !== undefined) return `${number} ${plural(rounded, forms)}`
  return unit ? `${number} ${unit}` : number
}

const MONTHS_GENITIVE = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября',
  'октября', 'ноября', 'декабря']

function dayNumber (date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000)
}

// «2026-11-09» → «9 ноября, через 2 дня».
function speakDate (iso: string, now: Date): null | string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (match === null) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (Number.isNaN(date.getTime())) return null
  const days = dayNumber(date) - dayNumber(now)
  const base = `${date.getDate()} ${MONTHS_GENITIVE[date.getMonth()]}`
  if (days === 0) return `${base}, сегодня`
  if (days === 1) return `${base}, завтра`
  if (days === -1) return `${base}, вчера`
  if (days > 1) return `${base}, через ${days} ${plural(days, ['день', 'дня', 'дней'])}`
  return `${base}, ${-days} ${plural(-days, ['день', 'дня', 'дней'])} назад`
}

function speakAge (iso: string | undefined, now: Date): null | string {
  if (iso === undefined) return null
  const time = Date.parse(iso)
  if (Number.isNaN(time)) return null
  const minutes = Math.max(0, Math.round((now.getTime() - time) / 60_000))
  if (minutes < 2) return 'только что'
  if (minutes < 60) return `${minutes} ${plural(minutes, ['минуту', 'минуты', 'минут'])} назад`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} ${plural(hours, ['час', 'часа', 'часов'])} назад`
  const days = Math.round(hours / 24)
  return `${days} ${plural(days, ['день', 'дня', 'дней'])} назад`
}

const WEATHER_CONDITION: Record<string, string> = {
  'clear-night': 'ясно', sunny: 'солнечно', cloudy: 'облачно', partlycloudy: 'переменная облачность',
  rainy: 'дождь', pouring: 'ливень', snowy: 'снег', 'snowy-rainy': 'мокрый снег', fog: 'туман',
  windy: 'ветрено', 'windy-variant': 'ветрено и облачно', lightning: 'гроза', 'lightning-rainy': 'гроза с дождём',
  hail: 'град', exceptional: 'необычная погода'
}

const HEALTH_RU: Record<string, string> = { excellent: 'отличное', good: 'хорошее', poor: 'плохое', sick: 'больное' }

function capitalize (text: string): string {
  return text === '' ? text : text[0].toUpperCase() + text.slice(1)
}

// ── Index ────────────────────────────────────────────────────────────────────

interface Row {
  area?: string
  deviceClass?: string
  domain: string
  entity: EntityLike
  friendly: string
  objectId: string
  unit?: string
}

interface Subject {
  areas: Set<string>
  display: string
  key: string
  nameWords: string[]
  rows: Row[]
}

interface Index {
  subjects: Subject[]
}

const indexCache = new WeakMap<Map<string, EntityLike>, { areas: Map<string, string>, index: Index, size: number }>()

function attributeString (entity: EntityLike, name: string): string | undefined {
  const value = entity.attributes[name]
  return typeof value === 'string' && value !== '' ? value : undefined
}

// «про Стрелиция» → «про Стрелицию»: feminine one-word names take the accusative.
function accusative (display: string): string {
  if (!/^[А-Яа-яЁё]+$/.test(display)) return display
  if (display.endsWith('ия')) return `${display.slice(0, -1)}ю`
  if (display.endsWith('а')) return `${display.slice(0, -1)}у`
  if (display.endsWith('я')) return `${display.slice(0, -1)}ю`
  return display
}

const roomPrefixMemo = new Map<string, boolean>()

// Is this id word («gostinaia») a room name? Memoized: asked for every entity.
function roomPrefixCache (idWord: string, areaWord: string): boolean {
  const key = `${idWord}|${areaWord}`
  let known = roomPrefixMemo.get(key)
  if (known === undefined) {
    known = nameSimilarity(latinToCyrillic(idWord), areaWord) >= 0.85
    roomPrefixMemo.set(key, known)
  }
  return known
}

// «Chromecast — пульт» is the televizor entity's name in Home Assistant; the
// answer should name the thing the person asked about, so when no word of the
// display matches the question, the id word («телевизор») is spoken instead.
function spokenAs (subject: Subject, queryWords: string[]): Subject {
  const displayWords = tokenize(normalize(subject.display)).map(word => hasLatin(word) ? latinToCyrillic(word) : word)
  const matches = (word: string): boolean => queryWords.some(query => nameSimilarity(query, word) >= ANSWER_CONFIDENCE)
  if (displayWords.some(matches)) return subject
  const idWord = subject.key.split(' ').find(word => /^[а-яё]{4,}$/.test(word) && matches(word))
  return idWord === undefined ? subject : { ...subject, display: capitalize(idWord) }
}

function subjectKeyOf (objectId: string, areaWords: string[]): string {
  const parts = objectId.split('_')
  // «gostinaia_globus_…»: a room prefix is not the device; the next word is.
  const roomPrefixed = parts.length > 1 &&
    areaWords.some(word => roomPrefixCache(parts[0], word))
  const headParts = roomPrefixed ? parts.slice(1) : parts
  const digitTail = /^([a-z]{4,})(\d+)$/.exec(headParts[0])
  const first = latinToCyrillic(digitTail === null ? headParts[0] : digitTail[1])
  const second = digitTail === null ? headParts[1] : digitTail[2]
  // «printer_u1», «kondei_2», «globus3»: a short numbered suffix names a different device.
  return second !== undefined && /^(?:[a-z]?\d+[a-z]?)$/.test(second) ? `${first} ${second}` : first
}

function sameSubject (left: string, right: string): boolean {
  const [leftHead, leftTail = ''] = left.split(' ')
  const [rightHead, rightTail = ''] = right.split(' ')
  if (leftTail !== rightTail) return false
  if (leftHead === rightHead) return true
  const leftKey = phoneticKey(stemRu(leftHead))
  const rightKey = phoneticKey(stemRu(rightHead))
  return Math.min(leftKey.length, rightKey.length) >= 6 && editDistance(leftKey, rightKey) <= 1
}

// The longest shared word prefix of the largest group of names that agree on
// their first word («Стрелиция Soil moisture», «Стрелиция: Notes» → «Стрелиция»).
function commonPrefix (names: string[]): string {
  if (names.length === 0) return ''
  const clean = (word: string): string => word.toLowerCase().replace(/:$/, '')
  const groups = new Map<string, string[][]>()
  for (const name of names) {
    const words = name.split(/\s+/)
    groups.set(clean(words[0]), [...(groups.get(clean(words[0])) ?? []), words])
  }
  const largest = [...groups.values()].sort((left, right) => right.length - left.length)[0]
  let prefix = largest[0]
  for (const words of largest.slice(1)) {
    let length = 0
    while (length < prefix.length && length < words.length && clean(prefix[length]) === clean(words[length])) length++
    prefix = prefix.slice(0, length)
  }
  return prefix.join(' ').replace(/:$/, '')
}

// A display name a person would say: English device words become Russian
// («Kettle» → «Чайник»); anything else stays as named in Home Assistant.
function displayName (names: string[]): string {
  const raw = commonPrefix(names) || names[0]
  const words = raw.split(/\s+/).map(word => EN_RU[word.toLowerCase()] ?? word)
  return capitalize(words.join(' '))
}

function buildIndex (entities: Map<string, EntityLike>, areaByEntity: Map<string, string>): Index {
  const subjects: Subject[] = []
  const areaWords = [...new Set(areaByEntity.values())].flatMap(area => tokenize(normalize(area)))
  for (const [entityId, entity] of entities) {
    const domain = entityId.slice(0, entityId.indexOf('.'))
    if (SKIP_DOMAINS.has(domain)) continue
    const objectId = entityId.slice(entityId.indexOf('.') + 1)
    const friendly = attributeString(entity, 'friendly_name') ?? objectId
    const row: Row = {
      area: areaByEntity.get(entityId),
      deviceClass: attributeString(entity, 'device_class'),
      domain,
      entity,
      friendly,
      objectId,
      unit: attributeString(entity, 'unit_of_measurement')
    }
    const key = subjectKeyOf(objectId, areaWords)
    let subject = subjects.find(candidate => sameSubject(candidate.key, key))
    if (subject === undefined) {
      subject = { areas: new Set(), display: '', key, nameWords: [], rows: [] }
      subjects.push(subject)
    }
    subject.rows.push(row)
    if (row.area !== undefined) subject.areas.add(row.area)
  }
  const merged: Subject[] = []
  for (const subject of subjects) {
    const cyrillic = subject.rows.filter(row => /^[а-яё]/i.test(row.friendly)).map(row => row.friendly)
    subject.display = displayName(cyrillic.length > 0 ? cyrillic : subject.rows.map(row => row.friendly))
    // «Глобус» as a light and as an outlet is one thing to the person asking.
    const twin = merged.find(candidate => candidate.display.toLowerCase() === subject.display.toLowerCase())
    if (twin === undefined) merged.push(subject)
    else {
      twin.rows.push(...subject.rows)
      for (const area of subject.areas) twin.areas.add(area)
      twin.key = `${twin.key} ${subject.key}`
    }
  }
  for (const subject of merged) {
    const words = new Set<string>()
    for (const friendly of subject.rows.map(row => row.friendly)) {
      for (const word of tokenize(normalize(friendly)).slice(0, 2)) {
        words.add(hasLatin(word) ? latinToCyrillic(word) : word)
        if (EN_RU[word] !== undefined) words.add(EN_RU[word])
      }
    }
    for (const word of subject.key.split(' ')) words.add(word)
    for (const row of subject.rows) {
      const first = row.objectId.split('_')[0]
      if (EN_RU[first] !== undefined) words.add(EN_RU[first])
    }
    subject.nameWords = [...words]
  }
  return { subjects: merged }
}

function getIndex (entities: Map<string, EntityLike>, areaByEntity: Map<string, string>): Index {
  const cached = indexCache.get(entities)
  if (cached !== undefined && cached.size === entities.size && cached.areas === areaByEntity) return cached.index
  const index = buildIndex(entities, areaByEntity)
  indexCache.set(entities, { areas: areaByEntity, index, size: entities.size })
  return index
}

// ── Utterance parsing ────────────────────────────────────────────────────────

interface ParsedQuery {
  measure?: Measure
  outdoor: boolean
  plant: boolean
  subject: string[]
  weather: boolean
}

const startsWithAny = (word: string, stems: string[]): boolean => stems.some(stem => word.startsWith(stem))

function measureOf (word: string): Measure | undefined {
  return MEASURE_STEMS.find(([stem]) => word.startsWith(stem))?.[1]
}

function parseQuery (text: string): null | ParsedQuery {
  const tokens = tokenize(normalize(text))
  if (tokens.length === 0 || tokens.length > 9) return null
  const words = tokens[0] === 'алиса' ? tokens.slice(1) : tokens
  if (words.length === 0) return null
  if (startsWithAny(words[0], COMMAND_VERBS)) return null
  // Volume and arithmetic belong to the other layers.
  if (words.some(word => word.startsWith('громкост') || word.startsWith('звук'))) return null
  if (words.includes('будет') || words.includes('плюс') || words.includes('минус')) return null

  const measure = words.map(measureOf).find((value): value is Measure => value !== undefined)
  const outdoor = words.some(word => startsWithAny(word, OUTDOOR_STEMS))
  const weather = words.some(word => startsWithAny(word, WEATHER_STEMS))
  const plant = words.some(word => startsWithAny(word, PLANT_STEMS) && word !== 'цвет')

  const first = words[0]
  const has = (...candidates: string[]): boolean => words.some(word => candidates.includes(word))
  let gated: boolean
  if (first === 'что') {
    gated = has('с', 'со', 'по', 'там', 'у', 'про', 'насчет', 'происходит', 'творится') ||
      (words[1] === 'на' && outdoor)
  } else if (first === 'как') {
    gated = !has('пользоваться', 'называется', 'зовут', 'сделать', 'приготовить', 'добраться', 'пишется',
      'переводится', 'правильно', 'будет', 'тебя', 'ты') && words.length >= 2
  } else if (['какой', 'какая', 'какое', 'какие', 'каков', 'какова', 'каково', 'сколько'].includes(first)) {
    gated = measure !== undefined || weather || outdoor
  } else if (['скажи', 'расскажи', 'покажи', 'проверь', 'глянь', 'посмотри', 'узнай', 'дай'].includes(first)) {
    gated = true
  } else if (first === 'когда') {
    gated = measure !== undefined
  } else if (['состояние', 'статус', 'самочувствие'].includes(first)) {
    gated = true
  } else {
    gated = measure !== undefined || weather
  }
  if (!gated) return null
  // «что по телевизору / по каналу»: the programme idiom, a question for the brain.
  if (words.includes('по') && words.some(word => startsWithAny(word, PROGRAMME_WORDS))) return null

  const subject = words.filter(word => !SCAFFOLD.has(word) && measureOf(word) === undefined &&
    !startsWithAny(word, OUTDOOR_STEMS) && !startsWithAny(word, WEATHER_STEMS) && !NOT_A_DEVICE.has(word))
  if (words.some(word => NOT_A_DEVICE.has(word)) && subject.length === 0) return null
  // «что со светом», «как музыка»: whole categories belong to the command catalog.
  if (subject.some(word => startsWithAny(word, GENERIC_CATEGORY))) return null
  const normalizedSubject = subject.map(word => word in NUMBER_WORDS ? String(NUMBER_WORDS[word]) : word)
  if (normalizedSubject.length === 0 && !outdoor && !weather && measure === undefined) return null
  return { measure, outdoor, plant, subject: normalizedSubject, weather }
}

// ── Matching ─────────────────────────────────────────────────────────────────

function scoreSubject (words: string[], subject: Subject): number {
  if (words.length === 0) return 0
  let total = 0
  for (const word of words) {
    const candidates = [word, ...(SUBJECT_ALIASES[word] ?? [])]
    let best = 0
    for (const candidate of candidates) {
      for (const nameWord of subject.nameWords) best = Math.max(best, nameSimilarity(candidate, nameWord))
    }
    if (/^\d+$/.test(word) && best === 0) {
      // A wrong ordinal («кондей 2» vs «Кондей 1») must not ride on the shared name.
      return 0
    }
    total += best
  }
  return total / words.length
}

function isPlantSubject (subject: Subject): boolean {
  return subject.rows.some(row => row.entity.attributes.plant_care === true)
}

const ROOM_LOCATIVE: Record<string, string> = {
  гостиная: 'в гостиной', кухня: 'на кухне', спальня: 'в спальне', студия: 'в студии', прихожая: 'в прихожей',
  'второй этаж': 'наверху'
}

function locative (area: string): string {
  return ROOM_LOCATIVE[area.toLowerCase()] ?? `в ${area.toLowerCase()}`
}

function isRoomSubject (subject: Subject, areaByEntity: Map<string, string>): boolean {
  const display = subject.display.toLowerCase()
  for (const area of new Set(areaByEntity.values())) if (area.toLowerCase() === display) return true
  return false
}

// Does the device report this measure (sensor, climate reading, weather, plant)?
function hasMeasure (subject: Subject, measure: Measure): boolean {
  return subject.rows.some(row => row.domain === 'weather' ||
    measureOfRow(row) === measure && !isUnavailable(row.entity.state) ||
    measure === 'temperature' && typeof row.entity.attributes.current_temperature === 'number')
}

function measureOfRow (row: Row): Measure | undefined {
  const text = `${row.objectId} ${row.friendly}`.toLowerCase()
  const dc = row.deviceClass
  if (dc === 'moisture' || dc === 'humidity' || /(moisture|humidity|влажн)/.test(text)) return 'humidity'
  if (dc === 'temperature' || /(temperature|temp\b|температур)/.test(text)) return 'temperature'
  if (dc === 'battery' || /(battery|батаре|заряд)/.test(text)) return 'battery'
  if (dc === 'pressure' || /(pressure|давлен)/.test(text)) return 'pressure'
  if (dc === 'power' || /(power|мощност)/.test(text)) return 'power'
  if (dc === 'energy' || /(energy|энерги)/.test(text)) return 'energy'
  if (/(next_watering|poliv|полив)/.test(text)) return 'watering'
  if (/(health|здоров)/.test(text)) return 'health'
  if (/(progress|прогресс)/.test(text)) return 'progress'
  if (/(level|уровень)/.test(text)) return 'level'
  return undefined
}

const isUnavailable = (state: string): boolean => state === 'unavailable' || state === 'unknown' || state === ''

function numeric (entity: EntityLike): null | number {
  const value = Number(entity.state)
  return entity.state.trim() !== '' && Number.isFinite(value) ? value : null
}

function rowSortKey (row: Row): number {
  // Prefer the headline reading: right device class, unit, not a config/noise entity.
  let score = 0
  if (NOISE_RE.test(row.objectId)) score -= 10
  if (row.deviceClass !== undefined) score += 2
  if (row.unit !== undefined) score += 1
  if (row.domain === 'sensor') score += 1
  return -score
}

// ── Answers ──────────────────────────────────────────────────────────────────

// «Printer U1 Nozzle Temperature» → «температура сопла»: the measure word first,
// modifiers after it, untranslated Latin leftovers dropped when Russian remains.
function translateLabel (row: Row, display: string, measure: Measure): string {
  const words = tokenize(normalize(row.friendly))
  const displayWords = new Set(tokenize(normalize(display)))
  const rest = words.filter(word => !displayWords.has(word) && !displayWords.has(EN_RU[word] ?? word))
  const translated = rest.map(word => EN_RU[word] ?? word)
  const russian = translated.filter(word => /[а-яё]/.test(word))
  const kept = russian.length > 0 ? russian : translated
  const measureWord = MEASURE_WORD[measure]
  const modifiers = kept.filter(word => word !== measureWord && word !== 'влажность')
  if (modifiers.length === 0 || modifiers.length === kept.length) return modifiers.join(' ')
  return [measureWord, ...modifiers].join(' ')
}

const PRIMARY_DOMAINS = ['climate', 'media_player', 'light', 'switch', 'fan', 'input_boolean']

function headlineRow (subject: Subject): Row {
  return [...subject.rows].sort((left, right) => rowSortKey(left) - rowSortKey(right))[0]
}

function measureSentence (row: Row, measure: Measure, now: Date): null | string {
  const entity = row.entity
  if (isUnavailable(entity.state)) return null
  if (measure === 'watering') {
    const date = speakDate(entity.state, now)
    return date === null ? null : `следующий полив ${date}`
  }
  if (measure === 'health') {
    return `здоровье ${HEALTH_RU[entity.state] ?? entity.state}`
  }
  const value = numeric(entity)
  if (value === null) return null
  const isSoil = /(soil|moisture)/.test(row.objectId) || row.deviceClass === 'moisture'
  const noun = measure === 'humidity' && isSoil ? 'влажность почвы' : MEASURE_WORD[measure]
  return `${noun} ${withUnit(value, row.unit)}`
}

function climateSentence (row: Row): string {
  const attributes = row.entity.attributes
  const parts: string[] = [row.entity.state === 'off' ? 'выключен' : `включён, режим ${row.entity.state}`]
  const current = attributes.current_temperature
  if (typeof current === 'number') parts.push(`в комнате ${withUnit(current, '°C')}`)
  const target = attributes.temperature
  if (typeof target === 'number' && row.entity.state !== 'off') parts.push(`задано ${withUnit(target, '°C')}`)
  return parts.join(', ')
}

function switchSentence (row: Row, now: Date): null | string {
  const entity = row.entity
  if (isUnavailable(entity.state)) return 'недоступен'
  const age = speakAge(entity.last_changed, now)
  if (row.domain === 'media_player') {
    const title = attributeString(entity, 'media_title')
    if (entity.state === 'playing') return title === undefined ? 'играет' : `играет ${title}`
    if (entity.state === 'paused') return 'на паузе'
    if (entity.state === 'off') return 'выключен'
    return 'ничего не играет'
  }
  if (['light', 'switch', 'fan', 'input_boolean'].includes(row.domain)) {
    const duration = age?.replace(' назад', '')
    if (entity.state === 'on') return duration === undefined || age === 'только что' ? 'включён' : `включён, уже ${duration}`
    if (entity.state === 'off') return age === null || age === 'только что' ? 'выключен' : `выключен, ${age}`
  }
  return null
}

function binarySentence (row: Row): null | string {
  const on = row.entity.state === 'on'
  switch (row.deviceClass) {
    case 'connectivity': return on ? 'на связи' : 'не на связи'
    case 'problem': return on ? 'есть проблема' : 'проблем нет'
    case 'motion': return on ? 'движение есть' : 'движения нет'
    case 'door': case 'window': case 'opening': return on ? 'открыто' : 'закрыто'
    default: return null
  }
}

function weatherAnswer (row: Row, measure: Measure | undefined): string {
  const attributes = row.entity.attributes
  const temperature = attributes.temperature
  const humidity = attributes.humidity
  const pressure = attributes.pressure
  const wind = attributes.wind_speed
  const temperatureSpoken = typeof temperature === 'number' ? withUnit(temperature, '°C') : null
  const humiditySpoken = typeof humidity === 'number' ? withUnit(humidity, '%') : null
  const pressureSpoken = typeof pressure === 'number' ? withUnit(Math.round(pressure * 0.75006), 'мм') + ' ртутного столба' : null
  if (measure === 'temperature' && temperatureSpoken !== null) return `На улице ${temperatureSpoken}.`
  if (measure === 'humidity' && humiditySpoken !== null) return `Влажность на улице ${humiditySpoken}.`
  if (measure === 'pressure' && pressureSpoken !== null) return `Давление ${pressureSpoken}.`
  const parts: string[] = []
  const condition = WEATHER_CONDITION[row.entity.state]
  const head = [temperatureSpoken === null ? null : `На улице ${temperatureSpoken}`, condition ?? null].filter(Boolean).join(', ')
  if (head !== '') parts.push(head)
  if (humiditySpoken !== null) parts.push(`влажность ${humiditySpoken}`)
  if (typeof wind === 'number') parts.push(`ветер ${withUnit(Math.round(wind), 'km/h')}`)
  return parts.length === 0 ? 'Данных о погоде нет.' : `${capitalize(parts.join(', '))}.`
}

function plantAnswer (subject: Subject, measure: Measure | undefined, now: Date): string {
  const find = (re: RegExp): Row | undefined => subject.rows.find(row => re.test(row.objectId))
  const moisture = find(/soil_moisture$/) ?? subject.rows.find(row => row.deviceClass === 'moisture')
  const health = find(/health$/)
  const next = find(/next_watering$/)
  const last = find(/last_watered$/)
  const status = find(/poliv$/)
  const name = subject.display
  const sentences = new Map<Measure, string | null>([
    ['humidity', moisture ? measureSentence(moisture, 'humidity', now) : null],
    ['health', health ? measureSentence(health, 'health', now) : null],
    ['watering', next ? measureSentence(next, 'watering', now) : null]
  ])
  if (measure !== undefined) {
    const asked = sentences.get(measure)
    if (asked !== null && asked !== undefined) {
      const lastDate = measure === 'watering' && last && !isUnavailable(last.entity.state) ? speakDate(last.entity.state, now) : null
      return `${name}: ${asked}${lastDate === null ? '' : `, последний был ${lastDate.split(',')[0]}`}.`
    }
    return `У «${name}» нет данных про ${MEASURE_WORD[measure]}.`
  }
  const statusText: Record<string, string> = {
    ok: 'в порядке', due: 'пора поливать', overdue: 'полив просрочен', snoozed: 'полив отложен', dry: 'почва сухая'
  }
  const lead = status !== undefined && statusText[status.entity.state] !== undefined
    ? `${name} ${statusText[status.entity.state]}` : name
  const parts = [sentences.get('humidity'), sentences.get('health'), sentences.get('watering')].filter(Boolean)
  return parts.length === 0 ? `${lead}.` : `${lead}: ${parts.join(', ')}.`
}

function genericAnswer (subject: Subject, measure: Measure | undefined, now: Date): string {
  const name = subject.display
  const rows = [...subject.rows].sort((left, right) => rowSortKey(left) - rowSortKey(right))
  if (measure !== undefined) {
    const matching = rows.filter(row => measureOfRow(row) === measure && !isUnavailable(row.entity.state))
    const headline = matching.filter(row => !NOISE_RE.test(row.objectId))
    const chosen = (headline.length > 0 ? headline : matching).slice(0, 2)
    const sentences = chosen.map(row => measureSentence(row, measure, now)).filter((text): text is string => text !== null)
    if (sentences.length > 0) {
      return `${name}: ${sentences.join(', ')}.`
    }
    const climate = rows.find(row => row.domain === 'climate' && typeof row.entity.attributes.current_temperature === 'number')
    if (measure === 'temperature' && climate !== undefined) {
      return `${name}: ${withUnit(climate.entity.attributes.current_temperature as number, '°C')}.`
    }
    return `У «${name}» нет данных про ${MEASURE_WORD[measure]}.`
  }
  const primary = PRIMARY_DOMAINS.map(domain => rows.find(row => row.domain === domain)).find(row => row !== undefined)
  const parts: string[] = []
  if (primary !== undefined) {
    const state = primary.domain === 'climate' ? climateSentence(primary) : switchSentence(primary, now)
    if (state !== null) parts.push(state)
  }
  const readings = rows
    .filter(row => row.domain === 'sensor' && !NOISE_RE.test(row.objectId) && !isUnavailable(row.entity.state) &&
      measureOfRow(row) !== undefined && numeric(row.entity) !== null)
    .slice(0, parts.length === 0 ? 3 : 2)
  for (const reading of readings) {
    const measureName = measureOfRow(reading)!
    const label = translateLabel(reading, name, measureName)
    const value = withUnit(numeric(reading.entity)!, reading.unit)
    parts.push(label === '' ? (measureSentence(reading, measureName, now) ?? '') : `${label} ${value}`)
  }
  if (parts.length === 0) {
    const flags = rows.map(row => row.domain === 'binary_sensor' ? binarySentence(row) : null).filter((text): text is string => text !== null)
    parts.push(...flags.slice(0, 2))
  }
  return parts.length === 0 ? `${name}: подробностей нет.` : `${name}: ${parts.filter(Boolean).join(', ')}.`
}

function answerFor (subject: Subject, measure: Measure | undefined, now: Date): string {
  const weatherRow = subject.rows.find(row => row.domain === 'weather')
  if (weatherRow !== undefined) return weatherAnswer(weatherRow, measure)
  if (isPlantSubject(subject)) return plantAnswer(subject, measure, now)
  return genericAnswer(subject, measure, now)
}

// Room temperature/humidity from any sensor or climate entity in the area; only
// when every subject word names a room, so «Глобус в гостиной» stays a device query.
function areaAnswer (index: Index, parsed: ParsedQuery, areaByEntity: Map<string, string>): EntityQueryResult | null {
  if (parsed.measure === undefined || parsed.subject.length === 0) return null
  let bestArea: { area: string, score: number } | null = null
  for (const area of new Set(areaByEntity.values())) {
    const words = tokenize(normalize(area))
    const score = parsed.subject.reduce((sum, word) => {
      return sum + Math.max(0, ...words.map(nameWord => nameSimilarity(word, nameWord)))
    }, 0) / parsed.subject.length
    if (score >= ANSWER_CONFIDENCE && (bestArea === null || score > bestArea.score)) bestArea = { area, score }
  }
  if (bestArea === null) return null
  const found: { row: Row, text: string }[] = []
  for (const subject of index.subjects) {
    for (const row of subject.rows) {
      if (row.area !== bestArea.area || NOISE_RE.test(row.objectId)) continue
      if (row.domain === 'climate' && parsed.measure === 'temperature' && typeof row.entity.attributes.current_temperature === 'number') {
        found.push({ row, text: withUnit(row.entity.attributes.current_temperature, '°C') })
      } else if (row.domain === 'sensor' && measureOfRow(row) === parsed.measure && numeric(row.entity) !== null) {
        found.push({ row, text: withUnit(numeric(row.entity)!, row.unit) })
      }
    }
  }
  if (found.length === 0) return null
  const text = `${capitalize(MEASURE_WORD[parsed.measure])} ${locative(bestArea.area)}: ${found[0].text}.`
  return { confidence: bestArea.score, entityId: found[0].row.entity.entity_id, kind: 'answer', text }
}

// ── Weather handoff (weather-via-cli overlay) ────────────────────────────────
// Whole normalized utterances (lead-in words removed) that the adapter answers with weather-cli. Generated from
// diverted_phrases.json; the adapter's tests prove it answers every entry.
const WEATHER_LEAD_INS = new Set(["а", "алиса", "глянь", "дай", "ка", "мне", "можешь", "нам", "ну", "подскажи", "пожалуйста", "покажи", "посмотри", "проверь", "расскажи", "скажи", "слушай", "узнай"])
const WEATHER_HANDOFF = new Set(["брать ли зонт", "будет ли град", "будет ли гроза", "будет ли дождь", "будет ли дождь вечером", "будет ли дождь завтра", "будет ли дождь на неделе", "будет ли завтра дождь", "будет ли завтра снег", "будет ли сегодня дождь", "будет ли снег", "взять ли зонт", "дождь идет", "дождь идет на улице", "жарко ли на улице", "зонт нужен", "идет ли дождь", "идет ли дождь на улице", "идет ли снег", "как лучше одеться", "как на улице", "как одеваться", "как одеться", "как одеться завтра", "как одеться на улицу", "как одеться сегодня", "как погода", "как там за окном", "как там на улице", "как там погода", "какая же погода", "какая же погода на улице", "какая погода", "какая погода будет", "какая погода будет в белграде", "какая погода будет завтра", "какая погода будет на неделе", "какая погода будет сегодня", "какая погода в белграде", "какая погода вечером", "какая погода во дворе", "какая погода во дворе вечером", "какая погода во дворе завтра", "какая погода во дворе на завтра", "какая погода во дворе на неделю", "какая погода за окном", "какая погода за окном вечером", "какая погода за окном завтра", "какая погода за окном на завтра", "какая погода за окном на неделю", "какая погода завтра", "какая погода и сколько градусов", "какая погода и сколько градусов на улице", "какая погода и температура", "какая погода и температура на улице", "какая погода на балконе", "какая погода на балконе вечером", "какая погода на балконе завтра", "какая погода на балконе на завтра", "какая погода на балконе на неделю", "какая погода на завтра", "какая погода на неделю", "какая погода на следующий день", "какая погода на улице", "какая погода на улице вечером", "какая погода на улице завтра", "какая погода на улице на завтра", "какая погода на улице на неделю", "какая погода на улице сейчас", "какая погода сегодня", "какая погода сегодня и на следующий день", "какая сегодня погода", "какая сегодня погода вечером", "какая сегодня погода во дворе", "какая сегодня погода во дворе вечером", "какая сегодня погода во дворе завтра", "какая сегодня погода во дворе на завтра", "какая сегодня погода во дворе на неделю", "какая сегодня погода за окном", "какая сегодня погода за окном вечером", "какая сегодня погода за окном завтра", "какая сегодня погода за окном на завтра", "какая сегодня погода за окном на неделю", "какая сегодня погода завтра", "какая сегодня погода на балконе", "какая сегодня погода на балконе вечером", "какая сегодня погода на балконе завтра", "какая сегодня погода на балконе на завтра", "какая сегодня погода на балконе на неделю", "какая сегодня погода на завтра", "какая сегодня погода на неделю", "какая сегодня погода на улице", "какая сегодня погода на улице вечером", "какая сегодня погода на улице завтра", "какая сегодня погода на улице на завтра", "какая сегодня погода на улице на неделю", "какая сегодня температура", "какая сегодня температура во дворе", "какая сегодня температура во дворе вечером", "какая сегодня температура во дворе завтра", "какая сегодня температура во дворе на завтра", "какая сегодня температура во дворе на неделю", "какая сегодня температура воздуха", "какая сегодня температура воздуха во дворе", "какая сегодня температура воздуха во дворе вечером", "какая сегодня температура воздуха во дворе завтра", "какая сегодня температура воздуха во дворе на завтра", "какая сегодня температура воздуха во дворе на неделю", "какая сегодня температура воздуха за окном", "какая сегодня температура воздуха за окном вечером", "какая сегодня температура воздуха за окном завтра", "какая сегодня температура воздуха за окном на завтра", "какая сегодня температура воздуха за окном на неделю", "какая сегодня температура воздуха завтра", "какая сегодня температура воздуха на балконе", "какая сегодня температура воздуха на балконе вечером", "какая сегодня температура воздуха на балконе завтра", "какая сегодня температура воздуха на балконе на завтра", "какая сегодня температура воздуха на балконе на неделю", "какая сегодня температура воздуха на завтра", "какая сегодня температура воздуха на неделю", "какая сегодня температура воздуха на улице", "какая сегодня температура воздуха на улице вечером", "какая сегодня температура воздуха на улице завтра", "какая сегодня температура воздуха на улице на завтра", "какая сегодня температура воздуха на улице на неделю", "какая сегодня температура за окном", "какая сегодня температура за окном вечером", "какая сегодня температура за окном завтра", "какая сегодня температура за окном на завтра", "какая сегодня температура за окном на неделю", "какая сегодня температура завтра", "какая сегодня температура на балконе", "какая сегодня температура на балконе вечером", "какая сегодня температура на балконе завтра", "какая сегодня температура на балконе на завтра", "какая сегодня температура на балконе на неделю", "какая сегодня температура на завтра", "какая сегодня температура на неделю", "какая сегодня температура на улице", "какая сегодня температура на улице вечером", "какая сегодня температура на улице завтра", "какая сегодня температура на улице на завтра", "какая сегодня температура на улице на неделю", "какая сегодня уличная температура", "какая сегодня уличная температура вечером", "какая сегодня уличная температура во дворе", "какая сегодня уличная температура во дворе вечером", "какая сегодня уличная температура во дворе завтра", "какая сегодня уличная температура во дворе на завтра", "какая сегодня уличная температура во дворе на неделю", "какая сегодня уличная температура за окном", "какая сегодня уличная температура за окном вечером", "какая сегодня уличная температура за окном завтра", "какая сегодня уличная температура за окном на завтра", "какая сегодня уличная температура за окном на неделю", "какая сегодня уличная температура завтра", "какая сегодня уличная температура на балконе", "какая сегодня уличная температура на балконе вечером", "какая сегодня уличная температура на балконе завтра", "какая сегодня уличная температура на балконе на завтра", "какая сегодня уличная температура на балконе на неделю", "какая сегодня уличная температура на завтра", "какая сегодня уличная температура на неделю", "какая сегодня уличная температура на улице", "какая сегодня уличная температура на улице вечером", "какая сегодня уличная температура на улице завтра", "какая сегодня уличная температура на улице на завтра", "какая сегодня уличная температура на улице на неделю", "какая сейчас погода", "какая сейчас погода вечером", "какая сейчас погода во дворе", "какая сейчас погода во дворе вечером", "какая сейчас погода во дворе завтра", "какая сейчас погода во дворе на завтра", "какая сейчас погода во дворе на неделю", "какая сейчас погода за окном", "какая сейчас погода за окном вечером", "какая сейчас погода за окном завтра", "какая сейчас погода за окном на завтра", "какая сейчас погода за окном на неделю", "какая сейчас погода завтра", "какая сейчас погода на балконе", "какая сейчас погода на балконе вечером", "какая сейчас погода на балконе завтра", "какая сейчас погода на балконе на завтра", "какая сейчас погода на балконе на неделю", "какая сейчас погода на завтра", "какая сейчас погода на неделю", "какая сейчас погода на улице", "какая сейчас погода на улице вечером", "какая сейчас погода на улице завтра", "какая сейчас погода на улице на завтра", "какая сейчас погода на улице на неделю", "какая сейчас температура", "какая сейчас температура во дворе", "какая сейчас температура во дворе вечером", "какая сейчас температура во дворе завтра", "какая сейчас температура во дворе на завтра", "какая сейчас температура во дворе на неделю", "какая сейчас температура воздуха", "какая сейчас температура воздуха во дворе", "какая сейчас температура воздуха во дворе вечером", "какая сейчас температура воздуха во дворе завтра", "какая сейчас температура воздуха во дворе на завтра", "какая сейчас температура воздуха во дворе на неделю", "какая сейчас температура воздуха за окном", "какая сейчас температура воздуха за окном вечером", "какая сейчас температура воздуха за окном завтра", "какая сейчас температура воздуха за окном на завтра", "какая сейчас температура воздуха за окном на неделю", "какая сейчас температура воздуха завтра", "какая сейчас температура воздуха на балконе", "какая сейчас температура воздуха на балконе вечером", "какая сейчас температура воздуха на балконе завтра", "какая сейчас температура воздуха на балконе на завтра", "какая сейчас температура воздуха на балконе на неделю", "какая сейчас температура воздуха на завтра", "какая сейчас температура воздуха на неделю", "какая сейчас температура воздуха на улице", "какая сейчас температура воздуха на улице вечером", "какая сейчас температура воздуха на улице завтра", "какая сейчас температура воздуха на улице на завтра", "какая сейчас температура воздуха на улице на неделю", "какая сейчас температура за окном", "какая сейчас температура за окном вечером", "какая сейчас температура за окном завтра", "какая сейчас температура за окном на завтра", "какая сейчас температура за окном на неделю", "какая сейчас температура завтра", "какая сейчас температура на балконе", "какая сейчас температура на балконе вечером", "какая сейчас температура на балконе завтра", "какая сейчас температура на балконе на завтра", "какая сейчас температура на балконе на неделю", "какая сейчас температура на завтра", "какая сейчас температура на неделю", "какая сейчас температура на улице", "какая сейчас температура на улице вечером", "какая сейчас температура на улице завтра", "какая сейчас температура на улице на завтра", "какая сейчас температура на улице на неделю", "какая сейчас уличная температура", "какая сейчас уличная температура вечером", "какая сейчас уличная температура во дворе", "какая сейчас уличная температура во дворе вечером", "какая сейчас уличная температура во дворе завтра", "какая сейчас уличная температура во дворе на завтра", "какая сейчас уличная температура во дворе на неделю", "какая сейчас уличная температура за окном", "какая сейчас уличная температура за окном вечером", "какая сейчас уличная температура за окном завтра", "какая сейчас уличная температура за окном на завтра", "какая сейчас уличная температура за окном на неделю", "какая сейчас уличная температура завтра", "какая сейчас уличная температура на балконе", "какая сейчас уличная температура на балконе вечером", "какая сейчас уличная температура на балконе завтра", "какая сейчас уличная температура на балконе на завтра", "какая сейчас уличная температура на балконе на неделю", "какая сейчас уличная температура на завтра", "какая сейчас уличная температура на неделю", "какая сейчас уличная температура на улице", "какая сейчас уличная температура на улице вечером", "какая сейчас уличная температура на улице завтра", "какая сейчас уличная температура на улице на завтра", "какая сейчас уличная температура на улице на неделю", "какая там погода", "какая текущая погода", "какая текущая погода вечером", "какая текущая погода во дворе", "какая текущая погода во дворе вечером", "какая текущая погода во дворе завтра", "какая текущая погода во дворе на завтра", "какая текущая погода во дворе на неделю", "какая текущая погода за окном", "какая текущая погода за окном вечером", "какая текущая погода за окном завтра", "какая текущая погода за окном на завтра", "какая текущая погода за окном на неделю", "какая текущая погода завтра", "какая текущая погода на балконе", "какая текущая погода на балконе вечером", "какая текущая погода на балконе завтра", "какая текущая погода на балконе на завтра", "какая текущая погода на балконе на неделю", "какая текущая погода на завтра", "какая текущая погода на неделю", "какая текущая погода на улице", "какая текущая погода на улице вечером", "какая текущая погода на улице завтра", "какая текущая погода на улице на завтра", "какая текущая погода на улице на неделю", "какая текущая температура", "какая текущая температура во дворе", "какая текущая температура во дворе вечером", "какая текущая температура во дворе завтра", "какая текущая температура во дворе на завтра", "какая текущая температура во дворе на неделю", "какая текущая температура воздуха", "какая текущая температура воздуха во дворе", "какая текущая температура воздуха во дворе вечером", "какая текущая температура воздуха во дворе завтра", "какая текущая температура воздуха во дворе на завтра", "какая текущая температура воздуха во дворе на неделю", "какая текущая температура воздуха за окном", "какая текущая температура воздуха за окном вечером", "какая текущая температура воздуха за окном завтра", "какая текущая температура воздуха за окном на завтра", "какая текущая температура воздуха за окном на неделю", "какая текущая температура воздуха завтра", "какая текущая температура воздуха на балконе", "какая текущая температура воздуха на балконе вечером", "какая текущая температура воздуха на балконе завтра", "какая текущая температура воздуха на балконе на завтра", "какая текущая температура воздуха на балконе на неделю", "какая текущая температура воздуха на завтра", "какая текущая температура воздуха на неделю", "какая текущая температура воздуха на улице", "какая текущая температура воздуха на улице вечером", "какая текущая температура воздуха на улице завтра", "какая текущая температура воздуха на улице на завтра", "какая текущая температура воздуха на улице на неделю", "какая текущая температура за окном", "какая текущая температура за окном вечером", "какая текущая температура за окном завтра", "какая текущая температура за окном на завтра", "какая текущая температура за окном на неделю", "какая текущая температура завтра", "какая текущая температура на балконе", "какая текущая температура на балконе вечером", "какая текущая температура на балконе завтра", "какая текущая температура на балконе на завтра", "какая текущая температура на балконе на неделю", "какая текущая температура на завтра", "какая текущая температура на неделю", "какая текущая температура на улице", "какая текущая температура на улице вечером", "какая текущая температура на улице завтра", "какая текущая температура на улице на завтра", "какая текущая температура на улице на неделю", "какая текущая уличная температура", "какая текущая уличная температура вечером", "какая текущая уличная температура во дворе", "какая текущая уличная температура во дворе вечером", "какая текущая уличная температура во дворе завтра", "какая текущая уличная температура во дворе на завтра", "какая текущая уличная температура во дворе на неделю", "какая текущая уличная температура за окном", "какая текущая уличная температура за окном вечером", "какая текущая уличная температура за окном завтра", "какая текущая уличная температура за окном на завтра", "какая текущая уличная температура за окном на неделю", "какая текущая уличная температура завтра", "какая текущая уличная температура на балконе", "какая текущая уличная температура на балконе вечером", "какая текущая уличная температура на балконе завтра", "какая текущая уличная температура на балконе на завтра", "какая текущая уличная температура на балконе на неделю", "какая текущая уличная температура на завтра", "какая текущая уличная температура на неделю", "какая текущая уличная температура на улице", "какая текущая уличная температура на улице вечером", "какая текущая уличная температура на улице завтра", "какая текущая уличная температура на улице на завтра", "какая текущая уличная температура на улице на неделю", "какая температура", "какая температура во дворе", "какая температура во дворе вечером", "какая температура во дворе завтра", "какая температура во дворе на завтра", "какая температура во дворе на неделю", "какая температура воздуха", "какая температура воздуха во дворе", "какая температура воздуха во дворе вечером", "какая температура воздуха во дворе завтра", "какая температура воздуха во дворе на завтра", "какая температура воздуха во дворе на неделю", "какая температура воздуха за окном", "какая температура воздуха за окном вечером", "какая температура воздуха за окном завтра", "какая температура воздуха за окном на завтра", "какая температура воздуха за окном на неделю", "какая температура воздуха завтра", "какая температура воздуха на балконе", "какая температура воздуха на балконе вечером", "какая температура воздуха на балконе завтра", "какая температура воздуха на балконе на завтра", "какая температура воздуха на балконе на неделю", "какая температура воздуха на завтра", "какая температура воздуха на неделю", "какая температура воздуха на улице", "какая температура воздуха на улице вечером", "какая температура воздуха на улице завтра", "какая температура воздуха на улице на завтра", "какая температура воздуха на улице на неделю", "какая температура за окном", "какая температура за окном вечером", "какая температура за окном завтра", "какая температура за окном на завтра", "какая температура за окном на неделю", "какая температура завтра", "какая температура на балконе", "какая температура на балконе вечером", "какая температура на балконе завтра", "какая температура на балконе на завтра", "какая температура на балконе на неделю", "какая температура на завтра", "какая температура на неделю", "какая температура на улице", "какая температура на улице вечером", "какая температура на улице завтра", "какая температура на улице на завтра", "какая температура на улице на неделю", "какая уличная температура", "какая уличная температура вечером", "какая уличная температура во дворе", "какая уличная температура во дворе вечером", "какая уличная температура во дворе завтра", "какая уличная температура во дворе на завтра", "какая уличная температура во дворе на неделю", "какая уличная температура за окном", "какая уличная температура за окном вечером", "какая уличная температура за окном завтра", "какая уличная температура за окном на завтра", "какая уличная температура за окном на неделю", "какая уличная температура завтра", "какая уличная температура на балконе", "какая уличная температура на балконе вечером", "какая уличная температура на балконе завтра", "какая уличная температура на балконе на завтра", "какая уличная температура на балконе на неделю", "какая уличная температура на завтра", "какая уличная температура на неделю", "какая уличная температура на улице", "какая уличная температура на улице вечером", "какая уличная температура на улице завтра", "какая уличная температура на улице на завтра", "какая уличная температура на улице на неделю", "какова погода", "какова погода вечером", "какова погода во дворе", "какова погода во дворе вечером", "какова погода во дворе завтра", "какова погода во дворе на завтра", "какова погода во дворе на неделю", "какова погода за окном", "какова погода за окном вечером", "какова погода за окном завтра", "какова погода за окном на завтра", "какова погода за окном на неделю", "какова погода завтра", "какова погода на балконе", "какова погода на балконе вечером", "какова погода на балконе завтра", "какова погода на балконе на завтра", "какова погода на балконе на неделю", "какова погода на завтра", "какова погода на неделю", "какова погода на улице", "какова погода на улице вечером", "какова погода на улице завтра", "какова погода на улице на завтра", "какова погода на улице на неделю", "какова температура", "какова температура во дворе", "какова температура во дворе вечером", "какова температура во дворе завтра", "какова температура во дворе на завтра", "какова температура во дворе на неделю", "какова температура воздуха", "какова температура воздуха во дворе", "какова температура воздуха во дворе вечером", "какова температура воздуха во дворе завтра", "какова температура воздуха во дворе на завтра", "какова температура воздуха во дворе на неделю", "какова температура воздуха за окном", "какова температура воздуха за окном вечером", "какова температура воздуха за окном завтра", "какова температура воздуха за окном на завтра", "какова температура воздуха за окном на неделю", "какова температура воздуха завтра", "какова температура воздуха на балконе", "какова температура воздуха на балконе вечером", "какова температура воздуха на балконе завтра", "какова температура воздуха на балконе на завтра", "какова температура воздуха на балконе на неделю", "какова температура воздуха на завтра", "какова температура воздуха на неделю", "какова температура воздуха на улице", "какова температура воздуха на улице вечером", "какова температура воздуха на улице завтра", "какова температура воздуха на улице на завтра", "какова температура воздуха на улице на неделю", "какова температура за окном", "какова температура за окном вечером", "какова температура за окном завтра", "какова температура за окном на завтра", "какова температура за окном на неделю", "какова температура завтра", "какова температура на балконе", "какова температура на балконе вечером", "какова температура на балконе завтра", "какова температура на балконе на завтра", "какова температура на балконе на неделю", "какова температура на завтра", "какова температура на неделю", "какова температура на улице", "какова температура на улице вечером", "какова температура на улице завтра", "какова температура на улице на завтра", "какова температура на улице на неделю", "какова уличная температура", "какова уличная температура вечером", "какова уличная температура во дворе", "какова уличная температура во дворе вечером", "какова уличная температура во дворе завтра", "какова уличная температура во дворе на завтра", "какова уличная температура во дворе на неделю", "какова уличная температура за окном", "какова уличная температура за окном вечером", "какова уличная температура за окном завтра", "какова уличная температура за окном на завтра", "какова уличная температура за окном на неделю", "какова уличная температура завтра", "какова уличная температура на балконе", "какова уличная температура на балконе вечером", "какова уличная температура на балконе завтра", "какова уличная температура на балконе на завтра", "какова уличная температура на балконе на неделю", "какова уличная температура на завтра", "какова уличная температура на неделю", "какова уличная температура на улице", "какова уличная температура на улице вечером", "какова уличная температура на улице завтра", "какова уличная температура на улице на завтра", "какова уличная температура на улице на неделю", "какой ветер за окном", "какой ветер на улице", "какой сейчас ветер на улице", "на улице дождь", "на улице снег", "нужен ли зонт", "нужен ли зонт вечером", "нужен ли зонт завтра", "нужен ли зонт сегодня", "нужно ли брать зонт", "о погоде", "о погоде вечером", "о погоде во дворе", "о погоде за окном", "о погоде завтра", "о погоде на балконе", "о погоде на выходные", "о погоде на завтра", "о погоде на неделю", "о погоде на улице", "о погоде сегодня", "о погоде сегодня и завтра", "погода", "погода в белграде", "погода в белграде завтра", "погода вечером", "погода во дворе", "погода за окном", "погода завтра", "погода и ветер на улице", "погода и температура", "погода и температура на улице", "погода на балконе", "погода на выходные", "погода на завтра", "погода на неделю", "погода на улице", "погода сегодня", "погода сегодня и завтра", "погоду", "погоду вечером", "погоду во дворе", "погоду за окном", "погоду завтра", "погоду на балконе", "погоду на выходные", "погоду на завтра", "погоду на неделю", "погоду на улице", "погоду сегодня", "погоду сегодня и завтра", "понадобится ли зонт", "пригодится ли зонт", "прогноз", "прогноз вечером", "прогноз во дворе", "прогноз за окном", "прогноз завтра", "прогноз на балконе", "прогноз на выходные", "прогноз на завтра", "прогноз на завтра и на неделю", "прогноз на неделю", "прогноз на сегодня", "прогноз на сегодня и завтра", "прогноз на улице", "прогноз погоды", "прогноз погоды вечером", "прогноз погоды во дворе", "прогноз погоды за окном", "прогноз погоды завтра", "прогноз погоды на балконе", "прогноз погоды на выходные", "прогноз погоды на завтра", "прогноз погоды на неделю", "прогноз погоды на сегодня", "прогноз погоды на улице", "прогноз погоды сегодня", "прогноз погоды сегодня и завтра", "прогноз сегодня", "прогноз сегодня и завтра", "сколько градусов", "сколько градусов во дворе", "сколько градусов за окном", "сколько градусов завтра", "сколько градусов на балконе", "сколько градусов на улице", "сколько градусов цельсия", "сколько градусов цельсия во дворе", "сколько градусов цельсия за окном", "сколько градусов цельсия завтра", "сколько градусов цельсия на балконе", "сколько градусов цельсия на улице", "сколько на улице градусов", "сколько сейчас градусов", "сколько сейчас градусов во дворе", "сколько сейчас градусов за окном", "сколько сейчас градусов завтра", "сколько сейчас градусов на балконе", "сколько сейчас градусов на улице", "сколько сейчас градусов цельсия", "сколько сейчас градусов цельсия во дворе", "сколько сейчас градусов цельсия за окном", "сколько сейчас градусов цельсия завтра", "сколько сейчас градусов цельсия на балконе", "сколько сейчас градусов цельсия на улице", "сколько сейчас на улице градусов", "снег идет", "стоит ли брать зонт", "там дождь", "там дождь идет", "температура", "температура во дворе", "температура за окном", "температура завтра", "температура на балконе", "температура на выходные", "температура на завтра", "температура на неделю", "температура на улице", "температура сегодня", "температуру", "температуру во дворе", "температуру за окном", "температуру завтра", "температуру на балконе", "температуру на выходные", "температуру на завтра", "температуру на неделю", "температуру на улице", "температуру сегодня", "тепло ли за окном", "тепло ли на улице", "холодно ли на улице", "холодно ли сегодня на улице", "что за окном", "что на улице", "что на улице сейчас", "что надеть", "что надеть завтра", "что надеть на улицу", "что надеть сегодня", "что одеть", "что одеть на улицу", "что одеть сегодня", "что там за окном", "что там на улице"])

function handedToWeatherCli (text: string): boolean {
  const words = tokenize(normalize(text)).filter(token => !WEATHER_LEAD_INS.has(token))
  return WEATHER_HANDOFF.has(words.join(' '))
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function matchEntityQuery (text: string, entities: Map<string, EntityLike>,
  areaByEntity: Map<string, string>, now: Date = new Date()): EntityQueryResult {
  const parsed = parseQuery(text)
  if (parsed === null) return NONE
  const index = getIndex(entities, areaByEntity)

  // «на улице», «какая погода»: the weather entity, except the questions in the handoff table: those go on to the
  // brain tier, where the adapter answers them with weather-cli (one voice for every weather question, forecast and
  // rain decided from the same data). Anything not in the table keeps its entity answer.
  if (parsed.outdoor || parsed.weather) {
    if (parsed.subject.length > 0 && !parsed.outdoor) return NONE // «погода в Париже»
    if (handedToWeatherCli(text)) return NONE
    const weather = index.subjects.find(subject => subject.rows.some(row => row.domain === 'weather'))
    if (weather === undefined) return NONE
    return { confidence: 0.95, entityId: weather.rows.find(row => row.domain === 'weather')?.entity.entity_id,
      kind: 'answer', text: answerFor(weather, parsed.measure, now) }
  }

  // Generic plant words («мой цветок»): the single plant device, if unambiguous.
  if (parsed.plant) {
    const plants = index.subjects.filter(isPlantSubject)
    if (plants.length === 1) {
      return { confidence: 0.85, entityId: headlineRow(plants[0]).entity.entity_id, kind: 'answer',
        text: answerFor(plants[0], parsed.measure, now) }
    }
  }

  if (parsed.subject.length === 0) return NONE

  // «температура в гостиной»: every subject word is a room → read the room's sensors.
  const roomAnswer = areaAnswer(index, parsed, areaByEntity)
  if (roomAnswer !== null) return roomAnswer

  // Room words («в гостиной») narrow the device instead of diluting its name score.
  const areaNames = [...new Set(areaByEntity.values())]
  const roomOf = (word: string): string | undefined => areaNames.find(area =>
    tokenize(normalize(area)).some(nameWord => nameSimilarity(word, nameWord) >= ANSWER_CONFIDENCE))
  const deviceWords = parsed.subject.filter(word => roomOf(word) === undefined)
  const rooms = parsed.subject.map(roomOf).filter((area): area is string => area !== undefined)
  const words = deviceWords.length > 0 ? deviceWords : parsed.subject
  const inRoom = (subject: Subject): boolean => deviceWords.length === 0 || rooms.length === 0 || rooms.some(area => subject.areas.has(area))
  const named = index.subjects
    .map(subject => ({ score: scoreSubject(words, subject), subject }))
    .filter(candidate => candidate.score >= CONFIRM_CONFIDENCE && inRoom(candidate.subject))
    .map(candidate => ({ score: candidate.score, subject: spokenAs(candidate.subject, words) }))
    .sort((left, right) => right.score - left.score || left.subject.display.localeCompare(right.subject.display))
  // «влажность у X»: among name matches prefer devices that actually measure it.
  const measuring = parsed.measure === undefined ? named : named.filter(item => hasMeasure(item.subject, parsed.measure!))
  if (measuring.length === 0 && parsed.measure !== undefined && named.length > 0 && named[0].score >= 0.9 &&
    !isRoomSubject(named[0].subject, areaByEntity)) {
    return { confidence: named[0].score, entityId: headlineRow(named[0].subject).entity.entity_id, kind: 'answer',
      text: answerFor(named[0].subject, parsed.measure, now) }
  }
  const scored = measuring
  if (scored.length === 0) return NONE

  const nearBest = scored.filter(item => scored[0].score - item.score < 0.05)
  const largest = Math.max(...nearBest.map(item => item.subject.rows.length))
  // Equally good siblings («кондей» → Кондей 1 and 2) are answered together; a
  // stray one-entity subject next to a full device («Kettle Всего энергия») is dropped.
  const tied = nearBest.filter(item => item.subject.rows.length * 4 >= largest).map(item => item.subject)
  const best = { score: scored[0].score, subject: tied[0] }
  const entityId = headlineRow(best.subject).entity.entity_id
  if (tied.length > MAX_LISTED) {
    // Three or more equally likely devices: any subset read out would be a random pick.
    return { confidence: best.score, entityId, kind: 'reprompt', text: '' }
  }
  const answers = tied.map(subject => answerFor(subject, parsed.measure, now))
  const informative = answers.filter(answer => !answer.endsWith('подробностей нет.'))
  const answerText = (informative.length > 0 ? informative : answers).join(' ')
  if (best.score >= ANSWER_CONFIDENCE) {
    return { confidence: best.score, entityId, kind: 'answer', text: answerText }
  }
  return { answerText, confidence: best.score, entityId, kind: 'confirm',
    text: `Ты про ${tied.map(subject => accusative(subject.display)).join(' или ')}?` }
}

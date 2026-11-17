// Pure parsers for «включи <артист/трек/альбом>» and the media keys «стоп/пауза/продолжи/дальше/назад»
// (no I/O; unit-tested in music-intents.test.ts).
import { normalize, tokenize } from './fuzzy-ru'

export type MusicMediaType = 'album' | 'artist' | 'playlist' | 'radio' | 'track'

export interface MusicIntent {
  mediaType?: MusicMediaType
  query: string
}

export interface BareMusicName {
  query: string
}

const VERBS = ['включи', 'включите', 'включить', 'включай', 'вруби', 'врубите', 'врубай', 'врубить', 'поставь', 'поставьте',
  'поставить', 'запусти', 'запустите', 'запустить', 'сыграй', 'сыграйте', 'играй', 'воспроизведи', 'воспроизведите',
  'послушаем', 'послушать']
// «хочу послушать X», «давай послушаем X»
const LEAD_IN = ['хочу', 'давай', 'давайте', 'мне', 'пожалуйста', 'алиса', 'ка', 'нам']

const TYPE_WORDS: Record<string, MusicMediaType> = {
  песню: 'track', песня: 'track', песенку: 'track', трек: 'track', композицию: 'track', композиция: 'track',
  альбом: 'album', пластинку: 'album',
  плейлист: 'playlist', подборку: 'playlist', сборник: 'playlist',
  группу: 'artist', группа: 'artist', исполнителя: 'artist', артиста: 'artist', певца: 'artist', певицу: 'artist',
  радио: 'radio'
}

// Nouns that mean a device/state/generic request handled (or deliberately sent to the
// brain) elsewhere; a catalog artist that happens to share the name must not steal them.
const DEVICE_STEMS = ['свет', 'ламп', 'люстр', 'ночник', 'глобус', 'гирлянд', 'чайник', 'розетк', 'телевизор',
  'телек', 'проектор', 'кондиционер', 'кондей', 'пылесос', 'увлажнител', 'вентилятор', 'обогреватель', 'камер',
  'будильник', 'таймер', 'громкост', 'звук', 'тишин', 'режим', 'уведомлен', 'микрофон', 'блютуз', 'bluetooth',
  'wifi', 'вайфай', 'принтер', 'ноутбук', 'компьютер', 'сценари', 'всё', 'все']
const GENERIC_ONLY = ['музыку', 'музыка', 'музыки', 'что-нибудь', 'чтонибудь', 'песни', 'треки']
const TRAILING = ['пожалуйста', 'на', 'колонке', 'колонку', 'здесь', 'тут', 'в', 'гостиной', 'сейчас']

/** Pure parser: normalized-or-raw utterance → music request, or null when it is not one. */
export function parseMusicIntent (rawText: string): MusicIntent | null {
  const tokens = tokenize(normalize(rawText)).filter(t => t !== '')
  let i = 0
  while (i < tokens.length && LEAD_IN.includes(tokens[i])) i++
  if (i >= tokens.length || !VERBS.includes(tokens[i])) return null
  i++
  while (i < tokens.length && LEAD_IN.includes(tokens[i])) i++
  let mediaType: MusicMediaType | undefined
  if (i < tokens.length && Object.hasOwn(TYPE_WORDS, tokens[i])) {
    mediaType = TYPE_WORDS[tokens[i]]
    i++
  }
  let rest = tokens.slice(i)
  while (rest.length > 0 && TRAILING.includes(rest[rest.length - 1])) rest = rest.slice(0, -1)
  if (rest.length === 0 || rest.length > 8) return null
  if (mediaType === undefined && rest.length === 1 && GENERIC_ONLY.includes(rest[0])) return null
  if (rest[0] === 'музыку' && rest.length === 1) return null
  if (DEVICE_STEMS.some(stem => rest.some(token => token.startsWith(stem))) && mediaType === undefined) return null
  // «включи музыку Sex Pistols» → drop the generic noun
  if (GENERIC_ONLY.includes(rest[0]) && rest.length > 1) rest = rest.slice(1)
  const query = rest.join(' ')
  return mediaType === undefined ? { query } : { mediaType, query }
}

export type MediaAction = 'next' | 'pause' | 'previous' | 'resume' | 'stop'

const MEDIA_CORE: Record<string, MediaAction> = {
  стоп: 'stop', стой: 'stop', хватит: 'stop', остановись: 'stop', останови: 'stop', остановить: 'stop', остановите: 'stop',
  замолчи: 'stop', помолчи: 'stop', отбой: 'stop',
  пауза: 'pause', паузу: 'pause', паузе: 'pause', паузы: 'pause', приостанови: 'pause', приостановить: 'pause', приостановите: 'pause',
  продолжи: 'resume', продолжай: 'resume', продолжить: 'resume', продолжайте: 'resume', продолжите: 'resume',
  возобнови: 'resume', возобновить: 'resume',
  дальше: 'next', следующий: 'next', следующая: 'next', следующую: 'next', следующее: 'next', следующие: 'next',
  пропусти: 'next', пропустить: 'next', next: 'next',
  предыдущий: 'previous', предыдущая: 'previous', предыдущую: 'previous', предыдущее: 'previous', предыдущие: 'previous',
  назад: 'previous', вернись: 'previous', прошлый: 'previous', прошлая: 'previous', прошлую: 'previous'
}
// Words that may surround a media key without changing it; any other word means this is a
// different request («дальше расскажи про Луну») and not a key press.
const MEDIA_FILLER = ['алиса', 'ну', 'пожалуйста', 'давай', 'давайте', 'а', 'и', 'же', 'мне', 'нам', 'теперь', 'уже', 'ка',
  'это', 'эту', 'этот', 'на', 'с', 'со', 'музыку', 'музыка', 'музыки', 'песню', 'песня', 'песни', 'трек', 'трека', 'композицию',
  'композиция', 'воспроизведение', 'воспроизведения', 'радио', 'плеер', 'поставь', 'поставьте', 'включи', 'включите',
  'сними', 'снять', 'убери']
const MEDIA_STOP_VERBS = ['выключи', 'выключите', 'выключить', 'выруби', 'вырубай', 'отключи', 'отключить', 'убери']
const MEDIA_NOUNS = ['музыку', 'музыка', 'музыки', 'песню', 'песня', 'трек', 'воспроизведение', 'воспроизведения', 'радио', 'плеер']

/** Pure parser: normalized-or-raw utterance → media key, or null when it is anything else. */
export function parseMediaControl (rawText: string): MediaAction | null {
  const tokens = tokenize(normalize(rawText)).filter(t => t !== '')
  if (tokens.length === 0 || tokens.length > 6) return null
  // «выключи музыку»: the noun is what makes the generic verb a media key.
  if (tokens.some(t => MEDIA_STOP_VERBS.includes(t)) && tokens.some(t => MEDIA_NOUNS.includes(t)) &&
    tokens.every(t => MEDIA_STOP_VERBS.includes(t) || MEDIA_NOUNS.includes(t) || MEDIA_FILLER.includes(t))) return 'stop'
  const actions = new Set<MediaAction>()
  for (const token of tokens) {
    const key = Object.hasOwn(MEDIA_CORE, token) ? MEDIA_CORE[token] : undefined
    if (key !== undefined) actions.add(key)
    else if (!MEDIA_FILLER.includes(token)) return null
  }
  if (actions.size !== 1) return null
  const [action] = actions
  // «сними с паузы» / «убери паузу» release the pause; «поставь на паузу» sets it.
  if (action === 'pause' && tokens.some(t => ['сними', 'снять', 'убери'].includes(t))) return 'resume'
  return action
}

// Quantities and times a digit-led phrase usually means («5 минут», «2 градуса»): never a band.
const QUANTITY_STEMS = ['час', 'мин', 'сек', 'градус', 'процент', 'раз', 'штук', 'метр', 'кило', 'литр', 'рубл', 'дн', 'недел', 'месяц', 'год', 'лет']

/**
 * A band name said without «включи» — the recognizer loses the leading verb as often as it hears
 * «Sex Pistols» as «6 pistols». Only phrases that cannot be anything else qualify: at most three
 * words, one of them Latin, or a single digit followed by a word that is not a unit. The adapter
 * still requires a close artist match before anything plays.
 */
export function parseBareMusicName (rawText: string): BareMusicName | null {
  const tokens = tokenize(normalize(rawText)).filter(t => t !== '')
  if (tokens.length === 0 || tokens.length > 3) return null
  const latin = tokens.some(t => /[a-z]{3,}/.test(t))
  const digitLed = tokens.length >= 2 && /^\d$/.test(tokens[0]) && /[a-zа-я]{3,}/.test(tokens[1]) &&
    !QUANTITY_STEMS.some(stem => tokens[1].startsWith(stem))
  if (!latin && !digitLed) return null
  if (DEVICE_STEMS.some(stem => tokens.some(token => token.startsWith(stem)))) return null
  return { query: tokens.join(' ') }
}

// The phrases the speaker's AirPlay receiver acts on by itself (it reads the recognized text from the
// firmware's IPC and, while a phone owns the session, presses the phone's pause/play/stop through
// the AirPlay event channel). It matches whole stock-Alice sentences, not «пауза»/«стоп».
const RECEIVER_PHRASES: Partial<Record<MediaAction, string>> = {
  pause: 'поставь музыку на паузу',
  resume: 'продолжи воспроизведение',
  stop: 'останови воспроизведение'
}

/** The text to report as «recognized» so the receiver can act on a media key; null for anything else. */
export function receiverMediaPhrase (rawText: string): string | null {
  const action = parseMediaControl(rawText)
  return action === null ? null : RECEIVER_PHRASES[action] ?? null
}

// Safety checks of the fast-intent layer, end to end against a mocked Home Assistant and adapter (no network, no
// device actions, no sound):
//   node_modules/.bin/tsx src/backend/corpus/run_safety.mts
// 0. The corrector's context is per station: another speaker's «давай» is not read as the answer to a question it never heard.
// 1. A negated phrase («не включай чайник») never runs the command it forbids, and a negated answer to a pending
//    question is a «нет», not a «да» («не делай», «не давай»).
// 2. Several stations (three speakers in the home): a question asked on one is answered on that one, «повтори» repeats what
//    the speaker that says it heard, and none of that memory grows without bound for made-up station ids.
// Inside a quasar container: docker cp corpus/. CONTAINER:/src/backend/corpus/, then run it with /node_modules/.bin/tsx.
import { existsSync, readFileSync, rmSync } from 'node:fs'

const AMBIGUITY_FILE = `/tmp/ha-ambiguity-safety-${process.pid}.json`
process.env.AISIS_HA_URL = 'http://ha.test'
process.env.AISIS_HA_TOKEN = 'test-token'
process.env.AISIS_HA_AMBIGUITY_FILE = AMBIGUITY_FILE
process.env.SEMANTIC_INTENTS = 'off'
rmSync(AMBIGUITY_FILE, { force: true })

type Attrs = Record<string, unknown>
interface Ent { entity_id: string, state: string, attributes: Attrs }

const areaOf: Record<string, string> = {
  'light.gostinaia_potolok': 'Гостиная', 'light.liustra': 'Гостиная', 'climate.kondei_1': 'Гостиная',
  'switch.globus3': 'Гостиная', 'light.kukhnia_svetilnik': 'Кухня', 'switch.kettle_plug_local': 'Кухня'
}
const entities = new Map<string, Ent>()
for (const id of Object.keys(areaOf)) {
  const attrs: Attrs = { friendly_name: id }
  if (id.startsWith('climate.')) Object.assign(attrs, { min_temp: 16, max_temp: 30, temperature: 25 })
  entities.set(id, { attributes: attrs, entity_id: id, state: 'off' })
}
const calls: { path: string, body: Attrs }[] = []
// What the adapter's /intent/decide answers: 'down' (unreachable: the layer carries on locally) or 'none' (reachable, no rule).
const grammar: { mode: 'down' | 'none' } = { mode: 'down' }
// The adapter's /asr/correct: what the layer sent (the spoken questions it offers as context) and what a corrector answers.
interface CorrectionRequest { recent: { role: string, text: string }[], text: string }
interface CorrectionReply { changed: boolean, confidence: number, intent: string, mode: string, status: string, text: string }
const corrector: { requests: CorrectionRequest[], reply: (request: CorrectionRequest) => CorrectionReply | null } = {
  reply: () => null, requests: []
}

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  if (url.pathname === '/asr/correct') {
    const request = JSON.parse(String(init?.body ?? '{}')) as CorrectionRequest
    corrector.requests.push(request)
    return json(corrector.reply(request) ?? { changed: false, confidence: 0.1, intent: 'unclear', mode: 'ignore', status: 'ok', text: request.text })
  }
  if (url.pathname === '/intent/decide') return grammar.mode === 'none' ? json({ route: 'none' }) : new Response('', { status: 503 })
  if (url.pathname.endsWith('/speaker.volume_step_pct')) return json({ ok: true, value: 10 })
  if (url.pathname === '/api/states') return json([...entities.values()])
  if (url.pathname === '/api/template') {
    return new Response([...Object.entries(areaOf)].map(([id, area]) => `${id}\t${id}\t${area}`).join('\n'))
  }
  if (url.pathname.startsWith('/api/states/')) {
    const entity = entities.get(url.pathname.slice('/api/states/'.length))
    return entity === undefined ? new Response('', { status: 404 }) : json(entity)
  }
  if (url.pathname.startsWith('/api/services/')) {
    const body = JSON.parse(String(init?.body ?? '{}')) as Attrs
    calls.push({ body, path: url.pathname })
    const entity = entities.get(String(body.entity_id))
    if (entity !== undefined) {
      if (url.pathname.endsWith('/turn_on')) entity.state = 'on'
      if (url.pathname.endsWith('/turn_off')) entity.state = 'off'
      if (url.pathname.endsWith('/set_hvac_mode')) entity.state = String(body.hvac_mode)
    }
    return json([])
  }
  return new Response('', { status: 404 })
}) as typeof fetch

interface Result { kind: string, listen?: boolean, text: null | string, quasarDirectives?: { Name: string }[] }
interface Options { dialogActive?: boolean, speakerLevel?: null | number, deviceId?: string }
interface Layer { matchFastIntent: (text: string, options?: Options) => Promise<Result | null> }
const loaded = await import('../ha-intents.ts') as Layer & { default?: Layer }
const { matchFastIntent } = loaded.matchFastIntent === undefined ? loaded.default! : loaded
const memory = await import('../turn-memory.ts') as { resetTurns: () => void, default?: { resetTurns: () => void } }
const resetTurns = memory.resetTurns ?? memory.default!.resetTurns

let failed = 0
let total = 0
function check (name: string, ok: boolean, detail: unknown): void {
  total++
  if (!ok) { failed++; console.log(`  ✗ ${name}: ${JSON.stringify(detail)}`) }
}
async function say (text: string, options: Options = {}): Promise<Result | null> {
  calls.length = 0
  return await matchFastIntent(text, options)
}
const executed = (): boolean => calls.some(call => /\/(turn_on|turn_off|set_hvac_mode|set_temperature)$/.test(call.path))
// A turn that ended without speech or sound: the dialog is over, nothing was asked or started.
const silent = (result: Result | null): boolean => result?.kind === 'reply' && result.text === null && result.listen !== true &&
  (result.quasarDirectives?.length ?? 0) === 0
// Closes whatever question is still open, so one scenario cannot leak into the next.
const settle = async (): Promise<void> => { await say('ничего') }
const kettle = (): Ent => entities.get('switch.kettle_plug_local')!
const turnedOnKettle = (): boolean => calls.some(call => call.body.entity_id === 'switch.kettle_plug_local' && call.path.endsWith('/turn_on'))

// ── 0. the corrector's context is per station ─────────────────────────────────────────────────────────────────────────
// The layer offers the corrector the question it last asked, so a garbled answer can be read as the answer to it. That context belongs
// to the station that was asked, and ends with the question: another speaker's «гавай» must not be turned into «включи чайник» by a
// question it never heard, nor the owner's by one they dismissed.
// (This block runs first: the layer calls the corrector at most ten times a minute.)
{
  const STATION_A = 'AAAA0001'
  const STATION_B = 'BBBB0002'
  const readsAsAnswer = (request: CorrectionRequest): boolean => request.text === 'гавай' && request.recent.some(turn => turn.text === 'Включить чайник?')
  corrector.reply = request => readsAsAnswer(request)
    ? { changed: true, confidence: 0.95, intent: 'home', mode: 'act', status: 'ok', text: 'включи чайник' }
    : null
  kettle().state = 'off'
  const asked = await say('вклчи чайник', { deviceId: STATION_A })
  check('станция A: «вклчи чайник» → вопрос', asked?.text === 'Включить чайник?' && asked.listen === true, asked)
  corrector.requests.length = 0
  const foreign = await say('гавай', { deviceId: STATION_B })
  check('станция B: «гавай» не получает вопрос станции A как контекст', corrector.requests.length > 0 && corrector.requests.every(request => request.recent.length === 0),
    corrector.requests)
  check('станция B: «гавай» не включает чайник', !turnedOnKettle(), { calls, foreign })
  corrector.requests.length = 0
  const own = await say('гавай', { deviceId: STATION_A })
  check('станция A: своему вопросу контекст остаётся', corrector.requests.some(request => request.recent.some(turn => turn.text === 'Включить чайник?')), corrector.requests)
  check('станция A: «гавай» по своему вопросу включает чайник', turnedOnKettle(), { calls, own })
  // a dismissed question is no context any more
  kettle().state = 'off'
  await say('вклчи чайник', { deviceId: STATION_A })
  await say('ничего', { deviceId: STATION_A })
  corrector.requests.length = 0
  const late = await say('гавай', { deviceId: STATION_A })
  check('станция A: после «ничего» вопрос не контекст', corrector.requests.length > 0 && corrector.requests.every(request => request.recent.length === 0), corrector.requests)
  check('станция A: после «ничего» «гавай» не включает чайник', !turnedOnKettle(), { calls, late })
  // and neither is a question the owner refused
  kettle().state = 'off'
  await say('вклчи чайник', { deviceId: STATION_A })
  await say('не делай', { deviceId: STATION_A })
  corrector.requests.length = 0
  const refused = await say('гавай', { deviceId: STATION_A })
  check('станция A: после «не делай» вопрос не контекст', corrector.requests.length > 0 && corrector.requests.every(request => request.recent.length === 0), corrector.requests)
  check('станция A: после «не делай» «гавай» не включает чайник', !turnedOnKettle(), { calls, refused })
  corrector.reply = () => null
  await say('ничего', { deviceId: STATION_A })
}

// ── 1. negation ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The adapter grammar answers most negated phrases itself («Хорошо, не буду.») before this layer sees them; these are the
// ones it does not (a «none» verdict: «лучше не включай чайник») and every phrase while it is down or slow.
const NEGATED_COMMANDS = [
  'не включай чайник', 'не выключай свет', 'не включай свет на кухне', 'не включай кондиционер', 'не включай люстру',
  'никогда не включай чайник', 'ни за что не включай чайник', 'лучше не включай чайник', 'чайник не включай пока',
  'не вздумай включать чайник', 'нельзя включать чайник', 'кондиционер не включай', 'свет не включай',
  'не включай свет в гостиной а включи на кухне', 'включи не чайник а свет',
  'не делай громче', 'не убавляй громкость', 'не тише', 'не ставь яркость 50', 'не делай кондиционер 22 градуса',
  'не мог бы ты не включать чайник', 'не могу включить свет', 'я не мог включить люстру', 'чтобы не включать чайник',
  'я не могла бы включить чайник', 'я знаю что ты не можешь включить чайник'
]
for (const mode of ['down', 'none'] as const) {
  grammar.mode = mode
  for (const phrase of NEGATED_COMMANDS) {
    for (const entity of entities.values()) entity.state = 'off'
    const result = await say(phrase)
    check(`«${phrase}» [адаптер: ${mode}]: ничего не выполнено и не спрошено`, !executed() && result === null, { calls, result })
    await settle()
  }
}
grammar.mode = 'down'

// the same words are still commands without the negation (also as a polite request), and read-only questions with a negation are
// still answered here
const CONTROLS: [string, string][] = [['включи чайник', 'switch.kettle_plug_local'], ['включи люстру', 'light.liustra'],
  ['не мог бы ты включить люстру', 'light.liustra'], ['нельзя ли включить люстру', 'light.liustra'],
  ['не можешь включить люстру', 'light.liustra'], ['алиса не мог бы ты включить люстру', 'light.liustra'],
  ['алиса ты не могла бы включить люстру', 'light.liustra'], ['не мог бы включить люстру', 'light.liustra']]
for (const [phrase, entityId] of CONTROLS) {
  entities.get(entityId)!.state = 'off'
  const result = await say(phrase)
  check(`«${phrase}»: выполнено`, silent(result) === false && calls.some(call => call.body.entity_id === entityId && call.path.endsWith('/turn_on')), { calls, result })
}
const state = await say('что не включено')
check('«что не включено»: ответ о состоянии, а не отказ', state?.kind === 'reply' && state.text !== null && /включено/.test(state.text), state)

// a negated answer to a pending yes/no question is «нет»: it cancels, executes nothing and consumes the question.
// The question is «Повторить: включить чайник?» (a repeat is never learned, so every case meets a fresh question).
async function askToRepeatKettle (): Promise<Result | null> {
  resetTurns()
  kettle().state = 'off'
  await say('включи чайник')
  kettle().state = 'off'
  return await say('повтори')
}
const NEGATED_ANSWERS = ['не делай', 'не давай', 'не точно', 'не верно', 'не ок', 'нет не делай', 'нет давай не надо', 'не включай', 'не включай чайник',
  'никогда', 'ни в коем случае', 'нельзя']
for (const answer of NEGATED_ANSWERS) {
  const asked = await askToRepeatKettle()
  check(`«${answer}»: вопрос задан`, asked?.text === 'Повторить: включить чайник?' && asked.listen === true, asked)
  const reply = await say(answer)
  check(`«${answer}»: отмена, чайник не включён`, !turnedOnKettle() && reply?.kind !== 'llm', { calls, reply })
  const late = await say('да')
  check(`«${answer}»: вопрос снят, поздний «да» ничего не запускает`, !executed(), { calls, late })
  await settle()
}
for (const answer of ['да', 'давай', 'делай', 'конечно', 'ага']) {
  await askToRepeatKettle()
  await say(answer)
  check(`«${answer}»: подтверждение включает чайник`, turnedOnKettle(), calls)
  await settle()
}
// the same on a question that IS learned («вклчи люстру»): the cancelled phrase is not remembered as a confirmed one
{
  entities.get('light.liustra')!.state = 'off'
  const asked = await say('вклчи люстру')
  check('«вклчи люстру»: вопрос «Включить люстру?»', asked?.text === 'Включить люстру?' && asked.listen === true, asked)
  const reply = await say('не делай')
  check('«не делай»: отмена молча, люстра не включена', silent(reply) && !executed(), { calls, reply })
  const learned = existsSync(AMBIGUITY_FILE) ? readFileSync(AMBIGUITY_FILE, 'utf8') : '{}'
  check('«не делай» не выучено как «да»', !learned.includes('вклчи люстру'), learned)
}

// «Свет или музыку?»: a negated choice is not the choice, and is never remembered as one
{
  entities.get('switch.globus3')!.state = 'off'
  const asked = await say('включи глобус')
  check('«включи глобус»: вопрос «Свет или музыку?»', asked?.text === 'Свет или музыку?', asked)
  const reply = await say('не свет а музыку')
  check('«не свет, а музыку»: музыка, глобус не включён', !executed() && reply?.kind === 'llm' && reply.text === 'включи глобус', { calls, reply })
  const asked2 = await say('зажги глобус')
  check('«зажги глобус»: вопрос «Свет или музыку?»', asked2?.text === 'Свет или музыку?', asked2)
  const reply2 = await say('не включай свет')
  check('«не включай свет»: глобус не включён', !executed(), { calls, reply2 })
  const learned = existsSync(AMBIGUITY_FILE) ? readFileSync(AMBIGUITY_FILE, 'utf8') : '{}'
  check('отрицание не выучено как «свет»', !/"зажги глобус": "home"/.test(learned), learned)
  // the negator may also follow the word it negates, or stand further from it in its clause
  const REFUSALS: [string, string][] = [['врубить глобус', 'свет не включай'], ['включить глобус', 'музыку не включай'],
    ['зажечь глобус', 'не включай пожалуйста этот свет'], ['вруби глобус пожалуйста', 'не хочу сейчас включать свет'],
    ['врубите глобус', 'главное чтобы не свет'], ['зажги глобус пожалуйста', 'не надо включать этот свет'],
    ['зажечь глобус пожалуйста', 'никакого света']]
  for (const [phrase, answer] of REFUSALS) {
    const question = await say(phrase)
    check(`«${phrase}»: вопрос «Свет или музыку?»`, question?.text === 'Свет или музыку?', question)
    const reply = await say(answer)
    check(`«${answer}»: ничего не выполнено, не выучено`, !executed() && reply?.kind !== 'llm', { calls, reply })
    const after = existsSync(AMBIGUITY_FILE) ? readFileSync(AMBIGUITY_FILE, 'utf8') : '{}'
    check(`«${answer}»: выбор не выучен`, !after.includes(phrase), after)
    await settle()
  }
  await settle()
  const asked3 = await say('вруби глобус')
  check('«вруби глобус»: вопрос «Свет или музыку?»', asked3?.text === 'Свет или музыку?', asked3)
  const reply3 = await say('не музыку а свет')
  check('«не музыку, а свет»: свет включён', calls.some(call => call.body.entity_id === 'switch.globus3' && call.path.endsWith('/turn_on')), { calls, reply3 })
  await settle()
}

// «Включить или выключить чайник?»: a refusal beats the verb that comes with it
{
  kettle().state = 'off'
  const asked = await say('чайник')
  check('«чайник»: вопрос «Включить или выключить чайник?»', asked?.text === 'Включить или выключить чайник?' && asked.listen === true, asked)
  const reply = await say('включить нет')
  check('«включить нет»: чайник не включён', !executed(), { calls, reply })
  await settle()
  await say('чайник')
  const mixed = await say('чайник не включай а свет включи')
  check('«чайник не включай, а свет включи»: чайник не включён', !executed(), { calls, mixed })
  await settle()
}
// «Ты про чайник?» (a typo): an explicit refusal cancels, «нет, я про другое» still hands the phrase to the brain
{
  kettle().state = 'off'
  const asked = await say('включи чайинк')
  check('«включи чайинк»: вопрос «Ты про чайник?»', asked?.text === 'Ты про чайник?' && asked.listen === true, asked)
  const refused = await say('не делай')
  check('«не делай»: отмена молча, фраза не уходит мозгу', silent(refused) && !executed(), { calls, refused })
  await say('включи чайинк')
  const other = await say('другое')
  check('«другое»: фраза уходит мозгу', other?.kind === 'llm' && other.text === 'включи чайинк' && !executed(), { calls, other })
}

// «Какую громкость поставить?»: «не семь» does not set seven
{
  const asked = await say('громкость')
  check('«громкость»: вопрос', asked?.text === 'Какую громкость поставить?', asked)
  const reply = await say('не семь', { speakerLevel: 5 })
  check('«не семь»: громкость не поставлена', reply === null || (reply.quasarDirectives ?? []).every(directive => directive.Name !== 'sound_set_level'), reply)
  await settle()
}

// ── 2. several stations ─────────────────────────────────────────────────────────────────────────────────────────────
const STATION_A = 'AAAA0001'
const STATION_B = 'BBBB0002'
const turnMemory = await import('../turn-memory.ts') as {
  latestTurn: (want: string, station: string, now?: number) => null | { spoken: null | string }
  stationKey?: (deviceId: string | undefined) => string
  recordTurn: (turn: { action: null, asked: boolean, at: number, heard: string, origin: 'voice', spoken: null | string, station: string }) => void
  default?: object
}
const { latestTurn, recordTurn, stationKey: keyOf } = (turnMemory.latestTurn === undefined ? turnMemory.default : turnMemory) as typeof turnMemory
// What input-handler records for a brain answer: the turn with the key of the connection's station (an image without per-station
// memory has no `stationKey`: its turns carry the bare id and are shared by everyone, which is what the checks below catch).
const stationKey = keyOf ?? ((deviceId: string | undefined): string => deviceId ?? '')
const brainTurn = (station: string, spoken: string) => ({ action: null, asked: false, at: Date.now(), heard: 'расскажи что-нибудь', origin: 'voice' as const, spoken, station: stationKey(station) })

// a question is answered by the station that was asked, and another station's «да» or «нет» leaves it open
{
  resetTurns()
  kettle().state = 'off'
  await say('включи чайник', { deviceId: STATION_A })
  kettle().state = 'off'
  const asked = await say('повтори', { deviceId: STATION_A })
  check('A: «повтори» после чайника → вопрос', asked?.text === 'Повторить: включить чайник?' && asked.listen === true, asked)
  const foreignYes = await say('да', { deviceId: STATION_B })
  check('B: «да» на вопрос станции A ничего не запускает', !executed(), { calls, foreignYes })
  const foreignNo = await say('нет', { deviceId: STATION_B })
  check('B: «нет» не отменяет вопрос станции A', !executed(), { calls, foreignNo })
  const yes = await say('да', { deviceId: STATION_A })
  check('A: «да» после чужих ответов включает чайник', turnedOnKettle(), { calls, yes })
  await settle()
}
{
  const asked = await say('громкость', { deviceId: STATION_A })
  check('A: «громкость» → вопрос', asked?.text === 'Какую громкость поставить?', asked)
  const foreign = await say('семь', { deviceId: STATION_B })
  check('B: «семь» не отвечает на вопрос станции A', (foreign?.quasarDirectives ?? []).every(directive => directive.Name !== 'sound_set_level'), foreign)
  const own = await say('семь', { deviceId: STATION_A })
  check('A: «семь» отвечает на свой вопрос', (own?.quasarDirectives ?? []).some(directive => directive.Name === 'sound_set_level'), own)
}

// «повтори» says again what the speaker that asks heard, never another speaker's turn
{
  resetTurns()
  const a = await say('какая громкость', { deviceId: STATION_A, speakerLevel: 6 })
  const foreign = await say('повтори', { deviceId: STATION_B })
  check('B: «повтори» не повторяет ответ станции A', foreign === null, foreign)
  const b = await say('какая громкость', { deviceId: STATION_B, speakerLevel: 3 })
  const repeatA = await say('повтори', { deviceId: STATION_A })
  const repeatB = await say('повтори', { deviceId: STATION_B })
  check('A: «повтори» → свой ответ', repeatA?.text === a?.text && a?.text !== b?.text, { a, b, repeatA })
  check('B: «повтори» → свой ответ', repeatB?.text === b?.text, { b, repeatB })
  // the brain's answers are recorded by the websocket handler with the station of the connection
  resetTurns()
  recordTurn(brainTurn(STATION_A, 'Колобок повесился.'))
  check('B: «повтори» не повторяет ответ мозга станции A', await say('повтори', { deviceId: STATION_B }) === null, null)
  check('A: «повтори» повторяет ответ мозга', (await say('повтори', { deviceId: STATION_A }))?.text === 'Колобок повесился.', null)
}
{
  // «а на кухне?» continues the last command of the same station only
  resetTurns()
  for (const entity of entities.values()) entity.state = 'off'
  await say('включи свет в гостиной', { deviceId: STATION_A })
  for (const entity of entities.values()) entity.state = 'off'
  await say('а на кухне?', { deviceId: STATION_B })
  check('B: «а на кухне?» не продолжает команду станции A', !executed(), calls)
  await say('а на кухне?', { deviceId: STATION_A })
  check('A: «а на кухне?» продолжает свою команду', calls.some(call => call.body.entity_id === 'light.kukhnia_svetilnik' && call.path.endsWith('/turn_on')), calls)
  // the chatter after the command («Не знаю.») is not part of what the follow-up repeats
  for (const entity of entities.values()) entity.state = 'off'
  await say('Включи свет в гостиной. Не знаю.', { deviceId: STATION_A })
  for (const entity of entities.values()) entity.state = 'off'
  await say('а на кухне?', { deviceId: STATION_A })
  check('A: «а на кухне?» после команды с болтовнёй', calls.some(call => call.body.entity_id === 'light.kukhnia_svetilnik' && call.path.endsWith('/turn_on')), calls)
}

// the memories are bounded: made-up station ids push the oldest out, the newest stay, and an old question still expires
{
  resetTurns()
  const stations = Array.from({ length: 300 }, (_, index) => `THROWAWAY${index}`)
  for (const station of stations) recordTurn(brainTurn(station, `ответ ${station}`))
  check('память реплик: самая старая станция забыта', latestTurn('any', stationKey(stations[0])) === null, latestTurn('any', stationKey(stations[0])))
  check('память реплик: самая новая помнится', latestTurn('any', stationKey(stations.at(-1)))?.spoken === `ответ ${stations.at(-1)}`, null)
  await say('громкость', { deviceId: stations[0] })
  for (const station of stations.slice(1)) await say('громкость', { deviceId: station })
  const oldest = await say('семь', { deviceId: stations[0] })
  check('вопросы: самый старый забыт', (oldest?.quasarDirectives ?? []).every(directive => directive.Name !== 'sound_set_level'), oldest)
  const newest = await say('семь', { deviceId: stations.at(-1) })
  check('вопросы: самый новый ждёт ответа', (newest?.quasarDirectives ?? []).some(directive => directive.Name === 'sound_set_level'), newest)
  const realNow = Date.now
  await say('громкость', { deviceId: STATION_A })
  Date.now = () => realNow() + 91_000
  const late = await say('семь', { deviceId: STATION_A })
  Date.now = realNow
  check('вопрос устаревает через 90 секунд', (late?.quasarDirectives ?? []).every(directive => directive.Name !== 'sound_set_level'), late)
}

rmSync(AMBIGUITY_FILE, { force: true })
console.log(`\nБЕЗОПАСНОСТЬ: ${total - failed}/${total}`)
process.exit(failed === 0 ? 0 : 1)

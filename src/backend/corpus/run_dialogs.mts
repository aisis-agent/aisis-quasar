// Multi-turn dialog tests for the fast-intent layer: matchFastIntent() end to end against a
// mocked Home Assistant (no network, no device actions, no sound).
//   docker cp corpus/. CONTAINER:/src/backend/corpus/
//   docker exec -w /src/backend/corpus CONTAINER /node_modules/.bin/tsx run_dialogs.mts
// Checks what the single-turn corpus cannot: confirmation memory («да»/«нет»), slot-fill and
// choice follow-ups, the earcon directive, sound_set_level for volume, HA service payloads.
import { existsSync, readFileSync, rmSync } from 'node:fs'

const AMBIGUITY_FILE = `/tmp/ha-ambiguity-dialogs-${process.pid}.json`
process.env.AISIS_HA_URL = 'http://ha.test'
process.env.AISIS_HA_TOKEN = 'test-token'
process.env.AISIS_HA_AMBIGUITY_FILE = AMBIGUITY_FILE
process.env.SEMANTIC_INTENTS = 'off'
rmSync(AMBIGUITY_FILE, { force: true })

type Attrs = Record<string, unknown>
interface Ent { entity_id: string, state: string, attributes: Attrs }

const areaOf: Record<string, string> = {
  'light.gostinaia_potolok': 'Гостиная', 'light.liustra': 'Гостиная', 'media_player.televizor': 'Гостиная',
  'climate.kondei_1': 'Гостиная', 'media_player.mini_gostinaia': 'Гостиная',
  'light.kukhnia_svetilnik': 'Кухня', 'light.vtoroi_etazh': 'Второй этаж', 'climate.kondei_2': 'Второй этаж'
}
const entities = new Map<string, Ent>()
for (const id of Object.keys(areaOf)) {
  const attrs: Attrs = { friendly_name: id }
  if (id.startsWith('climate.')) Object.assign(attrs, { min_temp: 16, max_temp: 30, temperature: 25 })
  entities.set(id, { attributes: attrs, entity_id: id, state: 'off' })
}
const calls: { path: string, body: Attrs }[] = []
// Stand-in for the adapter's /music/control: what the speaker's AirPlay player answers to a media key.
const control: { actions: string[], reply: Attrs | null } = { actions: [], reply: null }
const volumeStep = { pct: 10 }

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
  if (url.pathname === '/music/control') {
    control.actions.push((JSON.parse(String(init?.body ?? '{}')) as { action: string }).action)
    return control.reply === null ? new Response('', { status: 503 }) : json(control.reply)
  }
  // The dashboard's «шаг громкости» (percent of the full scale; 10 = one speaker level per step).
  if (url.pathname.endsWith('/speaker.volume_step_pct')) return json({ ok: true, value: volumeStep.pct })
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
      if (url.pathname.endsWith('/turn_on')) {
        entity.state = 'on'
        if (typeof body.brightness_pct === 'number') entity.attributes.brightness = Math.round(body.brightness_pct * 2.55)
      }
      if (url.pathname.endsWith('/turn_off')) entity.state = 'off'
      if (url.pathname.endsWith('/set_temperature')) {
        entity.attributes.temperature = body.temperature
        if (body.hvac_mode !== undefined) entity.state = String(body.hvac_mode)
      }
      if (url.pathname.endsWith('/set_hvac_mode')) entity.state = String(body.hvac_mode)
    }
    return json([])
  }
  return new Response('', { status: 404 })
}) as typeof fetch

interface Layer {
  matchFastIntent: (text: string, options?: { dialogActive?: boolean, speakerLevel?: null | number }) => Promise<null | { kind: string, listen?: boolean, text: null | string, quasarDirectives?: { Name: string, Payload: unknown }[] }>
}
const loaded = await import('../ha-intents.ts') as Layer & { default?: Layer }
const { matchFastIntent } = loaded.matchFastIntent === undefined ? loaded.default! : loaded

let failed = 0
let total = 0
function check (name: string, ok: boolean, detail: unknown): void {
  total++
  if (!ok) { failed++; console.log(`  ✗ ${name}: ${JSON.stringify(detail)}`) }
}
const names = (result: Awaited<ReturnType<typeof matchFastIntent>>): string[] =>
  result?.quasarDirectives?.map(directive => directive.Name) ?? []
function payload (result: Awaited<ReturnType<typeof matchFastIntent>>, name: string): Record<string, unknown> | undefined {
  const directive = result?.quasarDirectives?.find(item => item.Name === name)
  const fields = (directive?.Payload as { fields?: Record<string, { numberValue?: number, stringValue?: string }> } | undefined)?.fields
  if (fields === undefined) return undefined
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.numberValue ?? value.stringValue]))
}
async function say (text: string) { calls.length = 0; return await matchFastIntent(text) }
// Mock speaker: its own level rides along with every turn (the request's DeviceState) and it applies the
// directives the way the firmware does: sound_set_level sets, sound_louder/sound_quiter step one level, 0..10.
const speaker = { level: 5 }
async function sayToSpeaker (text: string) {
  calls.length = 0
  const result = await matchFastIntent(text, { speakerLevel: speaker.level })
  for (const directive of result?.quasarDirectives ?? []) {
    if (directive.Name === 'sound_set_level') speaker.level = payload(result, 'sound_set_level')?.new_level as number
    if (directive.Name === 'sound_louder') speaker.level = Math.min(10, speaker.level + 1)
    if (directive.Name === 'sound_quiter') speaker.level = Math.max(0, speaker.level - 1)
  }
  return result
}

// 1. «громкость 10»: silent, sound_set_level 10 + earcon, never an HA call.
for (const phrase of ['громкость 10', 'Громкость 10.', 'громкость десять', 'громкасть дясять', 'гром кость 10', 'звук 10']) {
  const result = await say(phrase)
  check(`${phrase}: silent`, result?.kind === 'reply' && result.text === null, result)
  check(`${phrase}: directives`, JSON.stringify(names(result)) === '["sound_set_level","local_audio_file_play"]', names(result))
  check(`${phrase}: level 10`, payload(result, 'sound_set_level')?.new_level === 10, payload(result, 'sound_set_level'))
  check(`${phrase}: earcon`, payload(result, 'local_audio_file_play')?.sound_to_play === 'AliceIoTSoundsTurnOn', payload(result, 'local_audio_file_play'))
  check(`${phrase}: no HA call`, calls.length === 0, calls)
}
// relative volume steps from the speaker's OWN level, never from HA (the mock station player has no volume —
// in production it is unavailable, and a guessed base made «громче» always 7 and «тише» always 3)
{
  speaker.level = 5
  const up: number[] = []
  for (let i = 0; i < 3; i++) {
    const result = await sayToSpeaker('громче')
    check(`громче #${i + 1}: directives`, JSON.stringify(names(result)) === '["sound_set_level","local_audio_file_play"]' && result?.text === null, names(result))
    up.push(speaker.level)
  }
  check('громче ×3 from 5: 6, 7, 8 (never a constant)', JSON.stringify(up) === '[6,7,8]', up)
  const down: number[] = []
  for (let i = 0; i < 3; i++) {
    await sayToSpeaker('тише')
    down.push(speaker.level)
  }
  check('тише ×3 from 8: 7, 6, 5 (never a constant)', JSON.stringify(down) === '[7,6,5]', down)
  await sayToSpeaker('чуть громче')
  check('чуть громче: 5 → 6', speaker.level === 6, speaker.level)
  await sayToSpeaker('намного громче')
  check('намного громче: 6 → 8', speaker.level === 8, speaker.level)
  await sayToSpeaker('намного тише')
  check('намного тише: 8 → 6', speaker.level === 6, speaker.level)
  await sayToSpeaker('прибавь громкость')
  check('прибавь громкость: 6 → 7', speaker.level === 7, speaker.level)
  await sayToSpeaker('убавь громкость')
  check('убавь громкость: 7 → 6', speaker.level === 6, speaker.level)
  const bases: string[] = []
  for (let base = 1; base <= 9; base++) {
    speaker.level = base
    await sayToSpeaker('громче')
    if (speaker.level !== base + 1) bases.push(`${base}→${speaker.level}`)
  }
  for (let base = 2; base <= 10; base++) {
    speaker.level = base
    await sayToSpeaker('тише')
    if (speaker.level !== base - 1) bases.push(`${base}→${speaker.level}`)
  }
  check('every base level steps by exactly one', bases.length === 0, bases)
  // Clamps: the top changes nothing and says nothing; «тише» never mutes the station.
  speaker.level = 10
  const top = await sayToSpeaker('громче')
  check('громче at 10: stays 10, silent', speaker.level === 10 && top?.text === null && payload(top, 'sound_set_level')?.new_level === 10, top)
  speaker.level = 1
  const bottom = await sayToSpeaker('тише')
  check('тише at 1: stays 1, silent', speaker.level === 1 && bottom?.text === null && payload(bottom, 'sound_set_level')?.new_level === 1, bottom)
  speaker.level = 9
  await sayToSpeaker('намного громче')
  check('намного громче at 9: clamps to 10', speaker.level === 10, speaker.level)
  speaker.level = 0
  await sayToSpeaker('тише')
  check('тише at 0: stays 0 (never louder)', speaker.level === 0, speaker.level)
  await sayToSpeaker('громче')
  check('громче at 0: 1', speaker.level === 1, speaker.level)
  // The configured step scales «громче»/«тише»: 30% (the default) is three levels, «намного» two steps, never past the clamps.
  volumeStep.pct = 30
  speaker.level = 4
  await sayToSpeaker('громче')
  check('step 30%: громче 4 → 7', speaker.level === 7, speaker.level)
  await sayToSpeaker('намного громче')
  check('step 30%: намного громче 7 → 10 (clamp)', speaker.level === 10, speaker.level)
  await sayToSpeaker('намного тише')
  check('step 30%: намного тише 10 → 4', speaker.level === 4, speaker.level)
  const stock = await say('громче')
  check('step 30%, no speaker level: 3× sound_louder', JSON.stringify(names(stock)) === '["sound_louder","sound_louder","sound_louder","local_audio_file_play"]', names(stock))
  volumeStep.pct = 10
  // Absolute asks ignore the speaker level.
  speaker.level = 8
  await sayToSpeaker('громкость 5')
  check('громкость 5 at 8: 5', speaker.level === 5, speaker.level)
  await sayToSpeaker('максимальная громкость')
  check('максимальная громкость: 10', speaker.level === 10, speaker.level)
  check('volume: no HA call', calls.length === 0, calls)
  // No level reported by the request: the stock relative directives step (one level each), never a guess.
  const noLevel = await say('громче')
  check('громче without speaker level: sound_louder', JSON.stringify(names(noLevel)) === '["sound_louder","local_audio_file_play"]', names(noLevel))
  const noLevelQuiet = await say('намного тише')
  check('намного тише without speaker level: 2× sound_quiter', JSON.stringify(names(noLevelQuiet)) === '["sound_quiter","sound_quiter","local_audio_file_play"]', names(noLevelQuiet))
  // «какая громкость» answers from the speaker's own level.
  const asked = await matchFastIntent('какая громкость', { speakerLevel: 4 })
  check('какая громкость: 4 из 10 (dashboard units, not percent)', asked?.text === 'Громкость 4 из 10.' && asked.listen !== true, asked)
  // Every other volume command stays silent: only the explicit question speaks.
  for (const phrase of ['громче', 'тише', 'намного громче', 'громкость 5', 'максимальная громкость', 'минимальная громкость', 'прибавь громкость', 'убавь громкость']) {
    const result = await matchFastIntent(phrase, { speakerLevel: 4 })
    check(`${phrase}: silent (earcon only)`, result?.kind === 'reply' && result.text === null && result.listen !== true, result)
  }
  const askedBlind = await say('какая громкость')
  check('какая громкость without level: honest', askedBlind?.text === 'Не знаю текущую громкость.', askedBlind)
}
// 2. slot fill: noun only → question → number
{
  const ask = await say('громкость')
  check('громкость: asks', ask?.kind === 'reply' && ask.text === 'Какую громкость поставить?', ask)
  const done = await say('семь')
  check('семь: level 7', done?.text === null && payload(done, 'sound_set_level')?.new_level === 7, done)
}
// 3. choice: ambiguous unit → option noun
{
  const ask = await say('50 процентов')
  check('50 процентов: asks', ask?.text === 'Громкость или яркость?', ask)
  const done = await say('яркость')
  check('яркость: brightness call', calls.some(call => call.path === '/api/services/light/turn_on' && call.body.brightness_pct === 50), calls)
  check('яркость: earcon', names(done).includes('local_audio_file_play') && done?.text === null, done)
}
// 4. confirm → yes executes, remembered; confirm → no cancels
{
  const ask = await say('22 градуса')
  check('22 градуса: asks', ask?.text === 'Поставить кондиционер на 22 градуса?', ask)
  const done = await say('да')
  const set = calls.find(call => call.path === '/api/services/climate/set_temperature')
  check('да: set_temperature 22 + start mode', set?.body.temperature === 22 && set.body.hvac_mode === 'cool', calls)
  check('да: earcon, no speech', done?.text === null && names(done).includes('local_audio_file_play'), done)
  const again = await say('22 градуса')
  check('повтор: выучено, без вопроса', again?.text === null && names(again).includes('local_audio_file_play'), again)
  const no = await say('20 градусов')
  check('20 градусов: asks', no?.text === 'Поставить кондиционер на 20 градусов?', no)
  const cancelled = await say('не надо')
  check('не надо: отмена молча, без вызова', cancelled?.text === null && calls.length === 0, { calls, cancelled })
}
// 5. verb typo → confirm → yes
{
  entities.get('light.liustra')!.state = 'off'
  const ask = await say('вклчи люстру')
  check('вклчи люстру: asks', ask?.text === 'Включить люстру?', ask)
  const done = await say('давай')
  check('давай: turn_on liustra', calls.some(call => call.path === '/api/services/light/turn_on' && call.body.entity_id === 'light.liustra'), calls)
  check('давай: earcon on', payload(done, 'local_audio_file_play')?.sound_to_play === 'AliceIoTSoundsTurnOn', done)
  const off = await say('выключи люстру')
  check('выключи люстру: earcon off, silent', off?.text === null && payload(off, 'local_audio_file_play')?.sound_to_play === 'AliceIoTSoundsTurnOff', off)
}
// 6. missing verb → clarify → verb
{
  const ask = await say('свет на кухню')
  check('свет на кухню: asks', ask?.text === 'Включить или выключить свет на кухне?', ask)
  const done = await say('включи')
  check('включи: kitchen light on', calls.some(call => call.body.entity_id === 'light.kukhnia_svetilnik'), calls)
  check('включи: earcon', done?.text === null && names(done).includes('local_audio_file_play'), done)
}
// 7. brain-routed media: confirm → yes reroutes canonical text
{
  const ask = await say('следущий трек')
  check('следущий трек: asks', ask?.text === 'Включить следующий трек?', ask)
  const done = await say('ага')
  check('ага: routed to brain', JSON.stringify(done) === JSON.stringify({ kind: 'llm', text: 'следующий трек' }), done)
}
// 8. nothing close / compound / chat → brain (null)
for (const phrase of ['десять', 'громкость в моей жизни', 'громкость 10 и яркость 50', 'температура на улице', 'расскажи про яркость солнца']) {
  const result = await say(phrase)
  check(`${phrase}: → brain`, result === null, result)
}
// 9. an unrelated phrase after an unanswered question is matched normally
{
  await say('громкость')
  const result = await say('включи люстру')
  check('вопрос без ответа → новая команда', result?.text === null && names(result).includes('local_audio_file_play'), result)
}

// 10. ShouldListen contract: only a question keeps the mic open; executed commands, volume,
// answers and silent cancels end the dialog (no wake-free continuation).
{
  entities.get('light.liustra')!.state = 'on'
  const executed = await say('выключи люстру')
  check('выполнено: не слушать', executed?.text === null && executed.listen !== true, executed)
  const volume = await say('громкость 10')
  check('громкость: не слушать', volume?.text === null && volume.listen !== true, volume)
  const ask = await say('громкость')
  check('clarify: слушать', ask?.listen === true, ask)
  const filled = await say('семь')
  check('ответ на clarify, выполнено: не слушать', filled?.text === null && filled.listen !== true, filled)
  const confirm = await say('20 градусов')
  check('confirm: слушать', confirm?.listen === true && confirm.text !== null, confirm)
  const cancelled = await say('не надо')
  check('отмена: молча, не слушать', cancelled?.text === null && cancelled.listen !== true, cancelled)
  const query = await say('какая громкость')
  check('ответ на вопрос: не слушать', query?.kind === 'reply' && query.listen !== true, query)
}
// 11. Not heard: command-like but no probable candidate → «Повтори?» once, mic open,
// no enumeration; a second miss right after stays silent; any other decision re-arms it.
{
  const first = await say('70 кроцентов')
  check('недослышала: фраза, слушать', first?.text === 'Повтори?' && first.listen === true, first)
  check('недослышала: без перечисления', first?.text?.includes(' или ') !== true, first)
  const second = await say('70 прыцентов')
  check('второй промах подряд: тишина', second?.kind === 'reply' && second.text === null && second.listen !== true, second)
  await say('выключи люстру')
  const third = await say('50 процэктои')
  check('после другой команды снова переспрашивает', third?.text === 'Повтори?' && third.listen === true, third)
  const hallucination = await say('Продолжение следует...')
  check('«Продолжение следует» не вопрос про воспроизведение', hallucination === null, hallucination)
}

// 12. Media keys go to the speaker's AirPlay player (adapter), then to a playing HA player; the brain
// never answers them and the speaker never talks over a stop.
{
  const earcon = (result: Awaited<ReturnType<typeof say>>): boolean => result?.text === null && names(result).includes('local_audio_file_play')
  control.reply = { ok: true, via: 'ma' }
  for (const [phrase, action] of [['стоп', 'stop'], ['Алиса, пауза', 'pause'], ['продолжи', 'resume'], ['дальше', 'next'],
    ['предыдущий трек', 'previous'], ['поставь на паузу', 'pause'], ['выключи музыку', 'stop']] as const) {
    control.actions.length = 0
    const result = await say(phrase)
    check(`${phrase}: → адаптер ${action}`, control.actions.join() === action, control.actions)
    check(`${phrase}: тишина + earcon, не слушать`, earcon(result) && result?.listen !== true, result)
  }
  // fuzzy «предыдщий трек» confirmed with «ага» is still the media key
  control.actions.length = 0
  const ask = await say('предыдщий трек')
  check('предыдщий трек: сначала вопрос, адаптер не тронут', ask?.listen === true && control.actions.length === 0, [ask, control.actions])
  const confirmed = await say('ага')
  check('предыдщий трек + ага → адаптер previous', control.actions.join() === 'previous' && earcon(confirmed), [control.actions, confirmed])
  // nothing of ours is playing: stop/pause stay silent, resume/next fall through to the old path
  control.reply = { err: 'idle', ok: false }
  for (const phrase of ['стоп', 'пауза', 'хватит']) {
    const result = await say(phrase)
    check(`${phrase}: ничего не играет → молча, без звука`, result?.kind === 'reply' && result.text === null && !names(result).includes('local_audio_file_play'), result)
  }
  for (const phrase of ['продолжи', 'дальше']) {
    const result = await say(phrase)
    check(`${phrase}: ничего не играет → дальше по цепочке (null)`, result === null, result)
  }
  // a playing HA player (TV) takes the key when MA is idle
  entities.get('media_player.televizor')!.state = 'playing'
  const tv = await say('пауза')
  check('пауза: играет телевизор → media_pause', calls.some(call => call.path === '/api/services/media_player/media_pause' && call.body.entity_id === 'media_player.televizor') && earcon(tv), [calls, tv])
  entities.get('media_player.televizor')!.state = 'off'
  // a phone owns the session: stop/pause work, the rest says so once
  control.reply = { err: 'unsupported_sender', ok: false }
  const phone = await say('следующий трек')
  check('с телефона: next → короткая фраза', phone?.text === 'Это играет с телефона, управляй с него.' && phone.listen !== true, phone)
  // adapter down: stop stays silent
  control.reply = null
  const down = await say('стоп')
  check('адаптер недоступен: стоп молча', down?.kind === 'reply' && down.text === null && !names(down).includes('local_audio_file_play'), down)
}

// 13. End of dialog («ничего», «хватит», «спасибо», «стоп»…): always silent, no brain, mic closed, pending question
// cleared. Inside a dialog it never touches the music; as a fresh turn only the stop class does.
{
  control.reply = { ok: true } // music is playing
  control.actions.length = 0
  const inDialog = (text: string) => { calls.length = 0; return matchFastIntent(text, { dialogActive: true }) }
  for (const phrase of ['ничего', 'Алиса, ничего', 'ничево', 'хватит', 'стоп', 'замолчи', 'остонавись', 'отмена', 'не надо', 'спасибо', 'нет', 'ладно', 'пока']) {
    const result = await inDialog(phrase)
    check(`в диалоге «${phrase}»: молча, без звука, микрофон закрыт`, result?.kind === 'reply' && result.text === null && result.listen !== true &&
      (result.quasarDirectives?.length ?? 0) === 0, result)
  }
  check('в диалоге: музыка не тронута', control.actions.length === 0, control.actions)
  // a fresh «стоп» is the media key: it reaches the player
  const fresh = await say('Алиса, стоп')
  check('свежий «стоп»: музыка остановлена', control.actions.join() === 'stop' && names(fresh).includes('local_audio_file_play'), [control.actions, fresh])
  for (const phrase of ['хватит', 'замолчи', 'тихо']) {
    control.actions.length = 0
    await say(phrase)
    check(`свежий «${phrase}»: stop в адаптер`, control.actions.join() === 'stop', control.actions)
  }
  // the other classes never stop music, fresh or not
  control.actions.length = 0
  for (const phrase of ['ничего', 'отмена', 'не надо', 'спасибо', 'нет', 'пока', 'всё']) {
    const result = await say(phrase)
    check(`свежий «${phrase}»: молча, музыка играет`, result?.kind === 'reply' && result.text === null && (result.quasarDirectives?.length ?? 0) === 0 &&
      control.actions.length === 0, [result, control.actions])
  }
  // «останови музыку» is a media request, not a dialog end: still stops
  control.actions.length = 0
  await say('останови музыку')
  check('«останови музыку» останавливает музыку', control.actions.join() === 'stop', control.actions)
  // nothing playing: a fresh «стоп» ends silently
  control.reply = { err: 'idle', ok: false }
  const idle = await say('стоп')
  check('ничего не играет: «стоп» молча', idle?.kind === 'reply' && idle.text === null && !names(idle).includes('local_audio_file_play'), idle)
  // a terminator clears the pending question: the next answer-looking phrase is not slot-filled
  await say('громкость')
  const ended = await inDialog('хватит')
  check('«хватит» на вопрос: молча', ended?.kind === 'reply' && ended.text === null && ended.listen !== true, ended)
  const stray = await say('семь')
  check('после «хватит» вопрос снят: «семь» уже не громкость', stray === null, stray)
  // terminators inside a longer request stay requests
  for (const phrase of ['стоп-кран', 'ничего себе', 'хватит света']) {
    const result = await say(phrase)
    check(`«${phrase}»: не конец диалога`, result === null || result.kind !== 'reply' || result.text !== null || (result.quasarDirectives?.length ?? 0) > 0, result)
  }
  control.reply = null
}

// 14. «повтори» / «ещё раз» / «прошлую команду» and «а на кухне?» are answered from the last turns (turn-memory.ts),
// never by a clarifying brain question («Повторить что: мой последний ответ или что-то другое?», 2026-11-09 00:58).
{
  const memory = await import('../turn-memory.ts') as { resetTurns: () => void, default?: { resetTurns: () => void } }
  const resetTurns = memory.resetTurns ?? memory.default!.resetTurns
  const turn = async (text: string, options: { origin?: 'text' | 'voice', speakerLevel?: number } = {}) => {
    calls.length = 0
    return await (matchFastIntent as (text: string, options: object) => ReturnType<typeof matchFastIntent>)(text, options)
  }
  const kettle: Ent = { attributes: { friendly_name: 'kettle' }, entity_id: 'switch.kettle_plug_local', state: 'off' }
  entities.set(kettle.entity_id, kettle)
  const turnedOn = (entityId: string) => calls.some(call => call.path.endsWith('/turn_on') && call.body.entity_id === entityId)

  // nothing said yet: the phrase goes on (to the brain, which has the adapter's dialog list)
  resetTurns()
  check('повтори без истории: дальше, к мозгу', await turn('Алиса, повтори.') === null, null)

  // the last answer is repeated verbatim, whatever the wake word / politeness / wording
  resetTurns()
  const answer = await turn('какая громкость', { speakerLevel: 6 })
  const said = answer?.text ?? ''
  check('ответ про громкость есть', answer?.kind === 'reply' && said.includes('6'), answer)
  for (const phrase of ['Алиса, повтори.', 'повтори', 'ещё раз', 'повтори пожалуйста', 'то же самое', 'что ты сказала', 'повтори ответ', 'ну повтори ещё раз']) {
    const again = await turn(phrase)
    check(`«${phrase}»: тот же ответ, не вопрос мозга`, again?.kind === 'reply' && again.text === said && again.listen !== true, again)
  }

  // after a silent command: the command runs again (a volume step is bounded and safe); «ответ» still finds the answer
  speaker.level = 5
  const said5 = (await turn('какая громкость', { speakerLevel: 5 }))?.text
  await sayToSpeaker('громче')
  check('громче: 5 → 6', speaker.level === 6, speaker.level)
  const stepAgain = await sayToSpeaker('Алиса, повтори')
  check('повтори после «громче»: ещё шаг', stepAgain?.text === null && speaker.level === 7, [speaker.level, stepAgain])
  const lastCommand = await sayToSpeaker('повтори прошлую команду')
  check('«прошлую команду»: ещё шаг', lastCommand?.text === null && speaker.level === 8, [speaker.level, lastCommand])
  const lastAnswer = await turn('повтори ответ')
  check('«повтори ответ» после команд: последний ответ', lastAnswer?.text === said5, [lastAnswer, said5])

  // a spoken turn outranks a text one (agents and the dashboard inject text turns): the owner means what they heard
  resetTurns()
  const said4 = (await turn('какая громкость', { speakerLevel: 4 }))?.text
  await turn('громче', { origin: 'text', speakerLevel: 4 })
  const heard = await turn('повтори')
  check('текстовая команда не перебивает голосовой ответ', heard?.text === said4, [heard, said4])

  // expired: eleven minutes later «повтори» is no longer about the last turn
  resetTurns()
  await turn('какая громкость', { speakerLevel: 3 })
  const realNow = Date.now
  Date.now = () => realNow() + 11 * 60_000
  const stale = await turn('повтори')
  Date.now = realNow
  check('через 11 минут: дальше, к мозгу', stale === null, stale)

  // a hazardous action is asked about first; «да» runs it and does NOT teach «повтори» as a home phrase
  resetTurns()
  const boil = await turn('включи чайник')
  check('чайник включён', boil?.text === null && turnedOn(kettle.entity_id), [boil, calls])
  kettle.state = 'off'
  const confirmRepeat = await turn('повтори')
  check('повтор чайника: вопрос, без вызова', confirmRepeat?.text === 'Повторить: включить чайник?' && confirmRepeat.listen === true && calls.length === 0, [confirmRepeat, calls])
  const askedAgain = await turn('повтори')
  check('повтори на вопрос: тот же вопрос, ещё слушает', askedAgain?.text === 'Повторить: включить чайник?' && askedAgain.listen === true, askedAgain)
  const yes = await turn('да')
  check('«да»: чайник включён', yes?.text === null && turnedOn(kettle.entity_id), [yes, calls])
  check('«да» на повтор не учит фразу «повтори»', !existsSync(AMBIGUITY_FILE) || !readFileSync(AMBIGUITY_FILE, 'utf8').includes('повтори'), null)
  kettle.state = 'off'
  await turn('повтори')
  const no = await turn('нет')
  check('«нет» на вопрос о повторе: без вызова', no?.kind === 'reply' && calls.length === 0, [no, calls])
  entities.delete(kettle.entity_id)

  // a question that is still pending is repeated as a question and stays answerable
  resetTurns()
  const ask = await turn('громкость')
  check('громкость: спрашивает', ask?.kind === 'reply' && ask.listen === true && (ask.text ?? '') !== '', ask)
  const reask = await turn('повтори')
  check('повтори на вопрос: тот же вопрос, ждёт ответ', reask?.text === ask?.text && reask?.listen === true, [reask, ask])
  const filled = await turn('семь')
  check('ответ после повтора вопроса: громкость 7', payload(filled, 'sound_set_level')?.new_level === 7, filled)

  // «а на кухне?» right after a room command: the same command for the room just named
  resetTurns()
  const living = await turn('включи свет в гостиной')
  check('свет в гостиной включён', living?.text === null && turnedOn('light.liustra'), [living, calls])
  for (const entity of entities.values()) if (entity.entity_id.startsWith('light.')) entity.state = 'off'
  const kitchen = await turn('а на кухне?')
  check('«а на кухне?»: свет на кухне, гостиная не тронута', kitchen?.text === null && turnedOn('light.kukhnia_svetilnik') && !turnedOn('light.liustra'), [kitchen, calls])
  await turn('выключи свет в гостиной')
  entities.get('light.vtoroi_etazh')!.state = 'on'
  const upstairs = await turn('а наверху')
  check('«а наверху»: выключен свет на втором этаже', upstairs?.text === null && calls.length > 0 && calls.every(call => call.path.endsWith('/turn_off')) &&
    calls.some(call => call.body.entity_id === 'light.vtoroi_etazh'), [upstairs, calls])
  // not a follow-up: no command ran recently, or the phrase says more than a room
  resetTurns()
  await turn('а на кухне?')
  check('«а на кухне?» без команды: ничего не выполнено', calls.length === 0, calls)
  await turn('включи свет в гостиной')
  await turn('а какая на кухне погода?')
  check('«а какая на кухне погода?» — не уточнение комнаты', calls.length === 0, calls)

  // «да» with nothing pending (the brain asked, or the question expired) never throws and executes nothing
  resetTurns()
  const stray = await turn('да')
  check('«да» без вопроса: ничего не выполнено, без падения', calls.length === 0 && (stray === null || stray.kind !== 'reply' || stray.text === null || stray.listen !== true), stray)
  resetTurns()

  // «да» heard by the STT gateway as a distrusted lone «Спасибо.» (weak_filler) in the answer window of a question:
  // asked again, once per dialog; silence, a hallucination on silence and a foreign voice stay silent.
  const turnMemory = await import('../turn-memory.ts') as { shouldReask: (rejected: string, answering: boolean, again: boolean) => boolean, default?: object }
  const shouldReask = turnMemory.shouldReask ?? (turnMemory.default as typeof turnMemory).shouldReask
  check('«да» → weak_filler в окне ответа: переспросить', shouldReask('weak_filler', true, false), null)
  check('повтор мусора: второй раз молча', !shouldReask('weak_filler', true, true), null)
  check('не в окне ответа на вопрос: молча', !shouldReask('weak_filler', false, false), null)
  check('чужой голос: молча', !shouldReask('foreign_voice', true, false), null)
  check('галлюцинация на тишине: молча', !shouldReask('hallucination', true, false), null)
}

rmSync(AMBIGUITY_FILE, { force: true })
console.log(`\nДИАЛОГИ: ${total - failed}/${total}`)
process.exit(failed === 0 ? 0 : 1)

// Corpus runner: pure-text routing tests against decideFastIntent() — no HA calls, no device actions.
// Runs INSIDE a quasar container next to /src/backend/ha-intents.ts (bluegreen/deploy.sh does it):
//   docker cp corpus/. CONTAINER:/src/backend/corpus/
//   docker exec -w /src/backend/corpus CONTAINER /node_modules/.bin/tsx run_corpus.mts
import { readFileSync } from 'node:fs'
import ha from '../ha-intents.ts'

const corpusPath = process.argv[2] ?? new URL('./intents-ru.jsonl', import.meta.url).pathname

// ── Fixture registry (mirrors /src/backend/ha-intents.ts HaRegistry) ──
const areaBy = [
  ['Гостиная', ['light.gostinaia_potolok', 'light.liustra', 'light.girlianda',
    'light.gostinaia_globus_socket_1', 'media_player.televizor', 'media_player.gostinaia',
    'climate.kondei_1', 'media_player.mini_gostinaia', 'switch.globus3']],
  ['Кухня', ['light.kukhnia_svetilnik', 'switch.kettle_plug_local']],
  ['Спальня', ['light.spalnia_nochnik']],
  ['Студия', ['light.studiia_lampa']],
  ['Прихожая', ['light.prikhozhaia']],
  ['Второй этаж', ['light.vtoroi_etazh', 'climate.kondei_2', 'media_player.projector']]
]
const stateBy = {
  'light.gostinaia_globus_socket_1': 'off',
  'switch.globus3': 'off',
  'switch.kettle_plug_local': 'off',
  'media_player.televizor': 'off',
  'media_player.projector': 'off',
  'climate.kondei_1': 'off',
  'climate.kondei_2': 'off'
}
const areaByEntity = new Map()
const entities = new Map()
for (const [area, ids] of areaBy) {
  for (const id of ids) {
    areaByEntity.set(id, area)
    entities.set(id, { entity_id: id, state: stateBy[id] ?? 'off', attributes: { friendly_name: id } })
  }
}
const reg = { areaByEntity, entities, fetchedAt: Date.now() }

// Runs the real routing (decideFastIntent: exact layer → fuzzy catalog → LLM) and maps its
// tier onto the corpus vocabulary: execute→cmd, confirm/clarify→clarify. A row may pin the
// finer `tier` (execute|confirm|clarify|llm), the resolved `action` and the spoken `question`.
const KIND_BY_TIER = { execute: 'cmd', confirm: 'clarify', clarify: 'clarify', llm: 'llm', math: 'math', query: 'query', answer: 'query', reprompt: 'reprompt' }

function summarize (resolved) {
  if (resolved === undefined) return undefined
  if (resolved.type === 'volume') {
    const v = resolved.volume
    return v.target !== undefined ? `volume:${Math.round(v.target * 10)}` : `volume:${(v.steps ?? 0) > 0 ? '+' : '-'}`
  }
  if (resolved.type === 'brain') return `brain:${resolved.text}`
  const d = resolved.device
  if (d.kind === 'set') return d.brightnessPct !== undefined ? `brightness:${d.brightnessPct}` : `setpoint:${d.temperature}`
  return `${d.kind}:${d.wholeDomain ?? d.targets.join(',')}`
}

function route (text) {
  const d = ha.decideFastIntent(text, reg)
  return { action: summarize(d.resolved), kind: KIND_BY_TIER[d.tier], question: d.question, tier: d.tier }
}

const rows = readFileSync(corpusPath, 'utf8').trim().split('\n').map(JSON.parse)
const byCat = new Map() // domain -> {pass, fail, fails: []}
const tierCount = new Map()
let pass = 0
for (const row of rows) {
  const got = route(row.text)
  tierCount.set(got.tier, (tierCount.get(got.tier) ?? 0) + 1)
  const problems = []
  if (got.kind !== row.expect.kind) problems.push(`${got.kind} (ожидалось ${row.expect.kind})`)
  if (row.expect.tier !== undefined && got.tier !== row.expect.tier) problems.push(`tier ${got.tier} (ожидалось ${row.expect.tier})`)
  if (row.expect.action !== undefined && got.action !== row.expect.action) problems.push(`action ${got.action} (ожидалось ${row.expect.action})`)
  if (row.expect.question !== undefined && got.question !== row.expect.question) problems.push(`вопрос «${got.question}» (ожидалось «${row.expect.question}»)`)
  // Invariant for every row: a question never enumerates more than three options, and an
  // «A или B?» list only names real candidates (the fixed on/off and «Свет или музыку?» pairs aside).
  const options = got.question === undefined || /^Включить или выключить|^Свет или музыку\?$/.test(got.question) ? [] : got.question.replace(/\?$/, '').split(/,| или /)
  if (options.length > 3) problems.push(`перечисляет ${options.length} вариантов: «${got.question}»`)
  if (got.tier === 'reprompt' && got.question !== undefined) problems.push('reprompt не должен задавать вопрос')
  const ok = problems.length === 0
  const cat = byCat.get(row.expect.domain) ?? { pass: 0, fail: 0, fails: [] }
  if (ok) { cat.pass++; pass++ } else { cat.fail++; cat.fails.push(`${row.text} → ${problems.join('; ')}`) }
  byCat.set(row.expect.domain, cat)
}

const pad = (s, n) => String(s).padEnd(n)
console.log(`\nИТОГ: ${pass}/${rows.length} (${(100 * pass / rows.length).toFixed(1)}%)\n`)
console.log(`tiers: ${[...tierCount].map(([t, n]) => `${t}=${n}`).join(' ')}\n`)
console.log(`${pad('domain', 16)}${pad('pass', 6)}${pad('fail', 6)}rate`)
for (const [domain, c] of [...byCat].sort((a, b) => b[1].fail - a[1].fail)) {
  const total = c.pass + c.fail
  console.log(`${pad(domain, 16)}${pad(c.pass, 6)}${pad(c.fail, 6)}${(100 * c.pass / total).toFixed(0)}%`)
  for (const f of c.fails.slice(0, 12)) console.log(`    ✗ ${f}`)
  if (c.fails.length > 12) console.log(`    … ещё ${c.fails.length - 12}`)
}
process.exitCode = pass === rows.length ? 0 : 1

// Corpus runner: pure-text intent tests against scoreIntent() — no HA calls.
// Runs INSIDE container aisis-yandex-quasar-1 next to /src/backend/ha-intents.ts:
//   docker cp corpus/. aisis-yandex-quasar-1:/src/backend/corpus/
//   docker exec -w /src/backend/corpus aisis-yandex-quasar-1 /node_modules/.bin/tsx run_corpus.mts
import { readFileSync } from 'node:fs'
import ha from '../ha-intents.ts'

const { scoreIntent } = ha

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

// Emulates matchFastIntent dispatch from score alone (thresholds 0.9 / 0.5).
function dispatch (r) {
  if (r === null) return 'llm'
  if (r.kind === 'math') return 'math'
  if (r.kind === 'state_query') return 'query'
  if (r.kind === 'volume') return r.volume?.kind === 'query' ? 'query' : 'cmd'
  if (r.score >= 0.9 && r.ambiguous !== true) return 'cmd'
  if (r.score >= 0.5 || r.ambiguous === true) return 'clarify'
  return 'llm'
}

const rows = readFileSync(corpusPath, 'utf8').trim().split('\n').map(JSON.parse)
const byCat = new Map() // domain -> {pass, fail, fails: []}
let pass = 0
for (const row of rows) {
  const got = dispatch(scoreIntent(row.text, reg))
  const ok = got === row.expect.kind
  const cat = byCat.get(row.expect.domain) ?? { pass: 0, fail: 0, fails: [] }
  if (ok) { cat.pass++; pass++ } else { cat.fail++; cat.fails.push(`${row.text} → ${got} (ожидалось ${row.expect.kind})`) }
  byCat.set(row.expect.domain, cat)
}

const pad = (s, n) => String(s).padEnd(n)
console.log(`\nИТОГ: ${pass}/${rows.length} (${(100 * pass / rows.length).toFixed(1)}%)\n`)
console.log(`${pad('domain', 16)}${pad('pass', 6)}${pad('fail', 6)}rate`)
for (const [domain, c] of [...byCat].sort((a, b) => b[1].fail - a[1].fail)) {
  const total = c.pass + c.fail
  console.log(`${pad(domain, 16)}${pad(c.pass, 6)}${pad(c.fail, 6)}${(100 * c.pass / total).toFixed(0)}%`)
  for (const f of c.fails.slice(0, 12)) console.log(`    ✗ ${f}`)
  if (c.fails.length > 12) console.log(`    … ещё ${c.fails.length - 12}`)
}

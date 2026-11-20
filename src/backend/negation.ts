// Negation in the owner's speech, for the fast-intent layer (ha-intents.ts).
//
// The home grammar reads a verb and a noun and nothing else, so «не включай чайник» (verb «включай», noun «чайник») would run
// the very action it forbids, and «не делай» (a confirmation word) would confirm what it refuses. The adapter's grammar guards
// its acting intents the same way (`not_negated`, lexicon: не, нельзя, ни, никогда); this is the guard for the turns that
// grammar does not answer (it is down or slow, or has no rule for the phrase: «лучше не включай чайник»).
//
// Pure module: tokens in, verdicts out.

const NEGATORS = ['не', 'ни', 'нельзя', 'никогда', 'ненадо', 'ненужно', 'неа', 'не-а']
// «никакого света», «никакой музыки»: the negative pronoun refuses what it stands before.
const NEGATIVE_PRONOUN = /^никак/
// What follows these opens a new clause: a negator before them does not reach past («не свет, а музыку»).
const CLAUSE_BREAKS = ['а', 'но', 'зато']
// «Алиса, не мог бы ты включить свет», «не можешь включить свет», «нельзя ли включить свет»: a polite request to the speaker, not a
// refusal. It must open the utterance (after the wake word and the like): «я знаю, что ты не можешь включить чайник» and «я не мог
// бы включить свет» are statements, and «мог» without «бы» is a statement of inability in the past.
const REQUEST_MODALS = ['можешь', 'можете', 'сможешь', 'сможете', 'ли']
const REQUEST_PAST_MODALS = ['мог', 'могла', 'могли']
const REQUEST_LEAD_INS = ['алиса', 'яндекс', 'пожалуйста', 'ну', 'а', 'и', 'ты', 'вы']

function asksPolitely (tokens: readonly string[], index: number): boolean {
  const [next = '', afterNext = '', pronoun = ''] = tokens.slice(index + 1, index + 4)
  const modal = REQUEST_MODALS.includes(next) || REQUEST_PAST_MODALS.includes(next) && afterNext === 'бы' && !['я', 'мы'].includes(pronoun)
  return modal && tokens.slice(0, index).every(word => REQUEST_LEAD_INS.includes(word))
}

function negates (tokens: readonly string[], index: number): boolean {
  const token = tokens[index] ?? ''
  if (NEGATIVE_PRONOUN.test(token)) return true
  if (!NEGATORS.includes(token)) return false
  return !((token === 'не' || token === 'нельзя') && asksPolitely(tokens, index))
}

/** True when any word of the phrase negates something. */
export function hasNegation (tokens: readonly string[]): boolean {
  return tokens.some((_, index) => negates(tokens, index))
}

/** True when a negator stands anywhere in the clause of the word at `index` («не включай пожалуйста этот свет», «свет не включай»). */
export function isNegatedAt (tokens: readonly string[], index: number): boolean {
  let start = index
  while (start > 0 && !CLAUSE_BREAKS.includes(tokens[start - 1] ?? '')) start--
  let end = index + 1
  while (end < tokens.length && !CLAUSE_BREAKS.includes(tokens[end] ?? '')) end++
  return tokens.slice(start, end).some((_, offset) => negates(tokens, start + offset))
}

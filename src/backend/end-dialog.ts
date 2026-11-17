// End-of-dialog phrases: «ничего», «хватит», «спасибо», «стоп», «отмена», «пока»…
//
// A phrase that only closes the conversation never needs an answer. The fast layer ends the
// turn SILENTLY for it (no brain, no filler, no TTS, ShouldListen=false), clears any pending
// confirm/clarify question, and — for the stop class only, and only when it is a fresh turn
// rather than the end of a dialog we are in — stops the music (see ha-intents.ts).
//
// Pure module. Matching is whole-utterance: a terminator word inside a longer request
// («хватит света», «стоп-кран», «останови музыку») is never an end-of-dialog phrase.

import { normalize, tokenize, wordSimilarity } from './fuzzy-ru'

export type EndKind = 'dismiss' | 'no' | 'stop' | 'thanks'

// Words that may surround a terminator without changing it.
const FILLERS = ['алиса', 'яндекс', 'ну', 'пожалуйста', 'плиз', 'уж', 'уже', 'так', 'вот']

const PHRASES: Record<EndKind, string[]> = {
  // Stop the current thing: dialog end, or the music when nothing is being said to us.
  stop: ['стоп', 'стой', 'стойте', 'хватит', 'хватит болтать', 'остановись', 'остановитесь', 'останови', 'остановите',
    'замолчи', 'замолчите', 'молчи', 'помолчи', 'помолчите', 'тихо', 'тишина', 'заткнись', 'заткнитесь',
    'перестань', 'перестаньте', 'прекрати', 'прекратите', 'довольно', 'отбой'],
  // Nothing is wanted.
  dismiss: ['ничего', 'ничего не надо', 'ничего не нужно', 'ничего не хочу', 'не надо', 'не нужно', 'ненадо', 'ненужно',
    'отмена', 'отмени', 'отменить', 'отменяй', 'неважно', 'не важно', 'забей', 'забудь', 'забыли', 'отстань', 'отвяжись',
    'все', 'это все', 'на этом все', 'все ничего', 'проехали', 'ладно', 'ладно ничего', 'ладно все', 'передумал',
    'передумала', 'не обращай внимания'],
  thanks: ['спасибо', 'большое спасибо', 'спасибо большое', 'благодарю', 'все спасибо', 'ладно спасибо', 'пока',
    'пока пока', 'до свидания', 'до скорого', 'до встречи', 'спокойной ночи', 'доброй ночи', 'всего доброго'],
  // The answer to a yes/no offer, or a bare refusal.
  no: ['нет', 'неа', 'не-а', 'нет спасибо', 'нет не надо', 'нет не нужно', 'нет ничего']
}

const ENTRIES = (Object.entries(PHRASES) as [EndKind, string[]][]).flatMap(([kind, phrases]) =>
  phrases.map(phrase => ({ kind, words: phrase.split(' ') })))

// Fuzzy only for words long enough that a typo is unambiguous (wordSimilarity is exact below 5 letters).
const FUZZY_MIN = 0.8

function sameWord (heard: string, expected: string): boolean {
  return heard === expected || expected.length >= 5 && wordSimilarity(heard, expected) >= FUZZY_MIN
}

/** The kind of end-of-dialog phrase `rawText` is as a whole, or null when it is anything else. */
export function parseEndDialog (rawText: string): EndKind | null {
  const words = tokenize(normalize(rawText)).filter(token => token !== '' && !FILLERS.includes(token))
    // «стоп стоп», «нет нет»: repeating a terminator is still one terminator.
    .filter((token, index, all) => index === 0 || token !== all[index - 1])
  if (words.length === 0 || words.length > 4) return null
  const hit = ENTRIES.find(entry => entry.words.length === words.length && entry.words.every((word, index) => sameWord(words[index], word)))
  return hit?.kind ?? null
}

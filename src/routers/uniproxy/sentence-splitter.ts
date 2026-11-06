// Greedy sentence splitter for streaming TTS (quasard SentenceSplitter pattern):
// hard cut on [.!?…;] followed by whitespace or EOS; soft cut on ',' or ':'
// once the buffer is long enough; forced cut at a space beyond the hard limit.
const FIRST_MIN = 12
const SOFT_MIN = 30
const HARD_MAX = 180

export function splitSentencesForTts (text: string): string[] {
  const sentences: string[] = []
  let buffer = ''

  const flush = () => {
    const trimmed = buffer.trim()
    if (trimmed.length > 0) sentences.push(trimmed)
    buffer = ''
  }

  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    buffer += char
    const next = text[index + 1]
    if ('.!?…;'.includes(char) && (next === undefined || /\s/.test(next))) {
      if (buffer.trim().length >= FIRST_MIN) flush()
      continue
    }
    if ((char === ',' || char === ':' || char === '—') && buffer.trim().length >= SOFT_MIN) {
      flush()
      continue
    }
    if (buffer.length >= HARD_MAX) {
      const lastSpace = buffer.lastIndexOf(' ')
      if (lastSpace > FIRST_MIN) {
        const tail = buffer.slice(lastSpace + 1)
        buffer = buffer.slice(0, lastSpace)
        flush()
        buffer = tail
      } else {
        flush()
      }
    }
  }
  flush()
  return sentences
}

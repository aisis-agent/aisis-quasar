// The speaker applies the OffsetSeconds we send verbatim (maind: "New timezone is X, offset = N"),
// and the station record stores a fixed number. A fixed number is right only until the next DST
// switch, so the offset is recomputed from the IANA name at send time; the stored number is the
// fallback for a name the runtime does not know.
export function timezoneOffsetSeconds (name: string, fallback: number, at: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      hour: 'numeric',
      hourCycle: 'h23',
      minute: 'numeric',
      month: 'numeric',
      second: 'numeric',
      timeZone: name,
      year: 'numeric'
    }).formatToParts(at)
    const field = (type: string): number => Number(parts.find(part => part.type === type)?.value)
    const wallClockAsUtc = Date.UTC(field('year'), field('month') - 1, field('day'),
      field('hour'), field('minute'), field('second'))
    const offset = Math.round((wallClockAsUtc - Math.floor(at.getTime() / 1000) * 1000) / 1000)
    return Number.isFinite(offset) ? offset : fallback
  } catch {
    return fallback
  }
}

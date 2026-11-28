// The id the AISIS gateway and Home Assistant know a speaker by is the device id of its UniProxy connection (the same value the spotter
// clips send as x-aisis-station). It goes out in an HTTP header and in log lines the gateway parses, so only the characters of a real
// station id pass: anything else names no station and the peer falls back to its single-speaker rule.
const SAFE_STATION = /^[A-Za-z0-9._-]{1,64}$/

export function stationIdFor (deviceId: string | undefined): string | undefined {
  return deviceId !== undefined && SAFE_STATION.test(deviceId) ? deviceId : undefined
}

/** `message` with ` station=<id>` at its end, as the gateway reads the «Dialog <id> started/ended» lines; unchanged when the id is unusable. */
export function withStation (message: string, deviceId: string): string {
  const station = stationIdFor(deviceId)
  return station === undefined ? message : `${message} station=${station}`
}

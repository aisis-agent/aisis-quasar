// Which room a speaker stands in, read from Home Assistant instead of guessed.
//
// Every station owns media_player entities in HA whose ids end in the station's device id in lower case
// (media_player.aisis_speaker_<device-id>, media_player.yandex_station_<device-id>), and the owner puts them in
// an HA area (Студия, Спальня, Гостиная). That area is the room a phrase without a room is about: «включи свет» said
// to the Studio speaker means the studio. The registry the fast intents already fetch carries the area of every entity,
// so there is no second source of truth and no per-station config to keep in step.

const OWN_PLAYER_PREFIX = 'media_player.aisis_speaker_'

// The HA area of the station `deviceId`, or undefined when HA has no player for it or the player has no area.
// The AISIS speaker's own player wins over the Yandex integration's one (they can sit in different areas).
export function speakerArea (areaByEntity: ReadonlyMap<string, string>, deviceId: string | undefined): string | undefined {
  const id = deviceId?.trim().toLowerCase()
  if (id === undefined || id === '') return undefined
  let other: string | undefined
  for (const [entityId, area] of areaByEntity) {
    if (!entityId.startsWith('media_player.') || !entityId.endsWith(`_${id}`)) continue
    if (entityId.startsWith(OWN_PLAYER_PREFIX)) return area
    other ??= area
  }
  return other
}

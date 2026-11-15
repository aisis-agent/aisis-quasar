/* eslint-disable unicorn/no-await-expression-member */
import { MusicItemType } from '@v3rt3p/types/music'
import bodyParser from 'body-parser'
import { Application, RequestHandler, Router } from 'express'
import { randomUUID } from 'node:crypto'
import { Writer } from 'protobufjs'

import { MusicBackend } from '../backend/backend'
import { toStringOrUndefined } from '../helpers'
import { getLogger } from '../logger'
import proto from '../protos/protos'
import { StationInfoProvider } from '../storage/types'

interface ProtoEncoderDecoder<T> {
  decode(data: Uint8Array): T
  encode(data: T): Writer
}

interface RpcAliceYandexNetRouterProperties {
  infoProvider: StationInfoProvider
  music: MusicBackend
}

export function registerRpcAliceYandexNetRouter (app: Application,
  properties: RpcAliceYandexNetRouterProperties): void {
  const router = Router()

  router.use(bodyParser.raw({
    type: 'application/x-protobuf'
  }))

  router.post('/gproxy/push_events_batch',
    wrapProto(proto.NAlice.TIoTEventsBatchRequest, proto.NAlice.TIoTEventsBatchResponse,
      async () => ({})
    )
  )

  router.post('/gproxy/get_tv_categories',
    wrapProto(proto.NAlice.NTv.TGetTvCategoriesRequest, proto.NAlice.NTv.TGetTvCategoriesResponse,
      async () => ({})
    )
  )

  router.post('/gproxy/get_tv_channels',
    wrapProto(proto.NAlice.NTv.TTvGetChannelsRequest, proto.NAlice.NTv.TTvGetChannelsResponse,
      async () => ({})
    )
  )

  const cardJson = {
    card: {
      log_id: 'v3rt3p_promoblock_' + randomUUID(),
      states: [{
        div: {
          alignment_horizontal: 'center',
          alignment_vertical: 'center',
          background: [{ color: '#000000', type: 'solid' }],
          height: { type: 'match_parent' },
          items: [{
            alignment_horizontal: 'center',
            alignment_vertical: 'center',
            height: { type: 'fixed', value: 1000 },
            image_url: 'https://quasar.v3rt3p/logo.png',
            scale: 'fit',
            type: 'image',
            width: { type: 'fixed', value: 250 }
          }],
          orientation: 'overlap',
          type: 'container',
          width: { type: 'match_parent' }
        },
        state_id: 0
      }]
    },
    templates: {}
  }

  router.post('/gproxy/get_gallery',
    wrapProto(proto.NAlice.NTv.TGetGalleryRequest, proto.NAlice.NTv.TTvCarouselResultData,
      async () => ({})
    )
  )

  router.post('/gproxy/get_galleries',
    wrapProto(proto.NAlice.NTv.TGetGalleriesRequest, proto.NAlice.NTv.TTvFeedResultData,
      async () => ({
        Carousels: [{
          DivCarousel: {
            DivCardJson: {
              StringBody: JSON.stringify(cardJson)
            },
            ElementsCount: 1,
            Id: 'promoblock',
            Title: 'v3rt3p'
          }
        }],
        TtlInfo: {
          HasTtl: true,
          TtlMillis: 5000
        }
      })
    )
  )

  router.post('/gproxy/get_tv_promo_phrases',
    wrapProto(proto.NAlice.NSmartTv.TGetTvPromoPhrasesRequest, proto.NAlice.NSmartTv.TGetTvPromoPhrasesResponse,
      async () => ({})
    )
  )

  router.post('/gproxy/search',
    wrapProto(proto.NAlice.TTvSearchRequest, proto.NAlice.TTvSearchResultData,
      async () => ({})
    )
  )

  router.post('/gproxy/get_search_suggests',
    wrapProto(proto.NAlice.NTv.TGetSearchSuggestsRequest, proto.NAlice.NTv.TGetSearchSuggestsResponse,
      async () => ({})
    )
  )

  router.post('/gproxy/get_app_store_promo',
    wrapProto(proto.NAlice.NTv.TAppStorePromoRequest, proto.NAlice.NTv.TAppStorePromoResponse,
      async () => ({})
    )
  )

  router.post('/gproxy/get_app_catalog',
    wrapProto(proto.NAlice.NTv.NSmartDeviceExternalApp.TGetAppCatalogRequest,
      proto.NAlice.NTv.NSmartDeviceExternalApp.TGetAppCatalogResponse,
      async () => ({})
    )
  )

  router.post('/gproxy/app_catalog_search',
    wrapProto(proto.NAlice.NTv.NSmartDeviceExternalApp.TAppCatalogSearchRequest,
      proto.NAlice.NTv.NSmartDeviceExternalApp.TAppCatalogSearchResponse,
      async () => ({})
    )
  )

  router.post('/gproxy/get_auth_suggests',
    wrapProto(proto.NAlice.TGetAuthSuggestsRequest, proto.NAlice.TGetAuthSuggestsResponse,
      async () => ({})
    )
  )

  router.post('/gproxy/get_screen_hints_v2',
    wrapProto(proto.NAlice.NTv.TGetScreenHintsV2Request, proto.NAlice.NTv.TGetScreenHintsV2Response,
      async () => ({})
    )
  )

  router.post('/gproxy/get_screensaver_themes',
    wrapProto(proto.NAlice.NTv.TGetScreensaverThemesRequest, proto.NAlice.NTv.TGetScreensaverThemesResponse,
      async (deviceId, platform) => {
        if (!deviceId || !platform) {
          return {}
        }

        const info = await properties.infoProvider.getInfo(deviceId, platform)

        return {
          CurrentTheme: info.quasarConfig.gproxyRpcConfig.screensaver,
          Themes: []
        }
      }
    )
  )

  router.post('/gproxy/save_screensaver_theme',
    wrapProto(proto.NAlice.NTv.TSaveScreensaverThemeRequest, proto.NAlice.NTv.TSaveScreensaverThemeResponse,
      async (deviceId, platform, request) => {
        if (!deviceId || !platform || !request.Id) {
          return {}
        }

        await properties.infoProvider.updateNameAndQuasarConfig(deviceId, undefined, {
          gproxyRpcConfig: {
            screensaver: request.Id
          }
        })

        return {
          Success: {}
        }
      }
    )
  )

  router.post('/gproxy/get_music_category',
    wrapProto(proto.NAlice.NTv.TGetMusicCategoryRequest, proto.NAlice.NTv.TGetMusicCategoryResponse,
      async (_deviceId, _platform, _request) => {
        const [stockPlaylists, stockWaves] = await Promise.all([
          properties.music.getStockPlaylists(),
          properties.music.getStockWaves()
        ])

        return {
          Carousels: [{
            HomeCarousel: {
              Id: 'stock-waves',
              Items: stockWaves.waves.map(wave => ({
                MusicItem: {
                  ContentId: {
                    ContentType: proto.NAlice.NData.NMusic.TContentId.EContentType.Radio,
                    Id: wave.id
                  },
                  ContentType: proto.NAlice.NTv.TMusicItem.EContentType.Wave,
                  Id: wave.id,
                  Thumbnails: toAvatarMdsImage(wave.imageUrl),
                  Title: wave.name
                }
              })),
              Title: 'Волны'
            }
          }, {
            HomeCarousel: {
              Id: 'stock-playlists',
              Items: stockPlaylists.playlists.map(playlist => ({
                MusicItem: {
                  ContentId: {
                    ContentType: proto.NAlice.NData.NMusic.TContentId.EContentType.Playlist,
                    Id: playlist.id
                  },
                  ContentType: proto.NAlice.NTv.TMusicItem.EContentType.Playlist,
                  Id: playlist.id,
                  Thumbnails: toAvatarMdsImage(playlist.imageUrl),
                  Title: playlist.name
                }
              })),
              Title: 'Плейлисты'
            }
          }]
        }
      }
    )
  )

  router.post('/gproxy/get_music_playlist_info',
    wrapProto(proto.NAlice.NMusic.NArpc.TGetMusicPlaylistInfoRequest,
      proto.NAlice.NMusic.NArpc.TGetMusicPlaylistInfoResponse,
      async (_deviceId, _platform, request) => {
        const [playlistInfo, playlistTracks] = await Promise.all([
          properties.music.getPlaylistInfo(request.PlaylistId ?? ''),
          fetchOffsetAsPaged(request.Offset ?? 0, request.Limit ?? 20,
            async (page, perPage) =>
              (await properties.music.getPlaylistTracks(request.PlaylistId ?? '', page, perPage)).tracks)
        ])

        return {
          Header: {
            ArtImage: toAvatarMdsImage(playlistInfo.playlist.imageUrl),
            Title: playlistInfo.playlist.name,
          },
          PlaylistId: playlistInfo.playlist.id,
          Tracks: playlistTracks.map(track => ({
            ArtImage: toAvatarMdsImage(track.imageUrl),
            Artists: track.artists.map(artist => ({
              AvatarImage: toAvatarMdsImage(artist.imageUrl),
              Id: artist.id,
              Name: artist.name
            })),
            DurationMs: track.durationMs,
            Id: track.id,
            IsAvailable: true,
            Title: track.title
          }))
        }
      }
    )
  )

  router.post('/gproxy/get_music_artist_info',
    wrapProto(proto.NAlice.NMusic.NArpc.TGetMusicArtistInfoRequest,
      proto.NAlice.NMusic.NArpc.TGetMusicArtistInfoResponse,
      async (_deviceId, _platform, request) => {
        const [artistInfo, artistTracks, artistsAlbums] = await Promise.all([
          properties.music.getArtistInfo(request.ArtistId ?? ''),
          fetchOffsetAsPaged(0, request.PopularTracksLimit ?? 20,
            async (page, perPage) =>
              (await properties.music.getArtistTracks(request.ArtistId ?? '', page, perPage)).tracks),
          fetchOffsetAsPaged(0, request.PopularAlbumsLimit ?? 20,
            async (page, perPage) =>
              (await properties.music.getArtistAlbums(request.ArtistId ?? '', page, perPage)).albums)
        ])

        return {
          ArtistId: artistInfo.artist.id,
          Header: {
            AvatarImage: toAvatarMdsImage(artistInfo.artist.imageUrl),
            Name: artistInfo.artist.name,
          },
          PopularAlbums: artistsAlbums.map(album => ({
            ArtImage: toAvatarMdsImage(album.imageUrl),
            Artists: album.artists.map(artist => ({
              AvatarImage: toAvatarMdsImage(artist.imageUrl),
              Id: artist.id,
              Name: artist.name
            })),
            Genre: album.genre,
            Id: album.id,
            Title: album.name,
            Type: album.type,
            Year: album.year,
          })),
          PopularTracks: artistTracks.map(track => ({
            ArtImage: toAvatarMdsImage(track.imageUrl),
            Artists: track.artists.map(artist => ({
              AvatarImage: toAvatarMdsImage(artist.imageUrl),
              Id: artist.id,
              Name: artist.name,
            })),
            DurationMs: track.durationMs,
            Id: track.id,
            IsAvailable: true,
            Title: track.title
          }))
        }
      }
    )
  )

  router.post('/gproxy/get_music_album_info',
    wrapProto(proto.NAlice.NMusic.NArpc.TGetMusicAlbumInfoRequest,
      proto.NAlice.NMusic.NArpc.TGetMusicAlbumInfoResponse,
      async (_deviceId, _platform, request) => {
        const [albumInfo, albumTracks] = await Promise.all([
          properties.music.getAlbumInfo(request.AlbumId ?? ''),
          fetchOffsetAsPaged(request.Offset ?? 0, request.Limit ?? 20,
            async (page, perPage) =>
              (await properties.music.getAlbumTracks(request.AlbumId ?? '', page, perPage)).tracks)
        ])

        return {
          AlbumId: albumInfo.album.id,
          Header: {
            ArtImage: toAvatarMdsImage(albumInfo.album.imageUrl),
            Artists: albumInfo.album.artists.map(artist => ({
              AvatarImage: toAvatarMdsImage(artist.imageUrl),
              Id: artist.id,
              Name: artist.name
            })),
            Genre: albumInfo.album.genre,
            ReleaseYear: albumInfo.album.year,
            Title: albumInfo.album.name,
            Type: albumInfo.album.type
          },
          Tracks: albumTracks.map(track => ({
            ArtImage: toAvatarMdsImage(track.imageUrl),
            Artists: track.artists.map(artist => ({
              AvatarImage: toAvatarMdsImage(artist.imageUrl),
              Id: artist.id,
              Name: artist.name,
            })),
            DurationMs: track.durationMs,
            Id: track.id,
            IsAvailable: true,
            Title: track.title
          }))
        }
      }
    ))

  router.post('/gproxy/get_music_artist_popular_tracks',
    wrapProto(proto.NAlice.NMusic.NArpc.TGetMusicArtistPopularTracksRequest,
      proto.NAlice.NMusic.NArpc.TGetMusicArtistPopularTracksResponse,
      async (_deviceId, _platform, request) => {
        const artistTracks = await fetchOffsetAsPaged(request.Offset ?? 0, request.Limit ?? 20,
          async (page, perPage) =>
            (await properties.music.getArtistTracks(request.ArtistId ?? '', page, perPage)).tracks)

        return {
          ArtistId: request.ArtistId,
          PopularTracks: artistTracks.map(track => ({
            ArtImage: toAvatarMdsImage(track.imageUrl),
            Artists: track.artists.map(artist => ({
              AvatarImage: toAvatarMdsImage(artist.imageUrl),
              Id: artist.id,
              Name: artist.name,
            })),
            DurationMs: track.durationMs,
            Id: track.id,
            IsAvailable: true,
            Title: track.title
          }))
        }
      }
    )
  )

  const musicSearchTypeToKindMap: Partial<Record<proto.NAlice.NMusic.TMusicSearchRequest.EMusicSearchType,
    MusicItemType[]>> = {
      [proto.NAlice.NMusic.TMusicSearchRequest.EMusicSearchType.Album]: ['album'],
      [proto.NAlice.NMusic.TMusicSearchRequest.EMusicSearchType.All]: ['album', 'artist', 'playlist', 'track', 'wave'],
      [proto.NAlice.NMusic.TMusicSearchRequest.EMusicSearchType.Artist]: ['artist'],
      [proto.NAlice.NMusic.TMusicSearchRequest.EMusicSearchType.Playlist]: ['playlist'],
      [proto.NAlice.NMusic.TMusicSearchRequest.EMusicSearchType.Track]: ['track'],
    }

  router.post('/gproxy/music_search',
    wrapProto(proto.NAlice.NMusic.TMusicSearchRequest, proto.NAlice.NMusic.TMusicSearchResponse,
      async (_deviceId, _platform, request) => {
        if (request.Offset && request.Offset > 0) {
          return {
            Type: request.Type
          }
        }

        const kinds = musicSearchTypeToKindMap[request.Type ??
          proto.NAlice.NMusic.TMusicSearchRequest.EMusicSearchType.All] ?? []

        if (kinds.length === 0) {
          return {
            Type: request.Type
          }
        }

        const results = await properties.music.searchMusic({
          kinds,
          query: request.Query ?? ''
        })

        const searchResults = [
          ...(results.waves?.map(wave => ({
            _searchPosition: wave.searchPosition,
            Wave: {
              CoverUri: wave.imageUrl,
              Id: wave.id,
              Title: wave.name
            }
          })) ?? []),
          ...(results.tracks?.map(track => ({
            _searchPosition: track.searchPosition,
            Track: {
              Album: track.albums[0]
                ? {
                    Artists: track.albums[0].artists.map(artist => ({
                      CoverUri: artist.imageUrl,
                      Id: artist.id,
                      Name: artist.name
                    })),
                    CoverUri: track.albums[0].imageUrl,
                    Genre: track.albums[0].genre,
                    Id: track.albums[0].id,
                    Title: track.albums[0].name,
                    Type: track.albums[0].type
                  }
                : undefined,
              ArtImageUrl: track.imageUrl,
              Artists: track.artists.map(artist => ({
                CoverUri: artist.imageUrl,
                Id: artist.id,
                Name: artist.name
              })),
              DurationMs: track.durationMs,
              Id: track.id,
              IsAvailable: true,
              Title: track.title
            }
          })) ?? []),
          ...(results.artists?.map(artist => ({
            _searchPosition: artist.searchPosition,
            Artist: {
              CoverUri: artist.imageUrl,
              Id: artist.id,
              Name: artist.name
            }
          })) ?? []),
          ...(results.albums?.map(album => ({
            _searchPosition: album.searchPosition,
            Album: {
              Artists: album.artists.map(artist => ({
                CoverUri: artist.imageUrl,
                Id: artist.id,
                Name: artist.name
              })),
              CoverUri: album.imageUrl,
              Genre: album.genre,
              Id: album.id,
              Title: album.name,
              Type: album.type,
              Year: album.year
            }
          })) ?? []),
          ...(results.playlists?.map(playlist => ({
            _searchPosition: playlist.searchPosition,
            Playlist: {
              CoverUri: playlist.imageUrl,
              Id: playlist.id,
              Title: playlist.name,
              TracksCount: playlist.tracksCount
            }
          })) ?? [])
        ]

        return {
          SearchElements: searchResults.toSorted((a, b) => a._searchPosition - b._searchPosition),
          Type: request.Type
        }
      }
    )
  )

  router.post('/gproxy/get_music_artist_popular_albums',
    wrapProto(proto.NAlice.NMusic.NArpc.TGetMusicArtistPopularAlbumsRequest,
      proto.NAlice.NMusic.NArpc.TGetMusicArtistPopularAlbumsResponse,
      async (_deviceId, _platform, request) => {
        const artistAlbums = await fetchOffsetAsPaged(request.Offset ?? 0, request.Limit ?? 20,
          async (page, perPage) =>
            (await properties.music.getArtistAlbums(request.ArtistId ?? '', page, perPage)).albums)

        return {
          ArtistId: request.ArtistId,
          PopularAlbums: artistAlbums.map(album => ({
            ArtImage: toAvatarMdsImage(album.imageUrl),
            Artists: album.artists.map(artist => ({
              AvatarImage: toAvatarMdsImage(artist.imageUrl),
              Id: artist.id,
              Name: artist.name
            })),
            Genre: album.genre,
            Id: album.id,
            Title: album.name,
            Type: album.type,
            Year: album.year,
          })),
        }
      }))

  app.use('/rpc.alice.yandex.net', router)
}

const logger = getLogger()

async function fetchOffsetAsPaged<T> (
  offset: number,
  limit: number,
  requester: (page: number, perPage: number) => Promise<T[]>,
  maxPerPage = limit
): Promise<T[]> {
  if (limit === 0) {
    return []
  }

  if (maxPerPage < 1) {
    return []
  }

  let bestPerPage = 1
  let bestRequests = Infinity
  let bestFetched = Infinity

  for (let perPage = 1; perPage <= maxPerPage; perPage++) {
    const skip = offset % perPage
    const requests = Math.ceil((skip + limit) / perPage)
    const fetched = requests * perPage

    if (requests < bestRequests ||
      (requests === bestRequests && fetched < bestFetched)) {
      bestPerPage = perPage
      bestRequests = requests
      bestFetched = fetched
    }
  }

  const firstPage = Math.floor(offset / bestPerPage)
  const skip = offset % bestPerPage

  const pages = await Promise.all(
    Array.from({ length: bestRequests }, (_, index) =>
      requester(firstPage + index, bestPerPage)
    )
  )

  return pages.flat().slice(skip, skip + limit)
}

function toAvatarMdsImage (url: string | undefined): proto.NAlice.ITAvatarMdsImage | undefined {
  if (!url) {
    return undefined
  }
  return {
    BaseUrl: `https://quasar.v3rt3p/imageproxy/${Buffer.from(url).toString('base64url')}/`,
    Sizes: ['orig', '400x400']
  }
}

function wrapProto<TRequest, TResponse> (
  requestProto: ProtoEncoderDecoder<TRequest>, responseProto: ProtoEncoderDecoder<TResponse>,
  handler: (deviceId: string | undefined, platform: string | undefined,
    request: TRequest) => Promise<TResponse>): RequestHandler {
  return (request, response) => {
    const raw = request.body
    if (!raw) {
      response.status(400).end()
      return
    }

    const deviceId = toStringOrUndefined(request.headers['x-ya-device-id'])
    const platform = toStringOrUndefined(request.headers['x-ya-platform'])
    handler(deviceId, platform, requestProto.decode(raw))
      .then(responseBody => {
        response.status(200).header({
          'content-type': 'application/x-protobuf'
        }).send(responseProto.encode(responseBody).finish())
      })
      .catch(error => {
        logger.warn(`Failed to handle gproxy: ${error}`)
        response.status(500).end()
      })
  }
}

import type {
  MusicServiceGetAlbumInfoResponse,
  MusicServiceGetAlbumTracksResponse,
  MusicServiceGetArtistAlbumsResponse,
  MusicServiceGetArtistInfoResponse,
  MusicServiceGetArtistTracksResponse,
  MusicServiceGetPlaylistInfoResponse,
  MusicServiceGetPlaylistTracksResponse,
  MusicServiceGetStockPlaylistsResponse,
  MusicServiceGetStockWavesResponse,
  MusicServiceSearchRequest,
  MusicServiceSearchResponse,
  MusicTrackWithUrl
} from '@v3rt3p/types/music'

import {
  musicServiceGetAlbumInfoResponse,
  musicServiceGetAlbumTracksResponse,
  musicServiceGetArtistAlbumsResponse,
  musicServiceGetArtistInfoResponse,
  musicServiceGetArtistTracksResponse,
  musicServiceGetPlaylistInfoResponse,
  musicServiceGetPlaylistTracksResponse,
  musicServiceGetStockPlaylistsResponse,
  musicServiceGetStockWavesResponse,
  musicServiceSearchResponse,
  musicTrackWithUrl
} from '@v3rt3p/types/music'

import { MusicBackend } from '../backend'

export class BasicMusicBackend extends MusicBackend {
  constructor (private readonly baseUrl: string) {
    super()
  }

  async advanceQueueBackward (deviceId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/queue/${encodeURIComponent(deviceId)}/backward`, {
      method: 'POST'
    })

    if (!response.ok) {
      throw new Error(`Music API request failed: ${response.status} ${response.statusText}`)
    }
  }

  async advanceQueueForward (deviceId: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/queue/${encodeURIComponent(deviceId)}/forward`, {
      method: 'POST'
    })

    if (!response.ok) {
      throw new Error(`Music API request failed: ${response.status} ${response.statusText}`)
    }
  }

  async createQueue (queueId: string, itemId: string,
    startFromItemId?: string | undefined, doShuffle?: boolean | undefined): Promise<void> {
    const response = await fetch(`${this.baseUrl}/queue/${encodeURIComponent(queueId)}/create`, {
      body: JSON.stringify({
        doShuffle,
        itemId,
        queueId,
        startFromItemId
      }),
      headers: {
        'Content-Type': 'application/json'
      },
      method: 'POST'
    })

    if (!response.ok) {
      throw new Error(`Music API request failed: ${response.status} ${response.statusText}`)
    }
  }

  async getAlbumInfo (
    albumId: string
  ): Promise<MusicServiceGetAlbumInfoResponse> {
    return this.request(
      `/music/album/${encodeURIComponent(albumId)}`,
      musicServiceGetAlbumInfoResponse
    )
  }

  async getAlbumTracks (
    albumId: string,
    page?: number,
    perPage?: number
  ): Promise<MusicServiceGetAlbumTracksResponse> {
    return this.request(
      `/music/album/${encodeURIComponent(albumId)}/tracks${this.paginationQuery(page, perPage)}`,
      musicServiceGetAlbumTracksResponse
    )
  }

  async getArtistAlbums (
    artistId: string,
    page?: number,
    perPage?: number
  ): Promise<MusicServiceGetArtistAlbumsResponse> {
    return this.request(
      `/music/artist/${encodeURIComponent(artistId)}/albums${this.paginationQuery(page, perPage)}`,
      musicServiceGetArtistAlbumsResponse
    )
  }

  async getArtistInfo (
    artistId: string
  ): Promise<MusicServiceGetArtistInfoResponse> {
    return this.request(
      `/music/artist/${encodeURIComponent(artistId)}`,
      musicServiceGetArtistInfoResponse
    )
  }

  async getArtistTracks (
    artistId: string,
    page?: number,
    perPage?: number
  ): Promise<MusicServiceGetArtistTracksResponse> {
    return this.request(
      `/music/artist/${encodeURIComponent(artistId)}/tracks${this.paginationQuery(page, perPage)}`,
      musicServiceGetArtistTracksResponse
    )
  }

  async getCurrentTrack (deviceId: string): Promise<MusicTrackWithUrl | null> {
    const response = await fetch(`${this.baseUrl}/queue/${encodeURIComponent(deviceId)}/current`, {
      method: 'GET'
    })

    if (response.status === 404) {
      return null
    }

    if (!response.ok) {
      throw new Error(`Music API request failed: ${response.status} ${response.statusText}`)
    }

    return musicTrackWithUrl.parse(await response.json())
  }

  async getNextTrack (deviceId: string): Promise<MusicTrackWithUrl | null> {
    const response = await fetch(`${this.baseUrl}/queue/${encodeURIComponent(deviceId)}/next`, {
      method: 'GET'
    })

    if (response.status === 404) {
      return null
    }

    if (!response.ok) {
      throw new Error(`Music API request failed: ${response.status} ${response.statusText}`)
    }

    return musicTrackWithUrl.parse(await response.json())
  }

  async getPlaylistInfo (
    playlistId: string
  ): Promise<MusicServiceGetPlaylistInfoResponse> {
    return this.request(
      `/music/playlist/${encodeURIComponent(playlistId)}`,
      musicServiceGetPlaylistInfoResponse
    )
  }

  async getPlaylistTracks (
    playlistId: string,
    page?: number,
    perPage?: number
  ): Promise<MusicServiceGetPlaylistTracksResponse> {
    return this.request(
      `/music/playlist/${encodeURIComponent(playlistId)}/tracks${this.paginationQuery(page, perPage)}`,
      musicServiceGetPlaylistTracksResponse
    )
  }

  async getStockPlaylists (): Promise<MusicServiceGetStockPlaylistsResponse> {
    return this.request(
      '/music/stock/playlists',
      musicServiceGetStockPlaylistsResponse
    )
  }

  async getStockWaves (): Promise<MusicServiceGetStockWavesResponse> {
    return this.request(
      '/music/stock/waves',
      musicServiceGetStockWavesResponse
    )
  }

  async searchMusic (
    request: MusicServiceSearchRequest
  ): Promise<MusicServiceSearchResponse> {
    return this.request(
      '/music/search',
      musicServiceSearchResponse,
      {
        body: JSON.stringify(request),
        headers: {
          'Content-Type': 'application/json'
        },
        method: 'POST'
      }
    )
  }

  private paginationQuery (page?: number, perPage?: number): string {
    const parameters = new URLSearchParams()

    if (page !== undefined) {
      parameters.set('page', String(page))
    }

    if (perPage !== undefined) {
      parameters.set('perPage', String(perPage))
    }

    const query = parameters.toString()

    return query ? `?${query}` : ''
  }

  private async request<T> (
    path: string,
    schema: { parse: (data: unknown) => T },
    init?: RequestInit
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, init)

    if (!response.ok) {
      throw new Error(`Music API request failed: ${response.status} ${response.statusText}`)
    }

    return schema.parse(await response.json())
  }
}

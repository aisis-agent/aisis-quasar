import { MusicServiceGetAlbumInfoResponse, MusicServiceGetAlbumTracksResponse, MusicServiceGetArtistAlbumsResponse, MusicServiceGetArtistInfoResponse, MusicServiceGetArtistTracksResponse, MusicServiceGetPlaylistInfoResponse, MusicServiceGetPlaylistTracksResponse, MusicServiceGetStockPlaylistsResponse, MusicServiceGetStockWavesResponse, MusicServiceSearchResponse, MusicTrackWithUrl } from '@v3rt3p/types/music'

import { MusicBackend } from '../backend'

export class StubMusicBackend extends MusicBackend {
  async advanceQueueBackward (): Promise<void> {}
  async advanceQueueForward (): Promise<void> {}

  async createQueue (): Promise<void> {}

  async getAlbumInfo (): Promise<MusicServiceGetAlbumInfoResponse> {
    return {
      album: {
        artists: [],
        genre: 'Invalid',
        id: 'invalid-album',
        name: 'Invalid',
        type: 'Invalid',
        year: 0
      }
    }
  }

  async getAlbumTracks (): Promise<MusicServiceGetAlbumTracksResponse> {
    return {
      total: 0,
      tracks: []
    }
  }

  async getArtistAlbums (): Promise<MusicServiceGetArtistAlbumsResponse> {
    return {
      albums: [],
      total: 0
    }
  }

  async getArtistInfo (): Promise<MusicServiceGetArtistInfoResponse> {
    return {
      artist: {
        id: 'invalid-artist',
        name: 'Invalid'
      }
    }
  }

  async getArtistTracks (): Promise<MusicServiceGetArtistTracksResponse> {
    return {
      total: 0,
      tracks: []
    }
  }

  async getCurrentTrack (): Promise<MusicTrackWithUrl | null> {
    return null
  }

  async getNextTrack (): Promise<MusicTrackWithUrl | null> {
    return null
  }

  async getPlaylistInfo (): Promise<MusicServiceGetPlaylistInfoResponse> {
    return {
      playlist: {
        id: 'invalid-playlist',
        name: 'Invalid',
        tracksCount: 0
      }
    }
  }

  async getPlaylistTracks (): Promise<MusicServiceGetPlaylistTracksResponse> {
    return {
      total: 0,
      tracks: []
    }
  }

  async getStockPlaylists (): Promise<MusicServiceGetStockPlaylistsResponse> {
    return {
      playlists: []
    }
  }

  async getStockWaves (): Promise<MusicServiceGetStockWavesResponse> {
    return {
      waves: []
    }
  }

  async searchMusic (): Promise<MusicServiceSearchResponse> {
    return {}
  }
}

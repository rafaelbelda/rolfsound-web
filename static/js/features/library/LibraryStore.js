import { getSearchText, withDisplayArtist } from '/static/js/utils/trackMeta.js';

const DEFAULT_LAYOUT = {
  version: 1,
  blocks: [
    { id: 'albums-main', type: 'albums', view: 'grid', title: 'Albums', size: 'wide', enabled: true, config: { sort: 'recent', limit: 12 } },
    { id: 'tracks-main', type: 'tracks', view: 'list', title: 'Tracks', size: 'wide', enabled: true, config: { sort: 'recent', limit: 40 } },
    { id: 'artists-main', type: 'artists', view: 'circles', title: 'Artists', size: 'wide', enabled: true, config: { sort: 'name', limit: 18 } },
    { id: 'playlists-main', type: 'playlists', view: 'grid', title: 'Playlists', size: 'wide', enabled: true, config: { sort: 'recent', limit: 12 } },
  ],
};

const LAYOUT_BLOCK_TYPES = new Set(['albums', 'tracks', 'artists', 'playlists']);

function normalizeBlock(block, index = 0) {
  const type = String(block?.type || 'tracks').trim() || 'tracks';
  const id = String(block?.id || `${type}-${Date.now()}-${index}`).trim();
  const titles = {
    albums: 'Albums',
    tracks: 'Tracks',
    artists: 'Artists',
    playlists: 'Playlists',
  };
  const size = ['compact', 'medium', 'wide'].includes(block?.size) ? block.size : 'wide';
  return {
    id,
    type,
    view: String(block?.view || defaultViewForType(type)),
    title: String(block?.title || titles[type] || type),
    size,
    enabled: block?.enabled !== false,
    config: { ...(block?.config || {}) },
  };
}

function defaultViewForType(type) {
  if (type === 'tracks') return 'list';
  if (type === 'artists') return 'circles';
  return 'grid';
}

function normalizeLayout(layout) {
  const source = layout && Array.isArray(layout.blocks) ? layout : DEFAULT_LAYOUT;
  return {
    version: 1,
    blocks: source.blocks
      .map(normalizeBlock)
      .filter((block) => LAYOUT_BLOCK_TYPES.has(block.type)),
  };
}

function asArray(payload, key) {
  return Array.isArray(payload?.[key]) ? payload[key] : [];
}

function matchQuery(value, query) {
  if (!query) return true;
  return String(value || '').toLowerCase().includes(query);
}

function byText(field) {
  return (a, b) => String(a?.[field] || '').localeCompare(String(b?.[field] || ''), undefined, { sensitivity: 'base' });
}

function byNumberDesc(field) {
  return (a, b) => Number(b?.[field] || 0) - Number(a?.[field] || 0);
}

export default class LibraryStore extends EventTarget {
  constructor() {
    super();
    this.state = {
      tracks: [],
      artists: [],
      albums: [],
      playlists: [],
      layout: normalizeLayout(DEFAULT_LAYOUT),
      query: '',
      loading: false,
      error: '',
    };
  }

  async load() {
    this._setState({ loading: true, error: '' });
    try {
      const [library, artists, albums, playlists, layout] = await Promise.all([
        this._fetchJson('/api/library'),
        this._fetchJson('/api/artists'),
        this._fetchJson('/api/albums'),
        this._fetchJson('/api/playlists'),
        this._fetchJson('/api/ui/library-layout'),
      ]);

      this._setState({
        tracks: asArray(library, 'tracks').map(withDisplayArtist),
        artists: asArray(artists, 'artists'),
        albums: asArray(albums, 'albums'),
        playlists: asArray(playlists, 'playlists'),
        layout: normalizeLayout(layout),
        loading: false,
        error: '',
      });
    } catch (error) {
      console.error('Library load failed:', error);
      this._setState({ loading: false, error: 'Library failed to load' });
    }
  }

  setQuery(query) {
    this._setState({ query: String(query || '').trim().toLowerCase() });
  }

  findTrack(trackId) {
    return this.state.tracks.find((track) => this.trackId(track) === trackId) || null;
  }

  trackId(track) {
    return track?.id || track?.track_id || '';
  }

  async saveLayout(layout) {
    const normalized = normalizeLayout(layout);
    this._setState({ layout: normalized });
    const response = await fetch('/api/ui/library-layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(normalized),
    });
    if (!response.ok) throw new Error(`Layout save failed (${response.status})`);
    const saved = await response.json();
    this._setState({ layout: normalizeLayout(saved) });
  }

  async resetLayout() {
    const response = await fetch('/api/ui/library-layout', { method: 'DELETE' });
    if (!response.ok) throw new Error(`Layout reset failed (${response.status})`);
    const layout = await response.json();
    this._setState({ layout: normalizeLayout(layout) });
  }

  updateTrack(updatedTrack) {
    const track = withDisplayArtist(updatedTrack);
    const trackId = this.trackId(track);
    if (!trackId) return;
    const tracks = [...this.state.tracks];
    const index = tracks.findIndex((item) => this.trackId(item) === trackId);
    if (index >= 0) tracks[index] = track;
    else tracks.push(track);
    this._setState({ tracks });
  }

  removeTrack(trackId) {
    this._setState({
      tracks: this.state.tracks.filter((track) => this.trackId(track) !== trackId),
    });
  }

  selectTracks(config = {}) {
    const query = this.state.query;
    const limit = Number(config.limit || 0);
    let rows = this.state.tracks.filter((track) => matchQuery(getSearchText(track), query));
    rows = this._sortTracks(rows, config.sort || 'recent');
    return limit > 0 ? rows.slice(0, limit) : rows;
  }

  selectArtists(config = {}) {
    const query = this.state.query;
    const limit = Number(config.limit || 0);
    let rows = this.state.artists.filter((artist) => matchQuery(artist.name, query));
    rows = [...rows].sort(config.sort === 'tracks' ? byNumberDesc('track_count') : byText('name'));
    return limit > 0 ? rows.slice(0, limit) : rows;
  }

  selectAlbums(config = {}) {
    const query = this.state.query;
    const limit = Number(config.limit || 0);
    let rows = this.state.albums.filter((album) => {
      return matchQuery(`${album.title || ''} ${album.display_artist || ''} ${album.year || ''}`, query);
    });
    rows = this._sortAlbums(rows, config.sort || 'recent');
    return limit > 0 ? rows.slice(0, limit) : rows;
  }

  selectPlaylists(config = {}) {
    const query = this.state.query;
    const limit = Number(config.limit || 0);
    let rows = this.state.playlists.filter((playlist) => matchQuery(playlist.name, query));
    rows = [...rows].sort(config.sort === 'name' ? byText('name') : byNumberDesc('created_at'));
    return limit > 0 ? rows.slice(0, limit) : rows;
  }

  async getArtistDetail(artistId) {
    const [tracks, albums] = await Promise.all([
      this._fetchJson(`/api/artists/${encodeURIComponent(artistId)}/tracks`),
      this._fetchJson(`/api/artists/${encodeURIComponent(artistId)}/albums`),
    ]);
    return {
      tracks: asArray(tracks, 'tracks').map(withDisplayArtist),
      albums: asArray(albums, 'albums'),
    };
  }

  async getAlbumTracks(albumId) {
    const payload = await this._fetchJson(`/api/albums/${encodeURIComponent(albumId)}/tracks`);
    return {
      album: payload?.album || null,
      tracks: asArray(payload, 'tracks').map(withDisplayArtist),
    };
  }

  async getPlaylistTracks(playlistId) {
    const payload = await this._fetchJson(`/api/playlists/${encodeURIComponent(playlistId)}/tracks`);
    return asArray(payload, 'tracks').map(withDisplayArtist);
  }

  async _fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`${url} failed (${response.status})`);
    return response.json();
  }

  _sortTracks(rows, sort) {
    const sorted = [...rows];
    if (sort === 'title') return sorted.sort(byText('title'));
    if (sort === 'artist') {
      return sorted.sort((a, b) => String(a.display_artist || '').localeCompare(String(b.display_artist || ''), undefined, { sensitivity: 'base' }));
    }
    if (sort === 'streams') return sorted.sort(byNumberDesc('streams'));
    return sorted.sort(byNumberDesc('date_added'));
  }

  _sortAlbums(rows, sort) {
    const sorted = [...rows];
    if (sort === 'title') return sorted.sort(byText('title'));
    if (sort === 'artist') return sorted.sort(byText('display_artist'));
    if (sort === 'year') return sorted.sort((a, b) => Number(a?.year || 99999) - Number(b?.year || 99999));
    return sorted.sort((a, b) => Number(b?.year || 0) - Number(a?.year || 0) || byText('title')(a, b));
  }

  _setState(patch) {
    this.state = { ...this.state, ...patch };
    this.dispatchEvent(new CustomEvent('change', { detail: this.state }));
  }
}

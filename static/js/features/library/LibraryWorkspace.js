import { initVersionPanel } from '/static/js/components/version-panel/version-panel.js';
import { getAlbumTitle, getDisplayArtist } from '/static/js/utils/trackMeta.js';
import GeometryMorphAnimator from '/static/js/features/animations/GeometryMorphAnimator.js';
import OverlayBackdropController from '/static/js/features/overlays/OverlayBackdropController.js';
import LibraryStore from '/static/js/features/library/LibraryStore.js';

const BLOCK_TYPES = {
  albums: { title: 'Albums', view: 'grid', size: 'wide', config: { sort: 'recent', limit: 12 } },
  tracks: { title: 'Tracks', view: 'list', size: 'wide', config: { sort: 'recent', limit: 40 } },
  artists: { title: 'Artists', view: 'circles', size: 'wide', config: { sort: 'name', limit: 18 } },
  playlists: { title: 'Playlists', view: 'grid', size: 'wide', config: { sort: 'recent', limit: 12 } },
};

const SIZE_ORDER = ['compact', 'medium', 'wide'];

function icon(path, size = 13) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

const ICONS = {
  plus: icon('<path d="M12 5v14"/><path d="M5 12h14"/>'),
  up: icon('<path d="m18 15-6-6-6 6"/>'),
  down: icon('<path d="m6 9 6 6 6-6"/>'),
  size: icon('<path d="M4 14h6v6H4z"/><path d="M14 4h6v16h-6z"/>'),
  config: icon('<circle cx="12" cy="12" r="3"/><path d="M12 3v2"/><path d="M12 19v2"/><path d="m4.22 4.22 1.42 1.42"/><path d="m18.36 18.36 1.42 1.42"/><path d="M3 12h2"/><path d="M19 12h2"/><path d="m4.22 19.78 1.42-1.42"/><path d="m18.36 5.64 1.42-1.42"/>'),
  close: icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  play: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>`,
  queue: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 6h11v2H4V6Zm0 5h11v2H4v-2Zm0 5h7v2H4v-2Zm14-5V8h2v3h3v2h-3v3h-2v-3h-3v-2h3Z"/></svg>`,
  versions: icon('<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="m3 13 9 5 9-5"/>'),
  edit: icon('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
};

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}

function escapeSelectorValue(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (!total) return '';
  const mins = Math.floor(total / 60);
  const secs = String(total % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

function plural(count, label) {
  return `${count} ${label}${count === 1 ? '' : 's'}`;
}

function thumbSrc(thumbnail) {
  if (!thumbnail) return null;
  const value = String(thumbnail);
  if (value.startsWith('http') || value.startsWith('/thumbs/') || value.startsWith('/static/')) return value;
  const path = value.replace(/\\/g, '/');
  if (path.startsWith('music/')) return `/${path.replace('music/', 'thumbs/')}`;
  if (path.startsWith('./music/')) return path.replace('./music/', '/thumbs/');
  return `/thumbs/${path.split('/').pop()}`;
}

function getTrackId(track) {
  return track?.id || track?.track_id || '';
}

function getAssets(track) {
  return Array.isArray(track?.assets) ? track.assets : [];
}

function normalizeAssetType(value) {
  return String(value || 'ORIGINAL_MIX').trim().toUpperCase().replace(/[-\s]+/g, '_') || 'ORIGINAL_MIX';
}

function getFileFormat(asset) {
  return String(asset?.file_format || asset?.format || '').trim().toUpperCase();
}

function getFastAssetId(track) {
  if (track?.preferred_asset_id) return track.preferred_asset_id;
  if (track?.asset_id) return track.asset_id;
  const assets = getAssets(track);
  return assets.find((asset) => Number(asset.is_primary) === 1)?.id || assets[0]?.id || '';
}

function getFastAsset(track) {
  const fastId = getFastAssetId(track);
  return getAssets(track).find((asset) => asset.id === fastId) || null;
}

function assetDisplay(asset) {
  const type = normalizeAssetType(asset?.asset_type);
  const format = getFileFormat(asset);
  const label = format === 'FLAC' ? 'FLAC' : type.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const source = String(asset?.source || '').trim();
  const detail = [format && format !== label ? format : '', source, asset?.file_path || ''].filter(Boolean).join(' - ');
  return { label, detail };
}

class RolfsoundLibraryWorkspace extends HTMLElement {
  constructor() {
    super();
    this.store = new LibraryStore();
    this._isRendered = false;
    this._isAddMenuOpen = false;
    this._detailModal = null;
    this._identityModal = null;
    this._detailMorph = new GeometryMorphAnimator();
    this._detailHiddenOrigins = new Set();
    this._detailCache = new Map();
    this._playlistPanel = null;
    this._pickerTrackId = '';

    this._onStoreChange = () => this.render();
    this._onClick = this._handleClick.bind(this);
    this._onKeydown = this._handleKeydown.bind(this);
    this._onSearch = this._handleSearch.bind(this);
    this._onContextBuild = this._handleContextBuild.bind(this);
  }

  connectedCallback() {
    if (this._connected) return;
    this._connected = true;
    this.classList.add('library-workspace-host');
    this.store.addEventListener('change', this._onStoreChange);
    this.addEventListener('click', this._onClick);
    window.addEventListener('rolfsound-search', this._onSearch);
    window.addEventListener('rolfsound-search-results', this._onSearch);
    window.addEventListener('rolfsound-search-close', this._onSearch);
    window.addEventListener('rolfsound-library-mode-change', (event) => {
      if (event.detail?.mode === 'digital') this.store.load();
      else this._closePlaylistPanel();
    });
    window.addEventListener('rolfsound-library-updated', () => this.store.load());
    window.addEventListener('rolfsound-context-build', this._onContextBuild);
    window.addEventListener('rolfsound-playlist-picker-request', (event) => this._openPlaylistPicker(event.detail?.trackId || ''));
    window.addEventListener('rolfsound-playlist-deleted', () => this.store.load());
    window.addEventListener('rolfsound-playlist-created', () => this.store.load());
    window.addEventListener('rolfsound-playlist-renamed', (event) => this._renamePlaylist(event.detail || {}));
    window.addEventListener('rolfsound-playlist-play', (event) => this._playPlaylist(Number(event.detail?.playlistId || 0)));
    document.addEventListener('keydown', this._onKeydown);

    this._versionPanel = initVersionPanel({
      thumbSrc,
      escapeHtml,
      getTrackId,
      getAssets,
      getFastAssetId,
      getFastAsset,
      normalizeAssetType,
      getFileFormat,
      assetDisplay,
      notify: (text, spinner = false, duration = 2200) => this._notify(text, spinner, duration),
      updateTrackCache: (track) => this.store.updateTrack(track),
      renderLibrary: () => this.render(),
      getCurrentSearchQuery: () => this._currentSearchQuery(),
      findTrackById: (trackId) => this.store.findTrack(trackId),
      playTrack: (track, assetId) => this._playTrack(track, assetId),
      queueTrack: (track, assetId) => this._queueTrack(track, assetId),
      editIdentity: (track, anchorEl) => this._openIdentityEditor(track, anchorEl),
    });

    this._renderShell();
    this.store.load();
  }

  disconnectedCallback() {
    this.store.removeEventListener('change', this._onStoreChange);
    this.removeEventListener('click', this._onClick);
    window.removeEventListener('rolfsound-search', this._onSearch);
    window.removeEventListener('rolfsound-search-results', this._onSearch);
    window.removeEventListener('rolfsound-search-close', this._onSearch);
    window.removeEventListener('rolfsound-context-build', this._onContextBuild);
    document.removeEventListener('keydown', this._onKeydown);
    this._closeDetailModal({ instant: true });
    this._closeIdentityEditor();
  }

  _renderShell() {
    this.innerHTML = `
      <div class="library-workspace">
        <header class="library-page-header">
          <div>
            <h1>My Library</h1>
            <p class="library-stats" data-role="stats">Loading library...</p>
          </div>
          <div class="library-actions">
            <button class="library-toolbar-btn hover-target" type="button" data-action="reset-layout" title="Reset layout" aria-label="Reset layout">Reset</button>
            <div class="library-add-wrap">
              <button class="library-toolbar-btn library-add-btn hover-target" type="button" data-action="toggle-add" aria-expanded="false">
                ${ICONS.plus}<span>Add block</span>
              </button>
              <div class="library-add-menu" data-role="add-menu" aria-hidden="true">
                <button type="button" data-add-type="albums">Albums grid</button>
                <button type="button" data-add-type="tracks">Tracks list</button>
                <button type="button" data-add-type="artists">Artists circles</button>
                <button type="button" data-add-type="playlists">Playlists grid</button>
              </div>
            </div>
          </div>
        </header>
        <div class="library-grid" data-role="grid"></div>
        <div class="library-empty" data-role="empty" hidden>
          <strong>No blocks</strong>
          <span>Add a block to start shaping this library.</span>
        </div>
        ${this._renderPlaylistPicker()}
      </div>
    `;
    this._isRendered = true;
  }

  render() {
    if (!this._isRendered) return;
    const state = this.store.state;
    const stats = this.querySelector('[data-role="stats"]');
    const grid = this.querySelector('[data-role="grid"]');
    const empty = this.querySelector('[data-role="empty"]');
    if (!grid) return;

    if (stats) {
      stats.textContent = [
        plural(state.albums.length, 'album'),
        plural(state.tracks.length, 'track'),
        plural(state.artists.length, 'artist'),
        plural(state.playlists.length, 'playlist'),
      ].join(' - ');
    }

    const blocks = state.layout.blocks.filter((block) => block.enabled !== false);
    if (!blocks.length) {
      grid.innerHTML = '';
      if (empty) empty.hidden = false;
      this._syncDetailOriginVisibility();
      return;
    }

    if (empty) empty.hidden = true;
    grid.innerHTML = blocks.map((block, index) => this._renderBlock(block, index, blocks.length)).join('');
    this._syncDetailOriginVisibility();
    this._refreshDetailModal();
  }

  _renderBlock(block, index, total) {
    const content = this._renderBlockContent(block);
    return `
      <section class="library-block library-block--${escapeHtml(block.size)} library-block--${escapeHtml(block.type)}"
               data-block-id="${escapeHtml(block.id)}"
               data-block-type="${escapeHtml(block.type)}">
        <header class="library-block-header">
          <div class="library-block-title-wrap">
            <h2>${escapeHtml(block.title)}</h2>
          </div>
          <div class="library-block-controls">
            <button class="library-icon-btn hover-target" type="button" data-block-action="move-up" title="Move up" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>${ICONS.up}</button>
            <button class="library-icon-btn hover-target" type="button" data-block-action="move-down" title="Move down" aria-label="Move down" ${index === total - 1 ? 'disabled' : ''}>${ICONS.down}</button>
            <button class="library-icon-btn hover-target" type="button" data-block-action="size" title="Change size" aria-label="Change size">${ICONS.size}</button>
            <button class="library-icon-btn hover-target" type="button" data-block-action="configure" title="Configure" aria-label="Configure">${ICONS.config}</button>
            <button class="library-icon-btn hover-target" type="button" data-block-action="remove" title="Remove" aria-label="Remove">${ICONS.close}</button>
          </div>
        </header>
        <div class="library-block-body">${content}</div>
      </section>
    `;
  }

  _renderBlockContent(block) {
    if (this.store.state.loading) return '<div class="library-loading">Loading...</div>';
    if (this.store.state.error) return `<div class="library-loading">${escapeHtml(this.store.state.error)}</div>`;

    if (block.type === 'albums') return this._renderAlbums(block);
    if (block.type === 'tracks') return this._renderTracks(this.store.selectTracks(block.config), { dense: true });
    if (block.type === 'artists') return this._renderArtists(block);
    if (block.type === 'playlists') return this._renderPlaylists(block);
    return '<div class="library-loading">Unsupported block</div>';
  }

  _renderAlbums(block) {
    const albums = this.store.selectAlbums(block.config);
    if (!albums.length) return this._emptyBlock('No albums found');
    return `<div class="library-card-grid albums-grid">${albums.map((album) => this._renderAlbumCard(album)).join('')}</div>`;
  }

  _renderAlbumCard(album) {
    const cover = thumbSrc(album.cover);
    const title = album.title || 'Untitled album';
    const meta = [album.display_artist || '', album.year || '', plural(Number(album.local_track_count || 0), 'track')].filter(Boolean).join(' - ');
    return `
      <button class="album-card hover-target" type="button" data-album-id="${escapeHtml(album.id || '')}" title="${escapeHtml(title)}">
        <span class="album-cover">
          ${cover ? `<img src="${escapeHtml(cover)}" alt="" loading="lazy" onerror="this.remove()">` : '<span>Album</span>'}
        </span>
        <span class="album-title">${escapeHtml(title)}</span>
        <span class="album-meta">${escapeHtml(meta)}</span>
      </button>
    `;
  }

  _renderArtists(block) {
    const artists = this.store.selectArtists(block.config);
    if (!artists.length) return this._emptyBlock('No artists found');
    return `<div class="artist-circle-strip">${artists.map((artist, index) => this._renderArtistCard(artist, index)).join('')}</div>`;
  }

  _renderArtistCard(artist, index) {
    const name = artist.name || 'Unknown Artist';
    return `
      <button class="artist-card hover-target" type="button" data-artist-id="${escapeHtml(artist.id || '')}" style="--artist-hue:${(index * 37) % 360}">
        <span class="artist-avatar">${escapeHtml(name.slice(0, 1).toUpperCase())}</span>
        <span class="artist-name">${escapeHtml(name)}</span>
        <span class="artist-meta">${plural(Number(artist.track_count || 0), 'track')}</span>
      </button>
    `;
  }

  _renderPlaylists(block) {
    const playlists = this.store.selectPlaylists(block.config);
    if (!playlists.length) return this._emptyBlock('No playlists yet');
    return `<div class="library-card-grid playlists-grid">${playlists.map((playlist) => this._renderPlaylistCard(playlist)).join('')}</div>`;
  }

  _renderPlaylistCard(playlist) {
    const count = Number(playlist.track_count || 0);
    return `
      <button class="playlist-card hover-target" type="button" data-playlist-id="${Number(playlist.id || 0)}">
        <span class="playlist-art">
          <span></span><span></span><span></span><span></span>
        </span>
        <span class="playlist-title">${escapeHtml(playlist.name || 'Playlist')}</span>
        <span class="playlist-meta">${plural(count, 'track')}</span>
      </button>
    `;
  }

  _renderTracks(tracks, { dense = false, removablePlaylistId = null } = {}) {
    if (!tracks.length) return this._emptyBlock('No tracks found');
    return `
      <div class="library-track-list ${dense ? 'is-dense' : ''}">
        ${tracks.map((track, index) => this._renderTrackRow(track, index, removablePlaylistId)).join('')}
      </div>
    `;
  }

  _renderTrackRow(track, index, removablePlaylistId = null) {
    const trackId = getTrackId(track);
    const img = thumbSrc(track.thumbnail);
    const artist = getDisplayArtist(track) || 'Unknown Artist';
    const album = getAlbumTitle(track);
    const duration = formatDuration(track.duration);
    const chips = [
      track.asset_type ? normalizeAssetType(track.asset_type).replace(/_/g, ' ') : '',
      track.bpm ? `${track.bpm} BPM` : '',
    ].filter(Boolean);

    return `
      <article class="track-card library-track-row hover-target"
               data-track-id="${escapeHtml(trackId)}"
               ${removablePlaylistId ? `data-playlist-id="${escapeHtml(removablePlaylistId)}"` : ''}>
        <span class="track-index">${String(index + 1).padStart(2, '0')}</span>
        <span class="track-thumb">${img ? `<img src="${escapeHtml(img)}" alt="" loading="lazy" onerror="this.remove()">` : 'Audio'}</span>
        <span class="track-main">
          <strong>${escapeHtml(track.title || 'Unknown')}</strong>
          <span>${escapeHtml(artist)}</span>
        </span>
        <span class="track-album">${escapeHtml(album)}</span>
        <span class="track-chips">${chips.map((chip) => `<em>${escapeHtml(chip)}</em>`).join('')}</span>
        <span class="track-duration">${escapeHtml(duration)}</span>
        <span class="track-row-actions">
          <button class="track-row-btn hover-target" type="button" data-track-action="play" title="Play" aria-label="Play">${ICONS.play}</button>
          <button class="track-row-btn hover-target" type="button" data-track-action="queue" title="Add to queue" aria-label="Add to queue">${ICONS.queue}</button>
          <button class="track-row-btn hover-target" type="button" data-track-action="versions" title="Versions" aria-label="Versions">${ICONS.versions}</button>
          ${removablePlaylistId ? `<button class="track-row-btn hover-target" type="button" data-track-action="remove-playlist-track" title="Remove from playlist" aria-label="Remove from playlist">${ICONS.close}</button>` : ''}
        </span>
      </article>
    `;
  }

  _renderDetailModalContent(type, id) {
    if (type === 'artist') return this._renderArtistDetailContent(id);
    if (type === 'album') return this._renderAlbumDetailContent(id);
    return '';
  }

  _renderArtistDetailContent(artistId) {
    const artist = this.store.state.artists.find((item) => item.id === artistId) || { name: 'Artist' };
    const artistIndex = Math.max(0, this.store.state.artists.findIndex((item) => item.id === artistId));
    const cached = this._detailCache.get(`artist:${artistId}`);
    if (!cached) {
      this._loadArtistDetail(artistId);
    }
    const tracks = cached?.tracks || [];
    const albums = cached?.albums || [];
    const subtitle = cached
      ? [plural(tracks.length, 'track'), plural(albums.length, 'album')].join(' - ')
      : 'Loading artist...';
    const albumsHtml = albums.length
      ? `<section class="library-detail-section">
          <h3>Albums</h3>
          <div class="library-card-grid detail-albums">${albums.map((album) => this._renderAlbumCard(album)).join('')}</div>
        </section>`
      : '';

    const name = artist.name || 'Artist';

    return `
      <div class="library-detail-modal-content library-detail-modal-content--artist">
        ${this._renderDetailHeader(name, subtitle, {
          avatarText: name.slice(0, 1).toUpperCase(),
          hue: (artistIndex * 37) % 360,
        })}
        <div class="library-detail-content">
          ${cached ? albumsHtml : '<div class="library-loading">Loading artist...</div>'}
          ${cached ? `<section class="library-detail-section"><h3>Tracks</h3>${this._renderTracks(tracks, { dense: true })}</section>` : ''}
        </div>
      </div>
    `;
  }

  _renderAlbumDetailContent(albumId) {
    const album = this.store.state.albums.find((item) => item.id === albumId) || {};
    const cached = this._detailCache.get(`album:${albumId}`);
    if (!cached) {
      this._loadAlbumTracks(albumId);
    }
    const activeAlbum = cached?.album || album;
    const tracks = cached?.tracks || [];
    const title = activeAlbum.title || 'Album';
    const subtitle = cached
      ? [activeAlbum.display_artist || '', activeAlbum.year || '', plural(tracks.length, 'track')].filter(Boolean).join(' - ')
      : 'Loading album...';
    const cover = thumbSrc(activeAlbum.cover);

    return `
      <div class="library-detail-modal-content library-detail-modal-content--album">
        ${this._renderDetailHeader(title, subtitle, { cover })}
        <div class="library-detail-content">
          ${cached ? `<section class="library-detail-section"><h3>Tracks</h3>${this._renderTracks(tracks, { dense: true })}</section>` : '<div class="library-loading">Loading album...</div>'}
        </div>
      </div>
    `;
  }

  _renderDetailHeader(title, subtitle, options = {}) {
    const { cover = null, avatarText = '', hue = 0 } = options;
    const art = cover
      ? `<span class="library-detail-cover"><img src="${escapeHtml(cover)}" alt="" loading="lazy" onerror="this.remove()"></span>`
      : avatarText
        ? `<span class="library-detail-cover library-detail-cover--artist" style="--artist-hue:${Number(hue) || 0}">${escapeHtml(avatarText)}</span>`
        : '';
    return `
      <header class="library-detail-header">
        ${art}
        <div class="library-detail-heading">
          <h2>${escapeHtml(title)}</h2>
          ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
        </div>
        <button class="library-icon-btn library-detail-close hover-target" type="button" data-detail-close aria-label="Close">${ICONS.close}</button>
      </header>
    `;
  }

  _emptyBlock(text) {
    return `<div class="library-block-empty">${escapeHtml(text)}</div>`;
  }

  async _handleClick(event) {
    if (event.target.closest('[data-picker-close]')) {
      this._closePlaylistPicker();
      return;
    }
    if (event.target.closest('[data-picker-create]')) {
      const currentTrack = this._pickerTrackId;
      this._closePlaylistPicker();
      await this._createPlaylistAndMaybeAddTrack(currentTrack);
      return;
    }
    if (event.target.closest('[data-picker-playlist-id]')) {
      await this._handlePickerClick(event.target);
      return;
    }

    const addType = event.target.closest('[data-add-type]')?.dataset.addType;
    if (addType) {
      await this._addBlock(addType);
      return;
    }

    const actionEl = event.target.closest('[data-action]');
    if (actionEl) {
      const action = actionEl.dataset.action;
      if (action === 'back-library') {
        this._closeDetailModal();
        return;
      }
      if (action === 'toggle-add') {
        this._toggleAddMenu();
        return;
      }
      if (action === 'reset-layout') {
        await this._resetLayout();
        return;
      }
    }

    const blockAction = event.target.closest('[data-block-action]');
    if (blockAction) {
      await this._handleBlockAction(blockAction);
      return;
    }

    const trackAction = event.target.closest('[data-track-action]');
    if (trackAction) {
      event.preventDefault();
      event.stopPropagation();
      await this._handleTrackAction(trackAction);
      return;
    }

    const artistCard = event.target.closest('.artist-card');
    if (artistCard) {
      this._openArtistDetail(artistCard.dataset.artistId || '', artistCard.querySelector('.artist-avatar') || artistCard);
      return;
    }

    const albumCard = event.target.closest('.album-card');
    if (albumCard) {
      this._openAlbumDetail(albumCard.dataset.albumId || '', albumCard.querySelector('.album-cover') || albumCard);
      return;
    }

    const playlistCard = event.target.closest('.playlist-card');
    if (playlistCard) {
      await this._openPlaylistPanel(Number(playlistCard.dataset.playlistId || 0));
    }
  }

  async _handleBlockAction(button) {
    const blockEl = button.closest('.library-block');
    const blockId = blockEl?.dataset.blockId || '';
    const action = button.dataset.blockAction;
    const layout = {
      ...this.store.state.layout,
      blocks: [...this.store.state.layout.blocks],
    };
    const index = layout.blocks.findIndex((block) => block.id === blockId);
    if (index < 0) return;

    if (action === 'move-up' && index > 0) {
      [layout.blocks[index - 1], layout.blocks[index]] = [layout.blocks[index], layout.blocks[index - 1]];
    } else if (action === 'move-down' && index < layout.blocks.length - 1) {
      [layout.blocks[index + 1], layout.blocks[index]] = [layout.blocks[index], layout.blocks[index + 1]];
    } else if (action === 'size') {
      const current = SIZE_ORDER.indexOf(layout.blocks[index].size);
      layout.blocks[index] = { ...layout.blocks[index], size: SIZE_ORDER[(current + 1) % SIZE_ORDER.length] };
    } else if (action === 'configure') {
      layout.blocks[index] = this._configureBlock(layout.blocks[index]);
    } else if (action === 'remove') {
      layout.blocks.splice(index, 1);
    }

    await this._saveLayout(layout);
  }

  _configureBlock(block) {
    const title = window.prompt('Block title', block.title || '');
    if (title === null) return block;
    const limitRaw = window.prompt('Item limit', String(block.config?.limit || ''));
    if (limitRaw === null) return { ...block, title: title.trim() || block.title };
    const limit = Math.max(0, Number(limitRaw) || 0);
    return {
      ...block,
      title: title.trim() || block.title,
      config: { ...block.config, limit },
    };
  }

  async _handleTrackAction(button) {
    const row = button.closest('.track-card');
    const trackId = row?.dataset.trackId || '';
    const track = this.store.findTrack(trackId) || this._findCachedTrack(trackId);
    if (!track) {
      this._notify('Track unavailable');
      return;
    }

    const action = button.dataset.trackAction;
    if (action === 'play') await this._playTrack(track);
    if (action === 'queue') await this._queueTrack(track);
    if (action === 'versions') this._versionPanel?.open?.(track, row);
    if (action === 'edit-identity') await this._openIdentityEditor(track, row);
    if (action === 'remove-playlist-track') await this._removePlaylistTrack(row.dataset.playlistId, trackId, row);
  }

  _findCachedTrack(trackId) {
    for (const value of this._detailCache.values()) {
      const track = (value.tracks || []).find((item) => getTrackId(item) === trackId);
      if (track) return track;
    }
    return null;
  }

  async _addBlock(type) {
    const defaults = BLOCK_TYPES[type];
    if (!defaults) return;
    this._closeAddMenu();
    const block = {
      id: `${type}-${Date.now()}`,
      type,
      view: defaults.view,
      title: defaults.title,
      size: defaults.size,
      enabled: true,
      config: { ...defaults.config },
    };
    await this._saveLayout({
      ...this.store.state.layout,
      blocks: [...this.store.state.layout.blocks, block],
    });
  }

  async _openArtistDetail(artistId, sourceEl = null) {
    if (!artistId) return;
    await this._openDetailModal({
      type: 'artist',
      id: artistId,
      sourceEl,
      sourceSelector: `.artist-card[data-artist-id="${escapeSelectorValue(artistId)}"] .artist-avatar`,
    });
  }

  async _openAlbumDetail(albumId, sourceEl = null) {
    if (!albumId) return;
    await this._openDetailModal({
      type: 'album',
      id: albumId,
      sourceEl,
      sourceSelector: `.album-card[data-album-id="${escapeSelectorValue(albumId)}"] .album-cover`,
    });
  }

  async _openDetailModal(detail) {
    if (!detail?.type || !detail.id) return;
    if (this._detailModal?.closing) return;
    if (this._detailModal) {
      this._detailModal.type = detail.type;
      this._detailModal.id = detail.id;
      this._detailModal.sourceSelector = detail.sourceSelector;
      this._detailModal.sourceEl = detail.sourceEl || this._resolveDetailSource(detail);
      this._refreshDetailModal();
      this._syncDetailOriginVisibility();
      return;
    }

    this._closeAddMenu();
    const modal = document.createElement('div');
    modal.className = 'library-detail-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `
      <section class="library-detail-modal-shell">
        ${this._renderDetailModalContent(detail.type, detail.id)}
      </section>
    `;
    document.body.appendChild(modal);

    const shell = modal.querySelector('.library-detail-modal-shell');
    const sourceEl = detail.sourceEl || this._resolveDetailSource(detail);
    this._hideDetailOrigin(sourceEl);
    this._detailModal = {
      ...detail,
      modal,
      shell,
      sourceEl,
      opening: true,
      closing: false,
      onClick: (event) => this._handleDetailModalClick(event),
    };
    modal.addEventListener('click', this._detailModal.onClick);

    OverlayBackdropController.show('library-detail', {
      zIndex: 989,
      blur: 'var(--blur-overlay)',
      scrim: 'var(--color-bg-scrim)',
      interactive: true,
      duration: 320,
      onBackdropClick: () => this._closeDetailModal(),
    });

    await this._detailMorph.open({
      sourceEl,
      originEl: sourceEl,
      targetEl: shell,
      contentEl: shell.querySelector('.library-detail-modal-content'),
      duration: 460,
    });

    if (this._detailModal?.modal === modal && !this._detailModal.closing) {
      this._detailModal.opening = false;
      modal.classList.add('is-content-visible');
      shell.querySelector('[data-detail-close]')?.focus?.({ preventScroll: true });
    }
  }

  async _closeDetailModal(options = {}) {
    const detail = this._detailModal;
    if (!detail || detail.closing) return;
    detail.closing = true;
    detail.modal.classList.remove('is-content-visible');
    OverlayBackdropController.hide('library-detail');

    const sourceEl = this._resolveDetailSource(detail) || detail.sourceEl;
    if (!options.instant) {
      await this._detailMorph.close({
        sourceEl,
        originEl: sourceEl || detail.sourceEl,
        targetEl: detail.shell,
        duration: 340,
      });
    }

    this._showDetailOrigins();
    detail.modal.removeEventListener('click', detail.onClick);
    detail.modal.remove();
    if (this._detailModal === detail) this._detailModal = null;
  }

  async _handleDetailModalClick(event) {
    if (event.target.closest('[data-detail-close]')) {
      await this._closeDetailModal();
      return;
    }

    const trackAction = event.target.closest('[data-track-action]');
    if (trackAction) {
      event.preventDefault();
      event.stopPropagation();
      await this._handleTrackAction(trackAction);
      return;
    }

    const albumCard = event.target.closest('.album-card');
    if (albumCard) {
      await this._openAlbumDetail(albumCard.dataset.albumId || '', albumCard.querySelector('.album-cover') || albumCard);
      return;
    }

    const artistCard = event.target.closest('.artist-card');
    if (artistCard) {
      await this._openArtistDetail(artistCard.dataset.artistId || '', artistCard.querySelector('.artist-avatar') || artistCard);
    }
  }

  _refreshDetailModal() {
    const detail = this._detailModal;
    if (!detail?.shell || detail.closing) return;
    detail.shell.innerHTML = this._renderDetailModalContent(detail.type, detail.id);
    if (!detail.opening) detail.modal.classList.add('is-content-visible');
  }

  _resolveDetailSource(detail = this._detailModal) {
    if (!detail?.sourceSelector) return null;
    const source = this.querySelector(detail.sourceSelector);
    if (source?.isConnected) return source;
    return null;
  }

  _syncDetailOriginVisibility() {
    const detail = this._detailModal;
    if (!detail || detail.closing) return;
    const source = this._resolveDetailSource(detail);
    if (!source) return;
    this._hideDetailOrigin(source);
    detail.sourceEl = source;
  }

  _hideDetailOrigin(source) {
    if (!source) return;
    source.classList.add('is-morph-origin-hidden');
    this._detailHiddenOrigins.add(source);
  }

  _showDetailOrigins() {
    this._detailHiddenOrigins.forEach((source) => source?.classList?.remove('is-morph-origin-hidden'));
    this._detailHiddenOrigins.clear();
  }

  async _saveLayout(layout) {
    try {
      await this.store.saveLayout(layout);
      this._notify('Layout saved');
    } catch (error) {
      console.error('Layout save error:', error);
      this._notify('Layout save failed');
    }
  }

  async _resetLayout() {
    try {
      await this.store.resetLayout();
      this._detailCache.clear();
      this._notify('Layout reset');
    } catch (error) {
      console.error('Layout reset error:', error);
      this._notify('Layout reset failed');
    }
  }

  async _loadArtistDetail(artistId) {
    const key = `artist:${artistId}`;
    if (this._detailCache.get(`${key}:loading`)) return;
    this._detailCache.set(`${key}:loading`, true);
    try {
      this._detailCache.set(key, await this.store.getArtistDetail(artistId));
      this._refreshDetailModal();
      this.render();
    } catch (error) {
      console.error('Artist detail load failed:', error);
      this._detailCache.set(key, { tracks: [], albums: [] });
      this._refreshDetailModal();
      this.render();
    } finally {
      this._detailCache.delete(`${key}:loading`);
    }
  }

  async _loadAlbumTracks(albumId) {
    const key = `album:${albumId}`;
    if (this._detailCache.get(`${key}:loading`)) return;
    this._detailCache.set(`${key}:loading`, true);
    try {
      this._detailCache.set(key, await this.store.getAlbumTracks(albumId));
      this._refreshDetailModal();
      this.render();
    } catch (error) {
      console.error('Album track load failed:', error);
      this._detailCache.set(key, { tracks: [] });
      this._refreshDetailModal();
      this.render();
    } finally {
      this._detailCache.delete(`${key}:loading`);
    }
  }

  async _playTrack(track, specificAssetId = null) {
    const trackId = getTrackId(track);
    if (!trackId) {
      this._notify('Invalid track');
      return;
    }
    const payload = { track_id: trackId };
    if (specificAssetId) payload.asset_id = specificAssetId;
    try {
      const response = await fetch('/api/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`Play failed (${response.status})`);
      this._notify('Playing now');
      this._refreshPlaybackStatus(150);
    } catch (error) {
      console.error('Play error:', error);
      this._notify('Play failed');
    }
  }

  async _queueTrack(track, specificAssetId = null) {
    const trackId = getTrackId(track);
    if (!trackId) {
      this._notify('Invalid track');
      return;
    }
    const payload = {
      track_id: trackId,
      title: track.title || '',
      thumbnail: track.thumbnail || '',
    };
    if (specificAssetId) payload.asset_id = specificAssetId;
    try {
      const response = await fetch('/api/queue/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`Queue failed (${response.status})`);
      this._notify('Added to queue');
      this._refreshPlaybackStatus(120);
    } catch (error) {
      console.error('Queue error:', error);
      this._notify('Queue failed');
    }
  }

  async _playPlaylist(playlistId) {
    if (!playlistId) return;
    try {
      const tracks = await this.store.getPlaylistTracks(playlistId);
      if (!tracks.length) {
        this._notify('Playlist is empty');
        return;
      }
      await this._playTrack(tracks[0]);
      for (const track of tracks.slice(1)) await this._queueTrack(track);
      this._notify(`Playing playlist (${tracks.length} tracks)`);
    } catch (error) {
      console.error('Play playlist error:', error);
      this._notify('Failed to play playlist');
    }
  }

  async _deleteTrack(track) {
    const trackId = getTrackId(track);
    if (!trackId) return;
    if (!window.confirm(`Delete "${track.title || 'this track'}"?`)) return;
    try {
      const response = await fetch(`/api/library/${encodeURIComponent(trackId)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`Delete failed (${response.status})`);
      this.store.removeTrack(trackId);
      this._notify('Deleted');
      this._refreshPlaybackStatus(120);
    } catch (error) {
      console.error('Delete error:', error);
      this._notify('Delete failed');
    }
  }

  async _openPlaylistPanel(playlistId) {
    if (!playlistId) return;
    try {
      const playlist = this.store.state.playlists.find((item) => Number(item.id) === playlistId) || { id: playlistId, name: 'Playlist' };
      const tracks = await this.store.getPlaylistTracks(playlistId);
      this._closePlaylistPanel();
      const panel = document.createElement('div');
      panel.className = 'library-playlist-panel';
      panel.innerHTML = `
        <div class="library-playlist-backdrop" data-playlist-close></div>
        <section class="library-playlist-sheet">
          <header>
            <div>
              <span>Playlist</span>
              <h3>${escapeHtml(playlist.name || 'Playlist')}</h3>
            </div>
            <button class="library-icon-btn hover-target" type="button" data-playlist-close aria-label="Close">${ICONS.close}</button>
          </header>
          <div class="library-playlist-tracks">
            ${this._renderTracks(tracks, { dense: true, removablePlaylistId: playlistId })}
          </div>
        </section>
      `;
      document.body.appendChild(panel);
      panel.addEventListener('click', async (event) => {
        if (event.target.closest('[data-playlist-close]')) {
          this._closePlaylistPanel();
          return;
        }
        const action = event.target.closest('[data-track-action]');
        if (action) {
          await this._handleTrackAction(action);
        }
      });
      this._playlistPanel = panel;
      requestAnimationFrame(() => panel.classList.add('active'));
    } catch (error) {
      console.error('Open playlist error:', error);
      this._notify('Failed to open playlist');
    }
  }

  _closePlaylistPanel() {
    if (!this._playlistPanel) return;
    const panel = this._playlistPanel;
    panel.classList.remove('active');
    window.setTimeout(() => panel.remove(), 180);
    this._playlistPanel = null;
  }

  async _removePlaylistTrack(playlistId, trackId, row) {
    if (!playlistId || !trackId) return;
    try {
      const response = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(trackId)}`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error(`Remove failed (${response.status})`);
      row?.remove();
      await this.store.load();
      this._notify('Removed from playlist');
    } catch (error) {
      console.error('Remove track from playlist error:', error);
      this._notify('Remove failed');
    }
  }

  async _openIdentityEditor(track, sourceEl = null) {
    const trackId = getTrackId(track);
    if (!trackId) {
      this._notify('Track unavailable');
      return;
    }
    this._closeIdentityEditor();
    const modal = document.createElement('div');
    modal.className = 'identity-editor-panel';
    modal.innerHTML = '<div class="identity-editor-backdrop" data-identity-close></div><section class="identity-editor-shell"><div class="library-loading">Loading...</div></section>';
    document.body.appendChild(modal);
    this._identityModal = {
      modal,
      shell: modal.querySelector('.identity-editor-shell'),
      trackId,
      track,
      sourceEl,
      identity: null,
      candidates: [],
      selectedCandidate: null,
      searchQuery: `${getDisplayArtist(track) || ''} ${track.title || ''}`.trim(),
      searching: false,
      onClick: (event) => this._handleIdentityEditorClick(event),
    };
    modal.addEventListener('click', this._identityModal.onClick);
    requestAnimationFrame(() => modal.classList.add('active'));

    try {
      const response = await fetch(`/api/library/tracks/${encodeURIComponent(trackId)}/identity`);
      if (!response.ok) throw new Error(`Identity load failed (${response.status})`);
      this._identityModal.identity = await response.json();
      this._identityModal.track = this._identityModal.identity.track || track;
      this._renderIdentityEditor();
    } catch (error) {
      console.error('Identity load error:', error);
      this._identityModal.shell.innerHTML = `
        <div class="identity-editor-header">
          <strong>Edit identity</strong>
          <button class="library-icon-btn hover-target" type="button" data-identity-close aria-label="Close">${ICONS.close}</button>
        </div>
        <div class="identity-editor-error">Failed to load identity</div>
      `;
    }
  }

  _closeIdentityEditor() {
    const state = this._identityModal;
    if (!state) return;
    state.modal.removeEventListener('click', state.onClick);
    state.modal.classList.remove('active');
    window.setTimeout(() => state.modal.remove(), 160);
    this._identityModal = null;
  }

  _identityFieldValue(name) {
    const form = this._identityModal?.shell?.querySelector('[data-identity-form]');
    if (!form) return '';
    return form.elements[name]?.value || '';
  }

  _candidateAlbumTitle(candidate) {
    return candidate?.album?.title || candidate?.albums?.[0]?.title || '';
  }

  _candidateCover(candidate) {
    return candidate?.cover_image || candidate?.thumbnail || candidate?.album?.cover || candidate?.albums?.[0]?.cover || '';
  }

  _renderIdentityEditor() {
    const state = this._identityModal;
    if (!state?.shell) return;
    const track = state.track || {};
    const override = state.identity?.override;
    const selected = state.selectedCandidate;
    const formValues = {
      title: selected?.title ?? (this._identityFieldValue('title') || track.title || ''),
      display_artist: selected?.display_artist ?? (this._identityFieldValue('display_artist') || getDisplayArtist(track) || ''),
      album_title: this._candidateAlbumTitle(selected) || this._identityFieldValue('album_title') || getAlbumTitle(track) || '',
      year: selected?.year ?? (this._identityFieldValue('year') || track.year || ''),
      cover_image: this._candidateCover(selected) || this._identityFieldValue('cover_image') || track.thumbnail || '',
      spotify_id: selected?.spotify_id ?? (this._identityFieldValue('spotify_id') || track.spotify_id || ''),
      isrc: selected?.isrc ?? (this._identityFieldValue('isrc') || track.isrc || ''),
      mb_recording_id: selected?.mb_recording_id ?? (this._identityFieldValue('mb_recording_id') || track.mb_recording_id || ''),
      discogs_id: selected?.discogs_id ?? (this._identityFieldValue('discogs_id') || track.discogs_id || ''),
      label: selected?.label ?? (this._identityFieldValue('label') || track.label || ''),
    };
    const cover = thumbSrc(formValues.cover_image || track.thumbnail);
    const assets = getAssets(track);
    const fastAsset = getFastAsset(track) || assets[0] || {};
    const audioTrackId = getTrackId(track);
    const selectedKey = selected ? `${selected.provider || ''}:${selected.id || selected.title || ''}` : '';

    state.shell.innerHTML = `
      <div class="identity-editor-header">
        <span class="identity-editor-cover">${cover ? `<img src="${escapeHtml(cover)}" alt="" loading="lazy" onerror="this.remove()">` : 'Audio'}</span>
        <span class="identity-editor-heading">
          <strong>Edit identity</strong>
          <em>${escapeHtml(track.title || 'Unknown')} - ${escapeHtml(getDisplayArtist(track) || 'Unknown Artist')}</em>
        </span>
        <button class="library-icon-btn hover-target" type="button" data-identity-close aria-label="Close">${ICONS.close}</button>
      </div>
      <div class="identity-editor-content">
        <audio controls preload="none" src="/api/library/${encodeURIComponent(audioTrackId)}/download"></audio>
        <div class="identity-editor-search">
          <input name="identity_query" value="${escapeHtml(state.searchQuery || '')}" placeholder="Artist - Title, Spotify URL, ISRC" autocomplete="off">
          <button class="library-toolbar-btn hover-target" type="button" data-identity-search>${state.searching ? 'Searching...' : 'Search'}</button>
        </div>
        <div class="identity-editor-candidates">
          ${state.candidates.length ? state.candidates.map((candidate, index) => this._renderIdentityCandidate(candidate, index, selectedKey)).join('') : '<div class="identity-editor-empty">No candidates loaded</div>'}
        </div>
        <form class="identity-editor-form" data-identity-form>
          <label>Title<input name="title" value="${escapeHtml(formValues.title)}" required></label>
          <label>Artist<input name="display_artist" value="${escapeHtml(formValues.display_artist)}" required></label>
          <label>Album<input name="album_title" value="${escapeHtml(formValues.album_title)}"></label>
          <label>Year<input name="year" inputmode="numeric" value="${escapeHtml(formValues.year)}"></label>
          <label>Cover URL<input name="cover_image" value="${escapeHtml(formValues.cover_image)}"></label>
          <label>Spotify ID<input name="spotify_id" value="${escapeHtml(formValues.spotify_id)}"></label>
          <label>ISRC<input name="isrc" value="${escapeHtml(formValues.isrc)}"></label>
          <label>MusicBrainz ID<input name="mb_recording_id" value="${escapeHtml(formValues.mb_recording_id)}"></label>
          <label>Discogs ID<input name="discogs_id" inputmode="numeric" value="${escapeHtml(formValues.discogs_id)}"></label>
          <label>Label<input name="label" value="${escapeHtml(formValues.label)}"></label>
        </form>
      </div>
      <div class="identity-editor-actions">
        ${override ? '<button class="library-toolbar-btn hover-target" type="button" data-identity-remove>Remove override</button>' : '<span></span>'}
        <span>
          <button class="library-toolbar-btn hover-target" type="button" data-identity-close>Cancel</button>
          <button class="library-toolbar-btn hover-target identity-save-btn" type="button" data-identity-save>Save</button>
        </span>
      </div>
    `;
    if (fastAsset?.id) state.shell.dataset.assetId = fastAsset.id;
  }

  _renderIdentityCandidate(candidate, index, selectedKey) {
    const key = `${candidate.provider || ''}:${candidate.id || candidate.title || ''}`;
    const cover = thumbSrc(this._candidateCover(candidate));
    const confidence = candidate.confidence ? `${Math.round(Number(candidate.confidence) * 100)}%` : '';
    const meta = [
      candidate.provider || 'candidate',
      this._candidateAlbumTitle(candidate),
      candidate.year || '',
      confidence,
    ].filter(Boolean).join(' - ');
    return `
      <button class="identity-candidate hover-target ${key === selectedKey ? 'selected' : ''}" type="button" data-identity-candidate="${index}">
        <span class="identity-candidate-cover">${cover ? `<img src="${escapeHtml(cover)}" alt="" loading="lazy" onerror="this.remove()">` : 'Audio'}</span>
        <span class="identity-candidate-main">
          <strong>${escapeHtml(candidate.title || 'Unknown')}</strong>
          <em>${escapeHtml(candidate.display_artist || 'Unknown Artist')}</em>
          <small>${escapeHtml(meta)}</small>
        </span>
      </button>
    `;
  }

  async _handleIdentityEditorClick(event) {
    const state = this._identityModal;
    if (!state) return;
    if (event.target.closest('[data-identity-close]')) {
      this._closeIdentityEditor();
      return;
    }
    const candidateButton = event.target.closest('[data-identity-candidate]');
    if (candidateButton) {
      const index = Number(candidateButton.dataset.identityCandidate || -1);
      state.selectedCandidate = state.candidates[index] || null;
      this._renderIdentityEditor();
      return;
    }
    if (event.target.closest('[data-identity-search]')) {
      await this._searchIdentityCandidates();
      return;
    }
    if (event.target.closest('[data-identity-save]')) {
      await this._saveIdentityOverride();
      return;
    }
    if (event.target.closest('[data-identity-remove]')) {
      await this._removeIdentityOverride();
    }
  }

  async _searchIdentityCandidates() {
    const state = this._identityModal;
    if (!state) return;
    const input = state.shell.querySelector('input[name="identity_query"]');
    state.searchQuery = input?.value?.trim() || '';
    state.searching = true;
    this._renderIdentityEditor();
    try {
      const response = await fetch(`/api/library/tracks/${encodeURIComponent(state.trackId)}/identity-search?q=${encodeURIComponent(state.searchQuery)}`);
      if (!response.ok) throw new Error(`Identity search failed (${response.status})`);
      const data = await response.json();
      state.candidates = Array.isArray(data.candidates) ? data.candidates : [];
      state.selectedCandidate = state.candidates[0] || null;
    } catch (error) {
      console.error('Identity search error:', error);
      this._notify('Identity search failed');
    } finally {
      state.searching = false;
      this._renderIdentityEditor();
    }
  }

  _collectIdentityForm() {
    const state = this._identityModal;
    const form = state?.shell?.querySelector('[data-identity-form]');
    if (!form) return null;
    const data = Object.fromEntries(new FormData(form).entries());
    for (const key of ['year', 'discogs_id']) {
      data[key] = data[key] ? Number(data[key]) : null;
    }
    data.candidate = state.selectedCandidate || null;
    data.locked = true;
    return data;
  }

  async _saveIdentityOverride() {
    const state = this._identityModal;
    const payload = this._collectIdentityForm();
    if (!state || !payload) return;
    try {
      const response = await fetch(`/api/library/tracks/${encodeURIComponent(state.trackId)}/identity-override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `Identity save failed (${response.status})`);
      }
      const data = await response.json();
      if (data.track) this.store.updateTrack(data.track);
      this._detailCache.clear();
      this.render();
      this._notify('Identity saved');
      this._closeIdentityEditor();
      this._refreshPlaybackStatus(120);
    } catch (error) {
      console.error('Identity save error:', error);
      this._notify('Identity save failed');
    }
  }

  async _removeIdentityOverride() {
    const state = this._identityModal;
    if (!state) return;
    try {
      const response = await fetch(`/api/library/tracks/${encodeURIComponent(state.trackId)}/identity-override`, {
        method: 'DELETE',
      });
      if (!response.ok) throw new Error(`Remove override failed (${response.status})`);
      const data = await response.json();
      if (data.track) this.store.updateTrack(data.track);
      this._detailCache.clear();
      this.render();
      this._notify('Override removed');
      this._closeIdentityEditor();
    } catch (error) {
      console.error('Remove override error:', error);
      this._notify('Remove override failed');
    }
  }

  _renderPlaylistPicker() {
    return `
      <div class="playlist-picker" data-role="playlist-picker" aria-hidden="true">
        <div class="playlist-picker-backdrop" data-picker-close></div>
        <div class="playlist-picker-card">
          <div class="playlist-picker-title">Add to playlist</div>
          <div class="playlist-picker-list" data-role="playlist-picker-list"></div>
          <div class="playlist-picker-actions">
            <button type="button" data-picker-create>New playlist</button>
            <button type="button" data-picker-close>Cancel</button>
          </div>
        </div>
      </div>
    `;
  }

  _openPlaylistPicker(trackId) {
    if (!trackId) return;
    this._pickerTrackId = trackId;
    const picker = this.querySelector('[data-role="playlist-picker"]');
    const list = this.querySelector('[data-role="playlist-picker-list"]');
    if (!picker || !list) return;
    list.innerHTML = this.store.state.playlists.length
      ? this.store.state.playlists.map((playlist) => `
          <button type="button" class="playlist-picker-item" data-picker-playlist-id="${Number(playlist.id || 0)}">
            <span>${escapeHtml(playlist.name || 'Playlist')}</span>
            <span>${plural(Number(playlist.track_count || 0), 'track')}</span>
          </button>
        `).join('')
      : '<div class="playlist-picker-empty">No playlists yet</div>';
    picker.classList.add('active');
    picker.setAttribute('aria-hidden', 'false');
  }

  _closePlaylistPicker() {
    const picker = this.querySelector('[data-role="playlist-picker"]');
    if (!picker) return;
    picker.classList.remove('active');
    picker.setAttribute('aria-hidden', 'true');
    this._pickerTrackId = '';
  }

  async _addTrackToPlaylist(trackId, playlistId) {
    const response = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}/tracks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ track_id: trackId }),
    });
    if (!response.ok) throw new Error(`Add to playlist failed (${response.status})`);
  }

  async _createPlaylistAndMaybeAddTrack(trackId) {
    const name = window.prompt('New playlist', '');
    if (!name || !name.trim()) return;
    try {
      const response = await fetch('/api/playlists', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!response.ok) throw new Error(`Create playlist failed (${response.status})`);
      const playlist = await response.json();
      if (trackId && playlist.id) await this._addTrackToPlaylist(trackId, playlist.id);
      await this.store.load();
      window.dispatchEvent(new CustomEvent('rolfsound-playlist-created', { detail: { playlist } }));
      this._notify('Playlist created');
    } catch (error) {
      console.error('Create playlist error:', error);
      this._notify('Failed to create playlist');
    }
  }

  _renamePlaylist({ playlistId, name }) {
    if (!playlistId || !name) return;
    const playlist = this.store.state.playlists.find((item) => Number(item.id) === Number(playlistId));
    if (playlist) playlist.name = name;
    this.render();
  }

  _toggleAddMenu() {
    this._isAddMenuOpen = !this._isAddMenuOpen;
    const menu = this.querySelector('[data-role="add-menu"]');
    const button = this.querySelector('[data-action="toggle-add"]');
    if (!menu || !button) return;
    menu.classList.toggle('active', this._isAddMenuOpen);
    menu.setAttribute('aria-hidden', String(!this._isAddMenuOpen));
    button.setAttribute('aria-expanded', String(this._isAddMenuOpen));
  }

  _closeAddMenu() {
    this._isAddMenuOpen = false;
    const menu = this.querySelector('[data-role="add-menu"]');
    const button = this.querySelector('[data-action="toggle-add"]');
    menu?.classList.remove('active');
    menu?.setAttribute('aria-hidden', 'true');
    button?.setAttribute('aria-expanded', 'false');
  }

  _handleKeydown(event) {
    if (event.key !== 'Escape') return;
    if (this._identityModal) this._closeIdentityEditor();
    if (this._detailModal) this._closeDetailModal();
    this._closePlaylistPanel();
    this._closePlaylistPicker();
    this._versionPanel?.close?.();
  }

  _handleSearch(event) {
    if (event.type === 'rolfsound-search-close') {
      this.store.setQuery('');
      return;
    }
    if (document.body.dataset.searchPanel === 'open') return;
    const query = event.detail?.query ?? this._currentSearchQuery();
    this.store.setQuery(query);
  }

  _handleContextBuild(event) {
    const context = event.detail?.context;
    const items = event.detail?.items;
    if (!context || !Array.isArray(items)) return;
    const digitalView = document.getElementById('view-digital-library');
    if (!digitalView?.classList.contains('active')) return;

    const card = context.cardElement || context.target?.closest?.('.track-card');
    if (!card || !this.contains(card) || !card.classList.contains('track-card')) return;
    const track = this.store.findTrack(card.dataset.trackId || '') || this._findCachedTrack(card.dataset.trackId || '');
    if (!track) return;
    const trackId = getTrackId(track) || 'track';

    items.push(
      { id: `play-${trackId}`, label: 'Play', icon: ICONS.play, action: () => this._playTrack(track) },
      { id: `versions-${trackId}`, label: 'Versions', icon: ICONS.versions, action: () => this._versionPanel?.open?.(track, card) },
      { id: `identity-${trackId}`, label: 'Edit identity', icon: ICONS.edit, action: () => this._openIdentityEditor(track, card) },
      { type: 'separator' },
      { id: `delete-${trackId}`, label: 'Delete', icon: ICONS.close, danger: true, action: () => this._deleteTrack(track) },
    );
  }

  async _handlePickerClick(target) {
    const playlistId = Number(target.closest('[data-picker-playlist-id]')?.dataset.pickerPlaylistId || 0);
    if (playlistId && this._pickerTrackId) {
      try {
        await this._addTrackToPlaylist(this._pickerTrackId, playlistId);
        this._closePlaylistPicker();
        this._notify('Added to playlist');
        await this.store.load();
      } catch (error) {
        console.error('Add to playlist error:', error);
        this._notify('Failed to add to playlist');
      }
    }
  }

  _currentSearchQuery() {
    return (document.querySelector('rolfsound-island')?.shadowRoot?.getElementById('search-input')?.value || '').trim().toLowerCase();
  }

  _notify(text, spinner = false, duration = 2200) {
    const island = document.querySelector('rolfsound-island');
    if (typeof island?.showNotification === 'function') {
      island.showNotification({ text, spinner, duration });
    }
  }

  _refreshPlaybackStatus(delay = 200) {
    if (typeof window.playbackMitosisManager?.pollStatus === 'function') {
      window.setTimeout(() => window.playbackMitosisManager.pollStatus(), delay);
    }
  }
}

if (!customElements.get('rolfsound-library-workspace')) {
  customElements.define('rolfsound-library-workspace', RolfsoundLibraryWorkspace);
}
export default RolfsoundLibraryWorkspace;

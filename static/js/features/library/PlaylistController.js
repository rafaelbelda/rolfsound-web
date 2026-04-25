// static/js/PlaylistController.js

export default class PlaylistController {
    constructor() {
        this._playlists = [];

        this._onContextBuild = this._handleContextBuild.bind(this);

        window.addEventListener('rolfsound-context-build', this._onContextBuild);

        this.refresh();
    }

    destroy() {
        window.removeEventListener('rolfsound-context-build', this._onContextBuild);
    }

    async refresh() {
        try {
            const response = await fetch('/api/playlists');
            if (!response.ok) return;
            const data = await response.json();
            this._playlists = Array.isArray(data.playlists) ? data.playlists : [];
        } catch (_) {}
    }

    _notify(text) {
        if (typeof window.island?.showNotification === 'function') {
            window.island.showNotification({ text, duration: 2200 });
        }
    }

    _handleContextBuild(e) {
        const context = e.detail?.context;
        const items = e.detail?.items;

        if (!context || !Array.isArray(items)) return;

        const digitalView = document.getElementById('view-digital-library');
        if (!digitalView || !digitalView.classList.contains('active')) return;

        const card = context.cardElement || context.target?.closest?.('.track-card, .playlist-card');
        if (!card) return;

        if (card.classList.contains('track-card')) {
            const trackId = card.dataset.trackId || context.trackId || '';
            if (!trackId) return;

            const nextIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>`;
            const addIcon  = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M14 10H2v2h12v-2zm0-4H2v2h12V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM2 16h8v-2H2v2z"/></svg>`;

            items.push(
                {
                    id: `queue-next-${trackId}`,
                    label: 'Play next',
                    icon: nextIcon,
                    action: async () => {
                        try {
                            const currentIdx = window.playbackMitosisManager?.state?.currentQueueIdx ?? -1;
                            const insertPos  = currentIdx + 1;
                            const r = await fetch('/api/queue/add', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ track_id: trackId, position: insertPos })
                            });
                            if (r.ok) this._notify('Playing next');
                        } catch (err) {
                            console.error('Play next failed:', err);
                        }
                    }
                },
                {
                    id: `queue-add-${trackId}`,
                    label: 'Add to queue',
                    icon: addIcon,
                    action: async () => {
                        try {
                            const r = await fetch('/api/queue/add', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ track_id: trackId })
                            });
                            if (r.ok) this._notify('Added to queue');
                        } catch (err) {
                            console.error('Add to queue failed:', err);
                        }
                    }
                },
                {
                    id: `playlist-add-${trackId}`,
                    label: 'Add to playlist',
                    icon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>`,
                    action: () => {
                        window.dispatchEvent(new CustomEvent('rolfsound-playlist-picker-request', {
                            detail: { trackId }
                        }));
                    }
                }
            );
            return;
        }

        if (card.classList.contains('playlist-card')) {
            const playlistId = Number(card.dataset.playlistId || 0);
            if (!playlistId) return;

            const playlist = this._playlists.find((p) => Number(p.id) === playlistId);
            const playlistName = playlist?.name || 'playlist';

            const playIcon   = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
            const renameIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;
            const deleteIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;

            items.push(
                {
                    id: `playlist-play-${playlistId}`,
                    label: 'Play playlist',
                    icon: playIcon,
                    action: () => {
                        window.dispatchEvent(new CustomEvent('rolfsound-playlist-play', {
                            detail: { playlistId }
                        }));
                    }
                },
                {
                    id: `playlist-rename-${playlistId}`,
                    label: 'Rename',
                    icon: renameIcon,
                    action: async () => {
                        const newName = window.prompt('Rename playlist', playlistName);
                        if (!newName || !newName.trim()) return;
                        try {
                            const r = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}`, {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ name: newName.trim() })
                            });
                            if (!r.ok) throw new Error(`Rename failed (${r.status})`);
                            if (playlist) playlist.name = newName.trim();
                            window.dispatchEvent(new CustomEvent('rolfsound-playlist-renamed', {
                                detail: { playlistId, name: newName.trim() }
                            }));
                            this._notify(`Renamed to "${newName.trim()}"`);
                        } catch (err) {
                            console.error('Playlist rename error:', err);
                        }
                    }
                },
                { type: 'separator' },
                {
                    id: `playlist-delete-${playlistId}`,
                    label: 'Delete playlist',
                    icon: deleteIcon,
                    danger: true,
                    action: async () => {
                        if (!confirm(`Delete "${playlistName}"?`)) return;
                        try {
                            const response = await fetch(`/api/playlists/${encodeURIComponent(playlistId)}`, {
                                method: 'DELETE'
                            });
                            if (!response.ok) throw new Error(`Delete failed (${response.status})`);

                            this._playlists = this._playlists.filter((p) => Number(p.id) !== playlistId);
                            window.dispatchEvent(new CustomEvent('rolfsound-playlist-deleted', {
                                detail: { playlistId }
                            }));
                        } catch (error) {
                            console.error('Playlist delete error:', error);
                        }
                    }
                }
            );
        }
    }
}

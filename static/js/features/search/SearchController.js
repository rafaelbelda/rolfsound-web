// static/js/SearchController.js
// Cérebro externo da busca. A ilha é apenas o shell de animação.
//
// Responsabilidades desta classe:
//   - Ouvir keydown no document (abrir search ao digitar)
//   - Saber qual aba está ativa para rotear a busca
//   - Receber o evento 'rolfsound-search' da ilha e despachar para a API certa
//   - Gerenciar debounce, cancelamento de requests e SSE
//
// Payload emitido em 'rolfsound-search-results':
//   { library: Track[], youtube: Track[], state: 'idle'|'loading'|'streaming'|'done'|'error',
//     tab: string, query: string, error?: string }

export default class SearchController {
    /**
     * @param {HTMLElement} island - O elemento <rolfsound-island>
     */
    constructor(island) {
        this._island    = island;
        this._activeTab = island.getAttribute('active-tab') || 'library';
        this._abortCtrl = null;   // AbortController do request SSE atual
        this._debounce  = null;   // timer de debounce
        this._DEBOUNCE_MS = 300;

        this._onKeydown      = this._onKeydown.bind(this);
        this._onSearch       = this._onSearch.bind(this);
        this._onNavigate     = this._onNavigate.bind(this);

        this._attach();
    }

    // ─── Setup ───────────────────────────────────────────────────────────────

    _attach() {
        document.addEventListener('keydown', this._onKeydown);
        this._island.addEventListener('rolfsound-search', this._onSearch);
        this._island.addEventListener('rolfsound-navigate', this._onNavigate);
    }

    destroy() {
        document.removeEventListener('keydown', this._onKeydown);
        this._island.removeEventListener('rolfsound-search', this._onSearch);
        this._island.removeEventListener('rolfsound-navigate', this._onNavigate);
        this._cancelPending();
    }

    // ─── Keydown Global ──────────────────────────────────────────────────────

    _onKeydown(e) {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key.length !== 1) return;

        if (this._isAnyEditableFocused()) return;

        if (this._island.shadowRoot?.getElementById('mitosis-playlist-input')) return;

        if (this._island.isLocked) return;

        const searchOpen = !!this._island.shadowRoot.getElementById('mitosis-search');
        if (searchOpen) return;

        e.preventDefault();
        this._island.openSearch();

        const firstChar = e.key;
        const waitForInput = (attempts = 0) => {
            const input = this._island.shadowRoot.getElementById('search-input');
            if (input) {
                input.focus();
                input.value = firstChar;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (attempts < 20) {
                setTimeout(() => waitForInput(attempts + 1), 50);
            } else {
                console.warn('[SearchController] timed out waiting for search input to appear in shadow DOM');
            }
        };
        waitForInput();
    }

    _isAnyEditableFocused() {
        const focused = this._getDeepActiveElement(document);
        if (!focused) return false;

        const tagName = (focused.tagName || '').toUpperCase();
        if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
        if (focused.isContentEditable) return true;

        return false;
    }

    _getDeepActiveElement(root) {
        let currentRoot = root;
        let active = currentRoot?.activeElement || null;

        while (active && active.shadowRoot && active.shadowRoot.activeElement) {
            currentRoot = active.shadowRoot;
            active = currentRoot.activeElement;
        }

        return active;
    }

    // ─── Despacho de Busca ───────────────────────────────────────────────────

    _onSearch(e) {
        const query = (e.detail?.query ?? '').trim();

        clearTimeout(this._debounce);
        this._cancelPending();

        if (!query) {
            this._dispatchResults({ library: [], youtube: [], state: 'idle', query: '', tab: this._activeTab });
            return;
        }

        this._debounce = setTimeout(() => {
            this._executeSearch(query);
        }, this._DEBOUNCE_MS);
    }

    _onNavigate(e) {
        this._activeTab = e.detail?.view ?? this._activeTab;
    }

    // ─── Search Execution ────────────────────────────────────────────────────

    async _executeSearch(query) {
        this._abortCtrl = new AbortController();
        const signal = this._abortCtrl.signal;

        const library = [];
        const youtube = [];

        // Emite estado "loading" imediatamente, antes do fetch
        this._dispatchResults({ library, youtube, state: 'loading', query, tab: this._activeTab });

        try {
            const url = `/api/search?q=${encodeURIComponent(query)}&tab=${encodeURIComponent(this._activeTab)}`;
            const res = await fetch(url, { signal });

            if (!res.ok) throw new Error(`Search HTTP ${res.status}`);

            const contentType = res.headers.get('Content-Type') || '';

            if (contentType.includes('text/event-stream')) {
                // Parser SSE correto: agrupa linhas em frames delimitados por linha em branco
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buf = '';

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buf += decoder.decode(value, { stream: true });

                    let boundary;
                    while ((boundary = buf.indexOf('\n\n')) !== -1) {
                        const frame = buf.slice(0, boundary);
                        buf = buf.slice(boundary + 2);

                        let eventName = 'message';
                        let dataLine = '';

                        for (const line of frame.split('\n')) {
                            if (line.startsWith('event:')) {
                                eventName = line.slice(6).trim();
                            } else if (line.startsWith('data:')) {
                                dataLine = line.slice(5).trim();
                            }
                        }

                        if (!dataLine) continue;

                        try {
                            const payload = JSON.parse(dataLine);

                            if (eventName === 'library') {
                                const tracks = Array.isArray(payload.tracks) ? payload.tracks : [];
                                library.push(...tracks);
                                this._dispatchResults({ library: [...library], youtube: [...youtube], state: 'streaming', query, tab: this._activeTab });
                            } else if (eventName === 'result') {
                                youtube.push(payload);
                                this._dispatchResults({ library: [...library], youtube: [...youtube], state: 'streaming', query, tab: this._activeTab });
                            } else if (eventName === 'done') {
                                this._dispatchResults({ library: [...library], youtube: [...youtube], state: 'done', query, tab: this._activeTab });
                                return;
                            } else if (eventName === 'error') {
                                const msg = payload.error || payload.message || 'Search failed';
                                this._dispatchResults({ library: [...library], youtube: [...youtube], state: 'error', query, tab: this._activeTab, error: msg });
                                return;
                            }
                        } catch (_) {}
                    }
                }

            } else {
                // Fallback JSON — classifica por presença de file_path
                const data = await res.json();
                const items = Array.isArray(data.results ?? data) ? (data.results ?? data) : [];
                for (const item of items) {
                    if (item.file_path || item.filepath) library.push(item);
                    else youtube.push(item);
                }
            }

        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error('[SearchController] search error:', err);
                this._dispatchResults({ library: [...library], youtube: [...youtube], state: 'error', query, tab: this._activeTab, error: err.message });
                return;
            }
            return; // AbortError — silencioso
        }

        this._dispatchResults({ library: [...library], youtube: [...youtube], state: 'done', query, tab: this._activeTab });
    }

    _cancelPending() {
        if (this._abortCtrl) {
            this._abortCtrl.abort();
            this._abortCtrl = null;
        }
    }

    // ─── Distribuição de Resultados ──────────────────────────────────────────

    _dispatchResults(payload) {
        window.dispatchEvent(new CustomEvent('rolfsound-search-results', {
            detail: payload
        }));
    }
}

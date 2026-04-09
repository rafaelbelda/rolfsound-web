// static/js/SearchController.js
// Cérebro externo da busca. A ilha é apenas o shell de animação.
//
// Responsabilidades desta classe:
//   - Ouvir keydown no document (abrir search ao digitar)
//   - Saber qual aba está ativa para rotear a busca
//   - Receber o evento 'rolfsound-search' da ilha e despachar para a API certa
//   - Gerenciar debounce, cancelamento de requests e SSE

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
        // Ouve qualquer pressionamento de tecla "imprimível" sem ser dentro de um input
        document.addEventListener('keydown', this._onKeydown);

        // Ouve o evento de busca que a ilha dispara quando o usuário digita no input
        this._island.addEventListener('rolfsound-search', this._onSearch);

        // Rastreia a aba ativa para rotear a busca
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
        // Ignora modificadores e teclas não-imprimíveis
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key.length !== 1) return;

        // Ignora se já há um input/textarea focado (não queremos interferir)
        const focused = document.activeElement;
        if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA')) return;

        // Ignora se a ilha está num estado que não suporta search (ex: morph de notificação)
        if (this._island.isLocked) return;

        const searchOpen = !!this._island.shadowRoot.getElementById('mitosis-search');
        if (searchOpen) return; // Já aberta — o foco está no input, browser digita naturalmente

        e.preventDefault();
        this._island.openSearch();

        // Aguarda o input aparecer no shadow DOM e injeta o primeiro caractere
        const firstChar = e.key;
        const waitForInput = (attempts = 0) => {
            const input = this._island.shadowRoot.getElementById('search-input');
            if (input) {
                input.focus();
                input.value = firstChar;
                input.dispatchEvent(new Event('input', { bubbles: true }));
            } else if (attempts < 20) {
                setTimeout(() => waitForInput(attempts + 1), 50);
            }
        };
        waitForInput();
    }

    // ─── Despacho de Busca ───────────────────────────────────────────────────

    _onSearch(e) {
        const query = (e.detail?.query ?? '').trim();

        clearTimeout(this._debounce);
        this._cancelPending();

        if (!query) {
            this._dispatchResults([]);
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

        const results = [];

        try {
            // A API /api/search usa Server-Sent Events e combina resultados de
            // library local + YouTube. Cada chunk é uma linha JSON.
            const url = `/api/search?q=${encodeURIComponent(query)}&tab=${encodeURIComponent(this._activeTab)}`;
            const res = await fetch(url, { signal });

            if (!res.ok) throw new Error(`Search HTTP ${res.status}`);

            const contentType = res.headers.get('Content-Type') || '';

            if (contentType.includes('text/event-stream')) {
                // SSE: lê chunks conforme chegam
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buf = '';

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buf += decoder.decode(value, { stream: true });

                    let nl;
                    while ((nl = buf.indexOf('\n')) !== -1) {
                        const line = buf.slice(0, nl).trim();
                        buf = buf.slice(nl + 1);

                        if (line.startsWith('data:')) {
                            try {
                                const item = JSON.parse(line.slice(5).trim());
                                results.push(item);
                                // Resultados parciais em tempo real
                                this._dispatchResults([...results]);
                            } catch (_) {}
                        }
                    }
                }
            } else {
                // JSON simples (fallback)
                const data = await res.json();
                results.push(...(data.results ?? data));
            }

        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error('[SearchController] search error:', err);
            }
        }

        this._dispatchResults(results);
    }

    _cancelPending() {
        if (this._abortCtrl) {
            this._abortCtrl.abort();
            this._abortCtrl = null;
        }
    }

    // ─── Distribuição de Resultados ──────────────────────────────────────────

    _dispatchResults(results) {
        // Dispara um evento no window para que qualquer view possa ouvir
        window.dispatchEvent(new CustomEvent('rolfsound-search-results', {
            detail: { results, tab: this._activeTab }
        }));
    }
}

// static/js/components/search-results/search-results.js
// <rolfsound-search-results> — panel that renders unified library + YouTube results.
//
// Attributes:
//   open          — presence toggles visibility
//   layout-mode   — 'floating' | 'docked' (set by SearchLayoutCoordinator)
//
// Listens on window:
//   rolfsound-search-results  { library, youtube, state, tab, query, error? }
//   rolfsound-layout-applied  { mode, resultsLeft, targetTop }
//
// Emits on window (via track-row delegation):
//   rolfsound-search-row-action  { action, track, source }
//   (the track-row emits track-row-action which this component re-emits)

import { adoptStyles } from '/static/js/core/adoptStyles.js';

class RolfsoundSearchResults extends HTMLElement {
    static get observedAttributes() { return ['open', 'layout-mode']; }

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });

        this._state   = 'idle';   // 'idle'|'loading'|'streaming'|'done'|'error'
        this._library = [];
        this._youtube = [];
        this._error   = '';
        this._query   = '';
        this._activeTab = 'library'; // 'library' | 'youtube'
        this._focusIdx  = -1;        // keyboard focused row index

        this._rendered = false;

        this._onResults       = this._onResults.bind(this);
        this._onLayout        = this._onLayout.bind(this);
        this._onKeydown       = this._onKeydown.bind(this);
        this._onTrackRowAction = this._onTrackRowAction.bind(this);
    }

    // ── Lifecycle ────────────────────────────────────────────────

    async connectedCallback() {
        // Register window listeners immediately — before the async render —
        // so events fired during CSS fetch are never missed.
        window.addEventListener('rolfsound-search-results', this._onResults);
        window.addEventListener('rolfsound-layout-applied',  this._onLayout);
        // track-row-action is composed+bubbles so it always reaches window.
        // Listening here is more reliable than shadowRoot for nested shadow DOMs.
        window.addEventListener('track-row-action', this._onTrackRowAction);

        if (!this._rendered) {
            await this._render();
            this._rendered = true;
            // Apply any data that arrived during the async render.
            if (this._state !== 'idle') this._updateUI();
        }

        this.shadowRoot.addEventListener('keydown', this._onKeydown);
    }

    disconnectedCallback() {
        window.removeEventListener('rolfsound-search-results', this._onResults);
        window.removeEventListener('rolfsound-layout-applied',  this._onLayout);
        window.removeEventListener('track-row-action', this._onTrackRowAction);
        this.shadowRoot.removeEventListener('keydown', this._onKeydown);
    }

    attributeChangedCallback(name, oldVal, newVal) {
        if (oldVal === newVal || !this._rendered) return;
        if (name === 'open') {
            if (!this.hasAttribute('open')) this._resetState();
        }
    }

    // ── Rendering ────────────────────────────────────────────────

    async _render() {
        const tokensSheet  = await adoptStyles('/static/css/tokens.css');
        const sheet        = await adoptStyles('/static/js/components/search-results/search-results.css');
        this.shadowRoot.adoptedStyleSheets = [tokensSheet, sheet];

        this.shadowRoot.innerHTML = `
        <div class="shell" part="shell">
            <div class="tabs" role="tablist">
                <button class="tab active" role="tab" data-tab="library" aria-selected="true">
                    Library <span class="tab-count lib-count"></span>
                </button>
                <button class="tab" role="tab" data-tab="youtube" aria-selected="false">
                    YouTube <span class="tab-count yt-count"></span>
                </button>
                <div class="tab-spinner" aria-hidden="true"></div>
            </div>
            <div class="list" role="listbox" aria-label="Search results">
                <div class="state-loading-full">
                    <div class="spinner"></div>
                    <span>Searching…</span>
                </div>
                <div class="state-empty"></div>
                <div class="state-error"></div>
            </div>
            <div class="footer" aria-hidden="true">
                <span class="hint"><kbd>↑↓</kbd> navigate</span>
                <span class="hint"><kbd>↵</kbd> play</span>
                <span class="hint"><kbd>Space</kbd> queue</span>
                <span class="hint"><kbd>Esc</kbd> close</span>
            </div>
        </div>`;

        // Tab click delegation
        this.shadowRoot.querySelector('.tabs').addEventListener('click', (e) => {
            const btn = e.target.closest('.tab[data-tab]');
            if (!btn) return;
            this._setActiveTab(btn.dataset.tab);
        });
    }

    // ── Event handlers ───────────────────────────────────────────

    _onTrackRowAction(e) {
        // Only re-emit when this panel is open — prevents duplicate dispatch
        // if other track-row elements exist on the page.
        if (!this.hasAttribute('open')) return;
        window.dispatchEvent(new CustomEvent('rolfsound-search-row-action', {
            detail: e.detail
        }));
    }

    _onResults(e) {
        const { library = [], youtube = [], state, query, error } = e.detail || {};

        // Race guard: discard stale results if panel is closed
        if (!this.hasAttribute('open')) return;

        this._library = library;
        this._youtube = youtube;
        this._state   = state || 'idle';
        this._error   = error || '';
        this._query   = query || '';

        if (!this._rendered) return; // data stored; _updateUI called after render completes
        this._updateUI();
    }

    _onLayout(e) {
        const { resultsLeft, targetTop, mode } = e.detail || {};
        if (mode && !mode.includes('results')) return; // not our slot

        if (resultsLeft != null) {
            this.style.left = `${resultsLeft}px`;
        }
        if (targetTop != null) {
            this.style.top = `${targetTop}px`;
        }
    }

    // ── Keyboard navigation ──────────────────────────────────────

    _onKeydown(e) {
        const rows = this._getVisibleRows();
        const count = rows.length;
        if (!count) return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this._focusIdx = this._focusIdx < count - 1 ? this._focusIdx + 1 : 0;
            rows[this._focusIdx]?.focus({ preventScroll: false });
            this._scrollRowIntoView(rows[this._focusIdx]);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this._focusIdx = this._focusIdx > 0 ? this._focusIdx - 1 : count - 1;
            rows[this._focusIdx]?.focus({ preventScroll: false });
            this._scrollRowIntoView(rows[this._focusIdx]);
        } else if (e.key === 'Tab' && !e.shiftKey) {
            // Tab switches between Library / YouTube tabs
            e.preventDefault();
            this._setActiveTab(this._activeTab === 'library' ? 'youtube' : 'library');
        } else if (e.key === 'Home') {
            e.preventDefault();
            this._focusIdx = 0;
            rows[0]?.focus();
        } else if (e.key === 'End') {
            e.preventDefault();
            this._focusIdx = count - 1;
            rows[count - 1]?.focus();
        }
    }

    _getVisibleRows() {
        return Array.from(this.shadowRoot.querySelectorAll('rolfsound-track-row'));
    }

    _scrollRowIntoView(row) {
        if (!row) return;
        const list = this.shadowRoot.querySelector('.list');
        if (!list) return;
        const rowRect  = row.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        if (rowRect.bottom > listRect.bottom) {
            list.scrollTop += rowRect.bottom - listRect.bottom + 4;
        } else if (rowRect.top < listRect.top) {
            list.scrollTop -= listRect.top - rowRect.top + 4;
        }
    }

    // ── UI updates ───────────────────────────────────────────────

    _updateUI() {
        this._updateTabCounts();
        this._updateSpinner();
        this._renderRows();
        this._focusIdx = -1; // reset keyboard cursor on new results
    }

    _updateTabCounts() {
        const libCount = this.shadowRoot.querySelector('.lib-count');
        const ytCount  = this.shadowRoot.querySelector('.yt-count');
        if (libCount) libCount.textContent = this._library.length ? `(${this._library.length})` : '';
        if (ytCount)  ytCount.textContent  = this._youtube.length ? `(${this._youtube.length})` : '';
    }

    _updateSpinner() {
        const spinner = this.shadowRoot.querySelector('.tab-spinner');
        if (!spinner) return;
        const loading = this._state === 'loading' || this._state === 'streaming';
        spinner.classList.toggle('visible', loading);
    }

    _setActiveTab(tab) {
        this._activeTab = tab;
        this._focusIdx  = -1;

        const tabs = this.shadowRoot.querySelectorAll('.tab[data-tab]');
        tabs.forEach(btn => {
            const active = btn.dataset.tab === tab;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', String(active));
        });

        this._renderRows();
    }

    _renderRows() {
        const list  = this.shadowRoot.querySelector('.list');
        if (!list) return;

        const items = this._activeTab === 'library' ? this._library : this._youtube;
        const source = this._activeTab === 'library' ? 'library' : 'youtube';

        // State overlays
        const loadingEl = list.querySelector('.state-loading-full');
        const emptyEl   = list.querySelector('.state-empty');
        const errorEl   = list.querySelector('.state-error');

        loadingEl?.classList.toggle('visible', this._state === 'loading' && items.length === 0);
        errorEl?.classList.toggle('visible', this._state === 'error');
        if (errorEl) errorEl.textContent = this._state === 'error' ? (this._error || 'Search failed') : '';

        const isEmpty = items.length === 0 && this._state !== 'loading' && this._state !== 'error';
        if (emptyEl) {
            emptyEl.classList.toggle('visible', isEmpty);
            if (isEmpty) {
                emptyEl.textContent = this._query
                    ? `No ${source === 'library' ? 'library' : 'YouTube'} results for "${this._query}"`
                    : 'Start typing to search…';
            }
        }

        // Remove existing rows
        list.querySelectorAll('rolfsound-track-row').forEach(r => r.remove());

        if (!items.length) return;

        // Determine which IDs are in library, queued, or playing
        const libraryIds = new Set((this._library || []).map(t => t.id || t.track_id).filter(Boolean));
        const librarySourceRefs = new Set((this._library || []).map(t => t.source_ref).filter(Boolean));
        const queuedIds  = new Set((window.playbackMitosisManager?.state.queue || []).map(t => t.id || t.track_id).filter(Boolean));
        const playingId  = window.playbackMitosisManager?.state.currentId || null;

        const fragment = document.createDocumentFragment();
        for (const track of items) {
            const row = document.createElement('rolfsound-track-row');
            const tid = track.id || track.track_id || '';

            row.setAttribute('source', source);

            let state = 'idle';
            if (tid && tid === playingId)          state = 'playing';
            else if (tid && queuedIds.has(tid))    state = 'queued';
            else if (source === 'youtube' && tid && (libraryIds.has(tid) || librarySourceRefs.has(tid))) state = 'in-library';

            row.setAttribute('state', state);
            row.track = track;
            fragment.appendChild(row);
        }
        list.appendChild(fragment);
    }

    // ── Reset on close ───────────────────────────────────────────

    _resetState() {
        this._state   = 'idle';
        this._library = [];
        this._youtube = [];
        this._error   = '';
        this._query   = '';
        this._focusIdx = -1;
        if (this._rendered) {
            this._updateTabCounts();
            this._updateSpinner();
            const list = this.shadowRoot.querySelector('.list');
            if (list) {
                list.querySelectorAll('rolfsound-track-row').forEach(r => r.remove());
                list.querySelector('.state-loading-full')?.classList.remove('visible');
                list.querySelector('.state-empty')?.classList.remove('visible');
                list.querySelector('.state-error')?.classList.remove('visible');
            }
        }
    }

    // ── Public API ───────────────────────────────────────────────

    /** Move keyboard focus into the results list (called when user presses ↓ from the search input) */
    focusFirst() {
        const rows = this._getVisibleRows();
        if (rows.length) {
            this._focusIdx = 0;
            rows[0].focus({ preventScroll: false });
        }
    }

    /** Re-evaluate row states (e.g. after a track starts playing) */
    refreshStates() {
        if (this._rendered) this._renderRows();
    }
}

customElements.define('rolfsound-search-results', RolfsoundSearchResults);
export default RolfsoundSearchResults;

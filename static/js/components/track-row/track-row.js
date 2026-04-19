// static/js/components/track-row/track-row.js
// Reusable track row for search results, queue, and playlist panels.
//
// Attributes:
//   source  — 'library' | 'youtube'
//   state   — 'idle' | 'in-library' | 'queued' | 'downloading' | 'playing'
//
// Properties:
//   track    — full track object ({ id, title, artist|channel, thumbnail, duration })
//   progress — number 0-100 (download progress; only shown when state='downloading')
//
// Events emitted (composed, bubbling):
//   track-row-action → { action: 'play'|'queue'|'download', track, source }

import { adoptStyles } from '/static/js/core/adoptStyles.js';
import { getThumbnailCandidates, cascadeImage, escapeHtml, formatDuration } from '/static/js/utils/thumbnails.js';

const RING_R          = 18;
const RING_CIRCUMF    = 2 * Math.PI * RING_R; // ≈ 113.1
const FALLBACK_ICON   = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;

class RolfsoundTrackRow extends HTMLElement {
    static get observedAttributes() {
        return ['source', 'state'];
    }

    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._track    = null;
        this._progress = 0;
        this._rendered = false;
    }

    // ── Properties ──────────────────────────────────────────────

    get track() { return this._track; }
    set track(v) {
        this._track = v;
        if (this._rendered) this._updateContent();
    }

    get progress() { return this._progress; }
    set progress(v) {
        this._progress = Number(v) || 0;
        if (this._rendered) this._updateRing();
    }

    // ── Lifecycle ────────────────────────────────────────────────

    async connectedCallback() {
        if (!this._rendered) {
            await this._render();
            this._rendered = true;
        }
    }

    attributeChangedCallback(name, oldVal, newVal) {
        if (oldVal === newVal || !this._rendered) return;
        if (name === 'state') this._updateBadge();
    }

    // ── Rendering ────────────────────────────────────────────────

    async _render() {
        const tokensSheet = await adoptStyles('/static/css/tokens.css');
        const sheet       = await adoptStyles('/static/js/components/track-row/track-row.css');
        this.shadowRoot.adoptedStyleSheets = [tokensSheet, sheet];

        this.shadowRoot.innerHTML = this._buildHTML();
        this._attachListeners();
        this._updateContent();
        this._updateBadge();
        this._updateRing();
    }

    _buildHTML() {
        return `
        <div class="row" role="option" tabindex="-1" part="row">
            <div class="thumb-wrap">
                <div class="thumb" part="thumb">
                    ${FALLBACK_ICON}
                </div>
                <svg class="progress-ring" viewBox="0 0 42 42" aria-hidden="true">
                    <circle class="progress-ring-track" cx="21" cy="21" r="${RING_R}"/>
                    <circle class="progress-ring-fill"  cx="21" cy="21" r="${RING_R}"
                        stroke-dasharray="${RING_CIRCUMF.toFixed(1)}"
                        stroke-dashoffset="${RING_CIRCUMF.toFixed(1)}"/>
                </svg>
            </div>
            <div class="body" part="body">
                <div class="title" part="title"></div>
                <div class="sub"   part="sub"></div>
            </div>
            <span class="source-pill">YT</span>
            <div class="badge" part="badge"></div>
            <div class="actions" part="actions">
                <button class="btn-action btn-play" aria-label="Play" title="Play">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z"/>
                    </svg>
                </button>
                <button class="btn-action btn-queue" aria-label="Add to queue" title="Add to queue">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                        <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                </button>
                <button class="btn-action btn-download" aria-label="Download" title="Download" style="display:none">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                </button>
            </div>
        </div>`;
    }

    _attachListeners() {
        const row = this.shadowRoot.querySelector('.row');

        row.addEventListener('click', (e) => {
            const btn = e.target.closest('.btn-action');
            if (btn) {
                e.stopPropagation();
                let action = 'play';
                if (btn.classList.contains('btn-queue'))    action = 'queue';
                if (btn.classList.contains('btn-download')) action = 'download';
                this._emit(action);
                return;
            }
            this._emit('play');
        });

        row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter')      { e.preventDefault(); this._emit('play'); }
            if (e.key === ' ')          { e.preventDefault(); this._emit('queue'); }
        });
    }

    _emit(action) {
        this.dispatchEvent(new CustomEvent('track-row-action', {
            bubbles: true,
            composed: true,
            detail: { action, track: this._track, source: this.getAttribute('source') || 'library' }
        }));
    }

    // ── Content updates ──────────────────────────────────────────

    _updateContent() {
        if (!this._track) return;
        const track  = this._track;
        const source = this.getAttribute('source') || 'library';

        const titleEl = this.shadowRoot.querySelector('.title');
        const subEl   = this.shadowRoot.querySelector('.sub');
        const thumbEl = this.shadowRoot.querySelector('.thumb');
        const dlBtn   = this.shadowRoot.querySelector('.btn-download');

        if (titleEl) titleEl.textContent = track.title || 'Unknown';

        const channel  = track.channel || track.artist || '';
        const duration = track.duration ? formatDuration(track.duration) : '';
        const subParts = [channel, duration].filter(Boolean);
        if (subEl) subEl.textContent = subParts.join(' · ');

        // Show download button only for YouTube results not yet in library
        if (dlBtn) {
            const state = this.getAttribute('state') || 'idle';
            dlBtn.style.display = (source === 'youtube' && state === 'idle') ? '' : 'none';
        }

        // Thumbnail
        const candidates = getThumbnailCandidates(track);
        if (candidates.length) {
            const img = document.createElement('img');
            img.src = candidates[0];
            img.alt = '';
            img.loading = 'lazy';
            if (thumbEl) {
                thumbEl.innerHTML = '';
                thumbEl.appendChild(img);
                cascadeImage(img, candidates);
            }
        } else if (thumbEl) {
            thumbEl.innerHTML = FALLBACK_ICON;
        }
    }

    _updateBadge() {
        const badgeEl = this.shadowRoot.querySelector('.badge');
        const dlBtn   = this.shadowRoot.querySelector('.btn-download');
        if (!badgeEl) return;
        const state = this.getAttribute('state') || 'idle';
        const labels = {
            'in-library':  'In Library',
            'playing':     'Playing',
            'queued':      'Queued',
            'downloading': `${Math.round(this._progress)}%`,
        };
        badgeEl.textContent = labels[state] || '';

        // Hide download button when not idle
        if (dlBtn) {
            const src = this.getAttribute('source') || 'library';
            dlBtn.style.display = (src === 'youtube' && state === 'idle') ? '' : 'none';
        }
    }

    _updateRing() {
        const fill = this.shadowRoot.querySelector('.progress-ring-fill');
        if (!fill) return;
        const offset = RING_CIRCUMF * (1 - Math.min(100, Math.max(0, this._progress)) / 100);
        fill.style.strokeDashoffset = offset.toFixed(1);

        // Sync badge text
        const badgeEl = this.shadowRoot.querySelector('.badge');
        if (badgeEl && this.getAttribute('state') === 'downloading') {
            badgeEl.textContent = `${Math.round(this._progress)}%`;
        }
    }

    // ── Focus helpers (called by parent for keyboard nav) ────────

    focus(options) {
        this.shadowRoot.querySelector('.row')?.focus(options);
    }
}

customElements.define('rolfsound-track-row', RolfsoundTrackRow);
export default RolfsoundTrackRow;

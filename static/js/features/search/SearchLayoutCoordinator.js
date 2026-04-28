// static/js/SearchLayoutCoordinator.js
// Orchestrates the 1/2/3-column layout when the search results panel is open.
//
// State it tracks:
//   isSearchOpen  — search bar is open (island dispatches rolfsound-search-open/close)
//   isMorphed     — Now Playing full view is active
//   currentTab    — active navigation tab
//
// What it does:
//   - Sets document.body.dataset.searchPanel = 'open' | 'closed'
//   - Sets document.body.dataset.backdropBlur = 'true' | 'false'
//   - Positions <rolfsound-search-results> (floating or docked)
//   - In docked mode: calls window.playbackMitosisManager._shell.applyLayout(mode)
//     so the player (and queue if open) slide to their slots and emit rolfsound-layout-applied
//   - The <rolfsound-search-results> element positions itself from rolfsound-layout-applied

export default class SearchLayoutCoordinator {
    /**
     * @param {HTMLElement} island          - <rolfsound-island>
     * @param {HTMLElement} resultsEl       - <rolfsound-search-results>
     */
    constructor(island, resultsEl) {
        this._island    = island;
        this._resultsEl = resultsEl;

        this._isSearchOpen = false;
        this._isMorphed    = false;
        this._currentTab   = island.getAttribute('active-tab') || 'library';

        this._onSearchOpen  = this._onSearchOpen.bind(this);
        this._onSearchClose = this._onSearchClose.bind(this);
        this._onNavigate    = this._onNavigate.bind(this);
        this._onQueueOpen   = this._onQueueOpen.bind(this);
        this._onQueueClose  = this._onQueueClose.bind(this);

        this._attach();
    }

    destroy() {
        window.removeEventListener('rolfsound-search-open',  this._onSearchOpen);
        window.removeEventListener('rolfsound-search-close', this._onSearchClose);
        window.removeEventListener('rolfsound-queue-open',   this._onQueueOpen);
        window.removeEventListener('rolfsound-queue-close',  this._onQueueClose);
        this._island.removeEventListener('rolfsound-navigate', this._onNavigate);
        if (this._onBackdropClick) document.removeEventListener('click', this._onBackdropClick);
        if (this._onModalKeydown)  window.removeEventListener('keydown', this._onModalKeydown);
    }

    _attach() {
        window.addEventListener('rolfsound-search-open',  this._onSearchOpen);
        window.addEventListener('rolfsound-search-close', this._onSearchClose);
        window.addEventListener('rolfsound-queue-open',   this._onQueueOpen);
        window.addEventListener('rolfsound-queue-close',  this._onQueueClose);
        this._island.addEventListener('rolfsound-navigate', this._onNavigate);
    }

    // ── Event handlers ───────────────────────────────────────────

    _onNavigate(e) {
        this._currentTab = e.detail?.view ?? this._currentTab;
        this._isMorphed  = this._currentTab === 'playback'
            || (window.playbackMitosisManager?.isMorphed ?? false);
    }

    _onSearchOpen() {
        this._isSearchOpen = true;
        document.body.dataset.searchPanel = 'open';
        this._isMorphed = window.playbackMitosisManager?.isMorphed ?? false;
        this._applyLayout();
    }

    _onSearchClose() {
        this._isSearchOpen = false;
        document.body.dataset.searchPanel = 'closed';
        document.body.dataset.backdropBlur = 'false';

        this._resultsEl.removeAttribute('open');
        this._resultsEl.style.transform = '';

        // Tear down modal-mode listeners
        if (this._onBackdropClick) {
            document.removeEventListener('click', this._onBackdropClick);
            this._onBackdropClick = null;
        }
        if (this._onModalKeydown) {
            window.removeEventListener('keydown', this._onModalKeydown);
            this._onModalKeydown = null;
        }

        // Restore player to centered/original position
        if (this._isMorphed) {
            const shell = window.playbackMitosisManager?._shell;
            if (shell) {
                const mode = window.playbackMitosisManager.isQueueOpen
                    ? 'player+queue' : 'player-only';
                shell.applyLayout(mode);
            }
        }
    }

    _onQueueOpen() {
        // Queue opened while search is open → need to go to 3-col
        if (this._isSearchOpen && this._isMorphed) {
            this._applyLayout(); // re-computes mode which is now player+results+queue
        }
    }

    _onQueueClose() {
        // Queue closed while search is open → drop back to 2-col
        if (this._isSearchOpen && this._isMorphed) {
            this._applyLayout();
        }
    }

    // ── Layout logic ─────────────────────────────────────────────

    _currentMode() {
        // Modal supersedes floating/docked. The floating/docked branches remain
        // available for any future variant that brings back the inline panel.
        return 'modal';
    }

    _applyLayout() {
        if (!this._isSearchOpen) return;

        const mode = this._currentMode();

        if (mode === 'modal') {
            this._applyModal();
        } else if (mode === 'floating') {
            this._applyFloating();
        } else {
            this._applyDocked(mode);
        }
    }

    _applyModal() {
        document.body.dataset.backdropBlur = 'modal';

        const top = getComputedStyle(document.documentElement)
            .getPropertyValue('--search-modal-top').trim() || '88px';

        Object.assign(this._resultsEl.style, {
            top,
            left: '50%',
            width: '',
            height: '',
            maxHeight: '',
            transform: 'translateX(-50%)',
        });

        this._resultsEl.setAttribute('layout-mode', 'modal');
        this._resultsEl.setAttribute('open', '');

        // Backdrop click → close
        this._onBackdropClick = (e) => {
            if (e.target === document.body) this._island.closeSearch?.();
        };
        document.addEventListener('click', this._onBackdropClick);

        // ESC from anywhere → close (belt-and-suspenders: the input also handles it)
        this._onModalKeydown = (e) => {
            if (e.key === 'Escape') this._island.closeSearch?.();
        };
        window.addEventListener('keydown', this._onModalKeydown);
    }

    _applyFloating() {
        const w = getComputedStyle(document.documentElement)
            .getPropertyValue('--search-results-w').trim() || '420px';
        const wPx = parseFloat(w);
        const maxH = 'min(62vh, 540px)';

        // Position below island bar
        const island = this._island;
        const islandRect = island.getBoundingClientRect();
        const top  = islandRect.bottom + 10;
        const left = Math.max(8, (window.innerWidth - wPx) / 2);

        Object.assign(this._resultsEl.style, {
            top:       `${top}px`,
            left:      `${left}px`,
            width:     `${wPx}px`,
            height:    'auto',
            maxHeight: maxH,
        });

        document.body.dataset.backdropBlur = 'true';
        this._resultsEl.setAttribute('layout-mode', 'floating');
        this._resultsEl.setAttribute('open', '');
    }

    _applyDocked(mode) {
        // Delegate positioning to PlayerShell via applyLayout;
        // PlayerShell emits rolfsound-layout-applied with resultsLeft/targetTop.
        // <rolfsound-search-results> listens to that event and positions itself.
        const shell = window.playbackMitosisManager?._shell;
        if (!shell) { this._applyFloating(); return; }

        // Prepare the results element size for docked mode (same as PLAYER_W × TOTAL_H)
        const PLAYER_W = 340;
        const TOTAL_H  = 406;
        Object.assign(this._resultsEl.style, {
            width:     `${PLAYER_W}px`,
            height:    `${TOTAL_H}px`,
            maxHeight: `${TOTAL_H}px`,
        });

        document.body.dataset.backdropBlur = 'false';
        this._resultsEl.setAttribute('layout-mode', 'docked');
        this._resultsEl.setAttribute('open', '');

        // Ask PlayerShell to compute and animate the layout
        shell.applyLayout(mode);
    }
}

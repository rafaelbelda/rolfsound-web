// static/js/RolfsoundIsland.js

import AnimationEngine from '/static/js/features/animations/AnimationEngine.js';
import { measureIslandBarMitosis } from '/static/js/features/island/MitosisMetrics.js';
import { playElasticImpact } from '/static/js/features/island/IslandImpactEngine.js';
import MiniBirthAnimator from '/static/js/features/island/MiniBirthAnimator.js';
import channel from '/static/js/channel/RolfsoundChannel.js';

class RolfsoundIsland extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });

        this.activeTab   = this.getAttribute('active-tab') || 'library';
        this.libraryMode = this.getAttribute('library-mode') === 'digital' ? 'digital' : 'vinyl';
        this.isLocked    = false;
        this._listenersAttached = false;
        this._onShadowClick = null;
        this._animationTimers = new Set();
        this._notificationTimers = new Set();
        this._impactAnimations = new Set();
        this._promptResolver = null;
        this._miniBirthAnimator = new MiniBirthAnimator();
        this._miniPendingReconcile = false;
    }

    static get observedAttributes() {
        return ['active-tab', 'library-mode', 'playing'];
    }

    connectedCallback() {
        this.render();

        if (!this._listenersAttached) {
            this._attachDelegatedListeners();
            this._listenersAttached = true;
        }

        this.reset();
        this.updateActiveTab();
        this._attachMiniplayerSync();

        // ─── Lógica do VU Meter Real ───
        this._unsubAudio = channel.on('audio_monitor', (data) => {
            // 1. Guarda de segurança
            if (!this.hasAttribute('playing')) return;
                
            const bars = this.shadowRoot.querySelectorAll('.now-playing-indicator span');
            if (!bars.length) return;
                
            // 2. A MÁGICA: Usar os nomes corretos que descobrimos!
            const levelVal = data.level || 0;
            const peakVal = data.peak || 0;
                
            // 3. Amplificação: Como 0.001 é minúsculo, a raiz quadrada dá ~0.03.
            // Multiplicamos por 250 para atingir a faixa dos 8 a 10 pixels nas batidas.
            const baseHeight = Math.sqrt(levelVal) * 250;
            const peakHeight = Math.sqrt(peakVal) * 250;
                
            // 4. Aplicar o CSS. A barra central ganha o pico máximo da batida!
            bars[0].style.height = `${Math.max(3, Math.min(10, baseHeight * 0.8))}px`;
            bars[1].style.height = `${Math.max(3, Math.min(10, peakHeight))}px`; 
            bars[2].style.height = `${Math.max(3, Math.min(10, baseHeight * 0.9))}px`;
        });
    }

    disconnectedCallback() {
        AnimationEngine.clearScheduled(this, '_morphTimer');
        AnimationEngine.clearScheduled(this, '_animationTimers');
        AnimationEngine.clearScheduled(this, '_notificationTimers');

        if (this._onShadowClick) {
            this.shadowRoot.removeEventListener('click', this._onShadowClick);
            this._onShadowClick = null;
        }

        this.hideNotification({ immediate: true });
        this.cancelPlaylistNamePrompt(null, true);
        this.cancelImpactResponse();

        if (this._onStoreChange) {
            window.playbackStore?.removeEventListener('state-change',  this._onStoreChange);
            window.playbackStore?.removeEventListener('queue-change',  this._onStoreChange);
            window.playbackStore?.removeEventListener('track-change',  this._onStoreChange);
            this._onStoreChange = null;
        }

        if (this._unsubAudio) {
            this._unsubAudio();
            this._unsubAudio = null;
        }
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'active-tab' && oldValue !== newValue) {
            this.activeTab = newValue;
            this.updateActiveTab();
            this.reconcileMini();
            return;
        }

        if (name === 'playing') {
            // CSS reacts directly to :host([playing]) — no shadow DOM re-render needed.
            return;
        }

        if (name === 'library-mode' && oldValue !== newValue) {
            this.libraryMode = newValue === 'digital' ? 'digital' : 'vinyl';
            this.syncLibraryModeToggle();
        }
    }

    _attachDelegatedListeners() {
        this._onShadowClick = (e) => {
            // ── Botão de busca ──
            const searchBtn = e.target.closest('#btn-search');
            if (searchBtn) {
                e.preventDefault();
                this.openSearch();
                return;
            }

            // ── Nav links ──
            const navLink = e.target.closest('.nav-link');
            if (navLink) {
                e.preventDefault();
                if (this.isLocked) return;

                this.closeSearch();

                const tab = navLink.dataset.tab;
                if (!tab || this.activeTab === tab) return;

                this.setAttribute('active-tab', tab);
                this.dispatchEvent(new CustomEvent('rolfsound-navigate', {
                    bubbles: true, composed: true, detail: { view: tab }
                }));
                return;
            }

            // ── Filter buttons ──
            const filterBtn = e.target.closest('.filter-btn');
            if (filterBtn) {
                this.shadowRoot.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
                filterBtn.classList.add('active');

                this.dispatchEvent(new CustomEvent('rolfsound-filter', {
                    bubbles: true, composed: true, detail: { filter: filterBtn.dataset.filter }
                }));
                return;
            }
        };
        this.shadowRoot.addEventListener('click', this._onShadowClick);
    }

    updateActiveTab() {
        const links = this.shadowRoot.querySelectorAll('.nav-link');
        links.forEach(link => {
            link.classList.toggle('active', link.dataset.tab === this.activeTab);
        });

        if (this.activeTab === 'library') {
            this.deployLibraryModeToggle();
        } else {
            this.recolheLibraryModeToggle();
        }
    }

    syncLibraryModeToggle() {
        const pill = this.shadowRoot.getElementById('library-toggle-mitosis');
        if (!pill) return;

        pill.querySelectorAll('.pill-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === this.libraryMode);
        });
    }

    getMitosisMetrics(options = {}) {
        return measureIslandBarMitosis(this, {
            originTop: 15,
            originWidth: 450,
            originHeight: 38,
            copyGap: 7,
            extraDrop: 22,
            ...options
        });
    }

    cancelImpactResponse() {
        this._impactAnimations.forEach(animation => animation.cancel());
        this._impactAnimations.clear();
    }

    _trackImpactAnimation(animation) {
        if (!animation) return;

        this._impactAnimations.add(animation);

        const finalize = () => {
            this._impactAnimations.delete(animation);
        };

        animation.addEventListener('finish', finalize, { once: true });
        animation.addEventListener('cancel', finalize, { once: true });
    }

    respondToImpact(options = {}) {
        const container = this.shadowRoot.getElementById('bar-container');
        if (!container) return;

        const sharedOptions = {
            sourceRect: options.sourceRect || null,
            sourceVector: options.sourceVector || null,
            fallbackVector: options.fallbackVector || { x: 0, y: -1 },
            duration: options.duration,
            travel: options.travel,
            minTravel: options.minTravel,
            maxTravel: options.maxTravel,
            squash: options.squash,
            reboundRatio: options.reboundRatio,
            settleRatio: options.settleRatio
        };

        this.cancelImpactResponse();

        this._trackImpactAnimation(playElasticImpact(container, {
            ...sharedOptions,
            targetRect: container.getBoundingClientRect(),
            strength: Number.isFinite(options.strength) ? options.strength : 1
        }));

        const indicator = this.shadowRoot.getElementById('external-indicator');
        if (!indicator || getComputedStyle(indicator).display === 'none' || indicator.classList.contains('hidden')) {
            return;
        }

        this._trackImpactAnimation(playElasticImpact(indicator, {
            ...sharedOptions,
            targetRect: indicator.getBoundingClientRect(),
            strength: Math.max(0.2, (Number.isFinite(options.strength) ? options.strength : 1) * 0.24),
            maxTravel: 3
        }));
    }

    // ─── Motor de Mitose Modular (DOM Injection) ─────────────────────────────

    // ─────────────────────────────────────────────────────────────
    // MINIPLAYER SYNC
    // ─────────────────────────────────────────────────────────────

    /**
     * Registra listeners no PlaybackStateStore para controlar a visibilidade
     * do miniplayer. Chamado uma vez em connectedCallback.
     */
    _attachMiniplayerSync() {
        const store = window.playbackStore;
        if (!store) return;

        this._onStoreChange = () => this.reconcileMini();
        store.addEventListener('state-change', this._onStoreChange);
        store.addEventListener('queue-change', this._onStoreChange);
        store.addEventListener('track-change', this._onStoreChange);

        // Boot: se já há playback ativo ao montar a ilha, mostra sem animação
        // (o mini seria um refresh — não faz sentido a animação de birth aqui)
        if (store.hasActivePlayback() && this.activeTab !== 'playback') {
            const mini = document.querySelector('rolfsound-miniplayer');
            mini?.showInstant();
        }
    }

    /**
     * Decide se o miniplayer deve estar visível com base no estado atual.
     * Regras:
     *   - Aparece quando há playback ativo (currentId presente ou fila não-vazia)
     *     E o tab ativo não é 'playback' (o full player assume nesse caso)
     *   - Some quando não há playback ou quando o tab é 'playback'
     *
     * Fase 1: transições instantâneas.
     * Fases 2-3: este método acionará MiniBirthAnimator / MiniMorphAnimator.
     */
    reconcileMini() {
        const mini = document.querySelector('rolfsound-miniplayer');
        if (!mini) return;

        const store = window.playbackStore;
        const hasPlayback = store?.hasActivePlayback() ?? false;
        const onPlayback  = this.activeTab === 'playback';

        const shouldShow = hasPlayback && !onPlayback;

        if (shouldShow && !mini.isVisible) {
            // Verifica se o full player está aberto — se sim, não interfere
            if (window.playbackMitosisManager?.isMorphed) return;

            if (this._miniBirthAnimator._active) return;
            this._miniBirthAnimator.birth({ island: this, miniEl: mini });

        } else if (!shouldShow && mini.isVisible) {
            // Não absorve se o full player está em processo de abrir (MiniMorphAnimator ativo)
            if (window.playbackMitosisManager?.isMorphed) {
                mini.hideInstant();
                return;
            }
            if (this._miniBirthAnimator._active) return;
            this._miniBirthAnimator.absorb({ island: this, miniEl: mini });
        }
    }

    /**
     * Reflect playback state onto the island so CSS can react.
     * Drives the now-playing waveform indicator via :host([playing]).
     * Safe to call with the same state multiple times — no-op when unchanged.
     * @param {boolean} isPlaying
     */
    setNowPlayingState(isPlaying) {
        if (isPlaying) {
            this.setAttribute('playing', '');
        } else {
            this.removeAttribute('playing');
        }
    }

    mitosis(options) {
        this.setAttribute('inspecting', 'true');
        return AnimationEngine.mitosis(this, options);
    }

    undoMitosis(id = null) {
        const pills = AnimationEngine.undoMitosis(this, id, {
            timerProperty: '_animationTimers'
        });
        this.removeAttribute('inspecting');
        return pills;
    }

    // ─── Motor de Search (split-down) ────────────────────────────────────────

    openSearch() {
        if (this.isLocked) return;
        const hoverZone = this.shadowRoot.getElementById('hover-zone');
        if (!hoverZone) return;
        if (this.shadowRoot.getElementById('mitosis-search')) return;

        this.setAttribute('inspecting', 'true');

        const metrics = this.getMitosisMetrics();
        const searchDrop = Math.max(55, metrics.originHeight + 17);

        return AnimationEngine.runMitosisStrategy('search-open', { island: this }, {
            parent: hoverZone,
            searchDrop,
            timerProperty: '_animationTimers',
            containerHTML: `
            <div class="search-bar">
                <div class="search-icon-static">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none">
                        <circle cx="11" cy="11" r="8"/>
                        <path d="m21 21-4.35-4.35"/>
                    </svg>
                </div>
                <input id="search-input" class="search-input" type="text" placeholder="Search..." autocomplete="off" spellcheck="false" />
                <div class="search-state" data-state="idle" aria-live="polite">
                    <span class="search-state-dot"></span>
                    <span class="search-state-label"></span>
                </div>
                <span class="search-kbd" aria-hidden="true">esc</span>
                <button class="search-close hover-target" aria-label="Fechar busca">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="pointer-events:none">
                        <path d="M18 6 6 18M6 6l12 12"/>
                    </svg>
                </button>
            </div>
        `,
            onCreate: (pill) => {
                pill.querySelector('.search-close').addEventListener('click', (event) => {
                    event.stopPropagation();
                    this.closeSearch();
                });

                pill.querySelector('#search-input').addEventListener('keydown', (event) => {
                    if (event.key === 'Escape') this.closeSearch();
                    // Allow ↓ to move focus into the results panel
                    if (event.key === 'ArrowDown') {
                        event.preventDefault();
                        document.querySelector('rolfsound-search-results')?.focusFirst();
                    }
                });

                pill.querySelector('#search-input').addEventListener('input', (event) => {
                    this.dispatchEvent(new CustomEvent('rolfsound-search', {
                        bubbles: true,
                        composed: true,
                        detail: { query: event.target.value }
                    }));
                });

                const btnRect = this.shadowRoot.getElementById('btn-search').getBoundingClientRect();
                const zoneRect = hoverZone.getBoundingClientRect();
                const offset = (btnRect.left + btnRect.width / 2) - (zoneRect.left + zoneRect.width / 2);
                pill.style.setProperty('--search-x-offset', `${offset}px`);

                // State pill — driven by search-results events
                const stateEl = pill.querySelector('.search-state');
                const labelEl = pill.querySelector('.search-state-label');
                this._searchResultsListener = (e) => {
                    const { state = 'idle', library = [], youtube = [], error } = e.detail || {};
                    stateEl.dataset.state = state;
                    if      (state === 'loading')   labelEl.textContent = 'Searching';
                    else if (state === 'streaming') labelEl.textContent = 'Streaming';
                    else if (state === 'done')      labelEl.textContent = `${library.length + youtube.length} results`;
                    else if (state === 'error')     labelEl.textContent = error || 'Error';
                    else                            labelEl.textContent = '';
                };
                window.addEventListener('rolfsound-search-results', this._searchResultsListener);

                // Notify layout coordinator that search is open; it will apply modal mode.
                // On the next frame, add .modal to the pill so it widens to match the shell.
                window.dispatchEvent(new CustomEvent('rolfsound-search-open', { bubbles: true }));
                requestAnimationFrame(() => pill.classList.add('modal'));
            }
        });
    }

    closeSearch() {
        const pill = this.shadowRoot.getElementById('mitosis-search');
        if (!pill) return;

        this.removeAttribute('inspecting');

        if (this._searchResultsListener) {
            window.removeEventListener('rolfsound-search-results', this._searchResultsListener);
            this._searchResultsListener = null;
        }

        // Remove modal class before the reverse mitosis so the pill narrows back
        pill.classList.remove('modal');

        // Notify layout coordinator before animation so it can restore player position
        window.dispatchEvent(new CustomEvent('rolfsound-search-close', { bubbles: true }));

        return AnimationEngine.runMitosisStrategy('search-close', { island: this }, {
            pill,
            timerProperty: '_animationTimers',
            onStart: (node) => {
                const closeBtn = node.querySelector('.hover-target');
                if (closeBtn) closeBtn.classList.remove('hover-target');
            },
            getImpactOptions: ({ impactRect }) => ({
                sourceRect: impactRect,
                fallbackVector: { x: 0, y: -1 },
                strength: 0.9
            })
        });
    }

    // ─── Motor de Library Mode Toggle (Mitose para direita) ──────────────────────────────

    deployLibraryModeToggle() {
        const existingPill = this.shadowRoot.getElementById('library-toggle-mitosis');
        if (existingPill) {
            this.syncLibraryModeToggle();
            return;
        }

        const hoverZone = this.shadowRoot.getElementById('hover-zone');
        if (!hoverZone) return;

        return AnimationEngine.runMitosisStrategy('division-lite-open', { island: this }, {
            owner: this,
            parent: hoverZone,
            containerId: 'library-toggle-mitosis',
            className: 'mitosis-pill',
            splitClass: null,
            timerProperty: '_animationTimers',
            containerHTML: `
            <div class="pill-content">
                <button class="pill-btn hover-target ${this.libraryMode === 'vinyl' ? 'active' : ''}" data-mode="vinyl">Vinyl</button>
                <button class="pill-btn hover-target ${this.libraryMode === 'digital' ? 'active' : ''}" data-mode="digital">Digital</button>
            </div>
        `,
            cssVars: {
                '--pill-w': '176px',
                '--pill-h': '38px'
            },
            growDelayMs: 12,
            revealDelayMs: 100,
            settleTimeoutMs: 300,
            onCreate: (pill) => {
                pill.querySelectorAll('.pill-btn').forEach(btn => {
                    btn.addEventListener('click', (event) => {
                        event.stopPropagation();
                        const mode = btn.dataset.mode === 'digital' ? 'digital' : 'vinyl';
                        if (mode === this.libraryMode) return;

                        this.setAttribute('library-mode', mode);
                        this.closeSearch();
                        this.dispatchEvent(new CustomEvent('rolfsound-library-mode-change', {
                            bubbles: true,
                            composed: true,
                            detail: { mode }
                        }));
                    });
                });
            },
            onGrow: (pill) => {
                const hostRect = this.getBoundingClientRect();
                const pillRect = pill.getBoundingClientRect();
                const targetRight = 80;
                const localLeft = (window.innerWidth - targetRight - pillRect.width) - hostRect.left;
                const localTop = 0;

                pill.style.setProperty('--pill-left', `${Math.round(localLeft)}px`);
                pill.style.setProperty('--pill-top', `${Math.round(localTop)}px`);
                pill.classList.add('positioned');
            }
        });
    }

    recolheLibraryModeToggle() {
        const pill = this.shadowRoot.getElementById('library-toggle-mitosis');
        if (!pill) return;

        return AnimationEngine.runMitosisStrategy('division-lite-close', { island: this }, {
            owner: this,
            pill,
            collapseClassName: null,
            timerProperty: '_animationTimers',
            absorbDelayMs: 90,
            onStart: (node) => {
                node.style.opacity = '0';
                node.style.transform = 'scale(0.6)';
                node.style.pointerEvents = 'none';
            }
        });
    }

    morph(options) {
        const { width, height = 44, radius = 'var(--radius-dynamic-island)', viewId, islandClass = '', duration = 0 } = options;

        const container          = this.shadowRoot.getElementById('bar-container');
        const navContent         = this.shadowRoot.getElementById('bar-content');
        const filtersDrawer      = this.shadowRoot.getElementById('filters-drawer');
        const externalIndicator  = this.shadowRoot.getElementById('external-indicator');
        const targetView         = this.shadowRoot.getElementById(viewId);
        const allViews           = this.shadowRoot.querySelectorAll('.island-view');

        AnimationEngine.clearScheduled(this, '_morphTimer');
        this.isLocked = (duration === 0);

        navContent.classList.add('hidden');
        filtersDrawer.classList.add('hidden');
        externalIndicator.classList.add('hidden');
        allViews.forEach(v => { if (v.id !== viewId) v.classList.remove('visible'); });

        if (islandClass) container.className = islandClass;
        container.style.setProperty('--island-width',  typeof width  === 'number' ? `${width}px`  : width);
        container.style.setProperty('--island-height', typeof height === 'number' ? `${height}px` : height);
        container.style.setProperty('--island-radius', typeof radius === 'number' ? `${radius}px` : radius);

        AnimationEngine.schedule(this, () => {
            navContent.style.display = 'none';
            allViews.forEach(v => { if (v.id !== viewId) v.style.display = 'none'; });

            if (targetView) {
                targetView.style.display = 'flex';
                void targetView.offsetWidth;
                targetView.classList.add('visible');
            }
        }, 200, '_animationTimers');

        if (duration > 0) {
            AnimationEngine.schedule(this, () => this.reset({
                bounce: true,
                sourceVector: { x: 0, y: -1 },
                strength: 0.9
            }), duration, '_morphTimer');
        }
    }

    reset(options = {}) {
        const container         = this.shadowRoot.getElementById('bar-container');
        const navContent        = this.shadowRoot.getElementById('bar-content');
        const filtersDrawer     = this.shadowRoot.getElementById('filters-drawer');
        const externalIndicator = this.shadowRoot.getElementById('external-indicator');
        const allViews          = this.shadowRoot.querySelectorAll('.island-view');
        const {
            bounce = false,
            sourceRect = null,
            sourceVector = null,
            strength = 0.9,
            fallbackVector = { x: 0, y: -1 }
        } = options;

        AnimationEngine.clearScheduled(this, '_morphTimer');

        this.isLocked = false;
        allViews.forEach(v => v.classList.remove('visible'));

        AnimationEngine.schedule(this, () => {
            let impactSettled = false;
            let impactSafetyId = null;

            const triggerImpact = () => {
                if (!bounce || impactSettled) return;
                impactSettled = true;
                if (impactSafetyId) clearTimeout(impactSafetyId);
                this.respondToImpact({ sourceRect, sourceVector, strength, fallbackVector });
            };

            const onTransitionEnd = (e) => {
                if (e.target !== container) return;
                if (!['width', 'height', 'border-radius'].includes(e.propertyName)) return;
                container.removeEventListener('transitionend', onTransitionEnd);
                triggerImpact();
            };

            if (bounce) {
                container.addEventListener('transitionend', onTransitionEnd);
                impactSafetyId = AnimationEngine.schedule(this, () => {
                    container.removeEventListener('transitionend', onTransitionEnd);
                    triggerImpact();
                }, 580, '_animationTimers');
            }

            allViews.forEach(v => v.style.display = 'none');
            navContent.style.display = 'flex';

            container.className = '';
            container.style.removeProperty('--island-width');
            container.style.removeProperty('--island-height');
            container.style.removeProperty('--island-radius');

            void navContent.offsetWidth;
            navContent.classList.remove('hidden');
            filtersDrawer.classList.remove('hidden');
            externalIndicator.classList.remove('hidden');
        }, 200, '_animationTimers');
    }

    hideNotification(options = {}) {
        const immediate = !!options.immediate;
        const toast = this.shadowRoot.getElementById('mitosis-toast');
        AnimationEngine.clearScheduled(this, '_notificationTimers');
        if (!toast) return;

        if (immediate) {
            toast.remove();
            return;
        }

        AnimationEngine.runMitosisStrategy('division-lite-close', { island: this }, {
            owner: this,
            pill: toast,
            removalDelay: 280,
            absorbDelayMs: 70,
            collapseClassName: null,
            timerProperty: '_notificationTimers',
            removeHoverTargets: false
        });
    }

    showNotification({ text = 'Notification', spinner = false, duration = 3000 }) {
        const hoverZone = this.shadowRoot.getElementById('hover-zone');
        if (!hoverZone) return;

        AnimationEngine.clearScheduled(this, '_notificationTimers');

        const setToastContent = (toastNode) => {
            const icon = toastNode.querySelector('[data-toast-icon]');
            const msg = toastNode.querySelector('[data-toast-text]');
            if (msg) msg.textContent = text;
            if (icon) {
                icon.innerHTML = spinner ? '<div class="mitosis-toast-spinner"></div>' : '<span class="mitosis-toast-dot">•</span>';
            }
        };

        const existing = this.shadowRoot.getElementById('mitosis-toast');
        if (existing) {
            setToastContent(existing);
        } else {
            const width = Math.min(460, Math.max(220, (text || '').length * 7 + 80));
            AnimationEngine.runMitosisStrategy('division-lite-open', { island: this }, {
                owner: this,
                parent: hoverZone,
                containerId: 'mitosis-toast',
                className: 'mitosis-pill toast-pill',
                splitClass: 'split-down',
                cssVars: {
                    '--pill-w': `${width}px`,
                    '--pill-h': '36px',
                    '--mitosis-distance': '52px'
                },
                containerHTML: `
                  <div class="mitosis-toast-content" role="status" aria-live="polite">
                    <span class="mitosis-toast-icon" data-toast-icon></span>
                    <span class="mitosis-toast-text" data-toast-text></span>
                  </div>
                `,
                onCreate: (toastNode) => setToastContent(toastNode),
                growDelayMs: 12,
                revealDelayMs: 110,
                settleTimeoutMs: 380,
                timerProperty: '_notificationTimers'
            });
        }

        if (duration > 0) {
            AnimationEngine.schedule(this, () => this.hideNotification(), duration, '_notificationTimers');
        }
    }

    updateNotificationText(text) {
        const toast = this.shadowRoot.getElementById('mitosis-toast');
        if (!toast) return;
        const msg = toast.querySelector('[data-toast-text]');
        if (!msg) return;
        if (msg.textContent === text) return;
        msg.textContent = text;
    }

    cancelPlaylistNamePrompt(value = null, immediate = false) {
        const inputPill = this.shadowRoot.getElementById('mitosis-playlist-input');
        const resolver = this._promptResolver;
        this._promptResolver = null;

        if (!inputPill) {
            if (resolver) resolver(value);
            return;
        }

        if (immediate) {
            inputPill.remove();
            if (resolver) resolver(value);
            return;
        }

        AnimationEngine.runMitosisStrategy('division-lite-close', { island: this }, {
            owner: this,
            pill: inputPill,
            collapseClassName: null,
            removalDelay: 280,
            absorbDelayMs: 70,
            timerProperty: '_animationTimers',
            removeHoverTargets: false,
            onComplete: () => {
                if (resolver) resolver(value);
            }
        });
    }

    promptPlaylistName(options = {}) {
        const title = options.title || 'New playlist';
        const placeholder = options.placeholder || 'Playlist name';
        const confirmLabel = options.confirmLabel || 'Create';
        const hoverZone = this.shadowRoot.getElementById('hover-zone');

        if (!hoverZone) return Promise.resolve('');

        this.cancelPlaylistNamePrompt('', true);

        return new Promise((resolve) => {
            this._promptResolver = resolve;

            AnimationEngine.runMitosisStrategy('division-lite-open', { island: this }, {
                owner: this,
                parent: hoverZone,
                containerId: 'mitosis-playlist-input',
                className: 'mitosis-pill input-pill',
                splitClass: 'split-down',
                cssVars: {
                    '--pill-w': 'min(460px, calc(100vw - 80px))',
                    '--pill-h': '52px',
                    '--mitosis-distance': '56px'
                },
                containerHTML: `
                  <div class="mitosis-input-shell">
                    <span class="mitosis-input-title">${title}</span>
                    <input type="text" class="mitosis-input-field" maxlength="80" placeholder="${placeholder}" />
                    <button type="button" class="mitosis-input-btn hover-target" data-confirm>${confirmLabel}</button>
                    <button type="button" class="mitosis-input-btn hover-target" data-cancel>Cancel</button>
                  </div>
                `,
                onCreate: (node) => {
                    const input = node.querySelector('.mitosis-input-field');
                    const onConfirm = () => {
                        const value = (input?.value || '').trim();
                        this.cancelPlaylistNamePrompt(value || '');
                    };
                    const onCancel = () => this.cancelPlaylistNamePrompt('');

                    node.querySelector('[data-confirm]')?.addEventListener('click', onConfirm);
                    node.querySelector('[data-cancel]')?.addEventListener('click', onCancel);
                    input?.addEventListener('keydown', (event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            onConfirm();
                        }
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            onCancel();
                        }
                    });

                    AnimationEngine.schedule(this, () => input?.focus(), 240, '_animationTimers');
                },
                growDelayMs: 14,
                revealDelayMs: 130,
                settleTimeoutMs: 420,
                timerProperty: '_animationTimers'
            });
        });
    }

    render() {
        this.shadowRoot.innerHTML = `
        <style>
            * { cursor: none !important; font-family: var(--font, sans-serif); box-sizing: border-box; }

            :host {
                display: block;
                --black-studio: var(--color-bg-elevated-strong);
                --white: var(--color-base-white-strong);
                --gray: var(--color-text-muted);
                --border-metal: var(--color-border-subtle);
                --border-metal-bright: var(--color-border-strong);
                position: fixed; top: 15px; left: 50%; transform: translateX(-50%);
                z-index: 1000; pointer-events: none;

                --default-w: 450px;
                --default-h: 38px;
                --default-r: var(--radius-dynamic-island);
            }

            #hover-zone {
                display: flex; flex-direction: column; align-items: center;
                padding: 10px 20px 40px 20px;
                margin: -10px -20px -40px -20px;
                pointer-events: auto;
                position: relative; /* Importante para a mitose ficar ancorada aqui */
            }

            /* Desativa o Hover de abrir o Menu de Filtros se estiver Inspecionando um disco */
            :host([active-tab="library"][library-mode="vinyl"]:not([inspecting])) #hover-zone:hover #bar-container:not(.notifying) {
                --default-h: 90px;
                --default-r: var(--radius-dynamic-island-expanded);
            }

            /* ─── MOTOR DE MITOSE (Custom Properties) ───
                --pill-w: largura (default 38px)
                --pill-h: altura  (default 38px)
                --pill-r: radius  (default = mesmo raio da ilha dinâmica)
                --pill-top/--pill-left: posição fixa (modo positioned)
            */
            .mitosis-pill {
                position: absolute;
                top: 10px; 
                left: 50%;
                width: var(--pill-w, 38px);
                height: var(--pill-h, 38px);
                border-radius: var(--pill-r, var(--default-r));
                background: var(--black-studio);
                backdrop-filter: blur(var(--blur-glass)); -webkit-backdrop-filter: blur(var(--blur-glass));
                border: 1px solid var(--border-metal);
                display: flex; align-items: center; justify-content: center;
                
                opacity: 0; pointer-events: none;
                transform: translateX(-50%) scale(0.6);
                transition: all 0.5s var(--ease-spring);
                z-index: 900; 
                box-shadow: var(--shadow-soft);
                overflow: hidden;
            }
            .mitosis-pill.split-right {
                transform: translateX(calc(-50% + var(--mitosis-distance, 237px))) scale(1);
                opacity: 1; pointer-events: auto;
            }
            .mitosis-pill.split-left {
                transform: translateX(calc(-50% - var(--mitosis-distance, 237px))) scale(1);
                opacity: 1; pointer-events: auto;
            }
            /* Modo posicionado: a pill vai para uma posição fixa na viewport */
            .mitosis-pill.positioned {
                position: fixed;
                left: var(--pill-left, 0px);
                top: var(--pill-top, 15px);
                transform: scale(1);
                opacity: 1; pointer-events: auto;
            }
            .mitosis-btn { 
                color: var(--gray); transition: color 0.2s ease, background 0.2s ease; 
                width: 100%; height: 100%; border-radius: 50%;
                display: flex; align-items: center; justify-content: center; 
            }
            .mitosis-btn:hover { color: var(--white); background: var(--color-surface-interactive); }

            /* ─ Pill content utils ─ */
            .pill-content {
                display: flex; align-items: center; gap: 6px;
                padding: 0 8px; width: 100%; height: 100%; justify-content: center;
                opacity: 0; transition: opacity 0.25s ease 0.3s;
            }
            .mitosis-pill.positioned .pill-content,
            .mitosis-pill.split-right .pill-content,
            .mitosis-pill.split-left .pill-content { opacity: 1; }

            .pill-btn {
                background: transparent; border: 1px solid transparent;
                color: var(--gray); border-radius: 12px; padding: 6px 14px;
                font-size: var(--fs-xs, 9px); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
                line-height: 1;
                display: inline-flex; align-items: center; justify-content: center;
                transition: all 0.2s ease; white-space: nowrap;
            }
            .pill-btn:hover  { color: var(--white); }
            .pill-btn.active {
                background: transparent;
                color: var(--white);
                border-color: var(--color-border-strong);
            }


            /* ─── ILHA PRINCIPAL ─── */
            #bar-container {
                background: var(--black-studio);
                backdrop-filter: blur(var(--blur-glass)); -webkit-backdrop-filter: blur(var(--blur-glass));
                border: 1px solid var(--border-metal);

                width: var(--island-width, var(--default-w));
                height: var(--island-height, var(--default-h));
                border-radius: var(--island-radius, var(--default-r));

                display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
                padding: 0 10px; box-shadow: var(--shadow-soft);

                transition: width  0.5s var(--ease-spring),
                            height 0.5s var(--ease-spring),
                            border-radius 0.5s var(--ease-spring),
                            background-color 0.5s ease, border-color 0.5s ease, box-shadow 0.5s ease;

                position: relative; z-index: 1000;
            }

            :host([division-shell]) #bar-container {
                /* Island stays fully opaque during division. The membrane SVG
                   (z-995) sits below the island (z-1000) so only the neck
                   between parent and child is visible from the membrane.
                   We only suppress backdrop-filter to avoid blurring the
                   membrane underneath the island's stacking context. */
                backdrop-filter: none;
                -webkit-backdrop-filter: none;
            }

            #bar-container.notifying {
                background: var(--color-bg-overlay-strong);
                border-color: var(--border-metal-bright);
                box-shadow: var(--shadow-notification);
            }

            #bar-content {
                display: flex; align-items: center; justify-content: space-between;
                width: 100%; height: 38px; min-height: 38px;
                opacity: 1; transform: scale(1);
                transition: opacity 0.3s ease, transform 0.4s var(--ease-standard);
                position: relative; z-index: 1200;
            }
            #bar-content.hidden { opacity: 0; transform: scale(0.95); }

            /* Indicador Externo ("Filters") */
            #external-indicator {
                display: none; flex-direction: column; align-items: center; gap: 4px;
                margin-top: 8px; transition: opacity 0.3s ease, transform 0.3s ease;
            }
            
            /* Some com o texto de Filters se a Ilha estiver no modo Inspecting */
            :host([inspecting]) #external-indicator,
            :host([active-tab="library"][library-mode="vinyl"]:not([inspecting])) #hover-zone:hover #external-indicator {
                opacity: 0; transform: translateY(10px); pointer-events: none;
            }
            #external-indicator.hidden { opacity: 0 !important; pointer-events: none; }
            :host([active-tab="library"][library-mode="vinyl"]) #external-indicator { display: flex; }

            .indicator-line  { width: 24px; height: 2px; background: var(--color-text-faint); border-radius: 2px; }
            .indicator-text  { font-size: var(--fs-2xs, 8px); font-weight: 700; letter-spacing: 0.15em; color: var(--gray); text-transform: uppercase; }

            #filters-drawer {
                position: absolute; bottom: 18px;
                display: flex; gap: 6px; justify-content: center; align-items: center;
                opacity: 0; pointer-events: none; transform: translateY(10px);
                transition: all 0.4s var(--ease-spring);
                width: 100%;
            }
            #filters-drawer.hidden { display: none; }
            :host(:not([library-mode="vinyl"])) #filters-drawer { display: none; }

            :host([active-tab="library"][library-mode="vinyl"]:not([inspecting])) #hover-zone:hover #bar-container:not(.notifying) #filters-drawer {
                opacity: 1; pointer-events: auto; transform: translateY(0);
            }

            .filter-btn {
                background: var(--color-surface-interactive); border: 1px solid var(--color-border-interactive);
                color: var(--gray); border-radius: 12px; padding: 6px 10px;
                font-size: var(--fs-xs, 9px); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
                transition: all 0.2s ease; white-space: nowrap;
            }
            .filter-btn:hover  { background: var(--color-surface-interactive-hover); color: var(--white); }
            .filter-btn.active { background: var(--color-surface-inverse); color: var(--black); border-color: var(--color-surface-inverse); }

            .island-view {
                display: none; position: absolute; inset: 0;
                align-items: center; justify-content: center; gap: 12px;
                opacity: 0; transform: scale(0.9);
                transition: opacity 0.3s ease, transform 0.4s var(--ease-spring);
                z-index: 1300;
            }
            .island-view.visible { opacity: 1; transform: scale(1); }

            #notif-text { font-size: var(--fs-md, 11px); font-weight: 600; color: var(--white); letter-spacing: 0.05em; white-space: nowrap; }
            .spinner    { width: 14px; height: 14px; border: 2px solid var(--color-surface-interactive); border-top-color: var(--white); border-radius: 50%; animation: spin 0.8s linear infinite; }
            @keyframes spin { to { transform: rotate(360deg); } }

            .logo-section { display: flex; align-items: center; gap: 8px; margin-left: 8px; position: relative; z-index: 1200; }
            .logo-name    { font-weight: 700; font-size: var(--fs-sm, 10px); letter-spacing: 1.5px; text-transform: uppercase; color: var(--white); }

            /* ─── Now Playing Indicator (replaces static LED dot) ─── */
            .now-playing-indicator {
                display: flex;
                align-items: flex-end;
                gap: 2px;
                height: 10px;
                width: 13px;
                flex-shrink: 0;
            }

            .now-playing-indicator span {
                display: block;
                width: 2.5px;
                border-radius: 1.5px;
                background: var(--color-led);
                height: 3px; 
                transition: height 0.08s ease-out; 
            }

            .nav-section {
                display: flex; gap: 2px;
                position: absolute; left: 50%; transform: translateX(-50%);
                z-index: 1200;
            }

            .nav-link {
                color: var(--gray); text-decoration: none; font-size: var(--fs-xs, 9px); text-transform: uppercase;
                letter-spacing: 0.1em; padding: 6px 12px; border-radius: 16px;
                transition: all 0.2s ease; background: transparent; border: 1px solid transparent;
                position: relative; z-index: 1200;
                display: flex; align-items: center;
            }
            .nav-link:hover, .nav-link.active { color: var(--white); }
            .nav-link.active { font-weight: 600; background: var(--color-surface-interactive); }

            .nav-icon { flex-shrink: 0; color: inherit; transition: opacity 0.25s ease; }
            .nav-link:hover .nav-icon  { opacity: 0.55; }
            .nav-link.active .nav-icon { opacity: 0.8; }

            .nav-label {
                max-width: 0; overflow: hidden; opacity: 0; white-space: nowrap; margin-left: 0;
                transition: max-width 0.4s var(--ease-spring),
                            opacity 0.3s ease,
                            margin-left 0.4s var(--ease-spring);
            }
            .nav-link:hover .nav-label,
            .nav-link.active  .nav-label { max-width: 90px; opacity: 1; margin-left: 7px; }

            /* ─── EQ Bars animados (Now Playing ativo) ─── */
            .eq-bar { transform-box: fill-box; transform-origin: bottom center; }
            .nav-link[data-tab="playback"].active .eq-bar-1 { animation: eq 0.80s ease-in-out infinite; }
            .nav-link[data-tab="playback"].active .eq-bar-2 { animation: eq 0.55s ease-in-out infinite 0.12s; }
            .nav-link[data-tab="playback"].active .eq-bar-3 { animation: eq 0.95s ease-in-out infinite 0.07s; }
            @keyframes eq { 0%, 100% { transform: scaleY(0.3); } 50% { transform: scaleY(1); } }

            .icon-link { display: flex; align-items: center; justify-content: center; padding: 6px; margin-right: 4px; }
            .icon-link svg { transition: transform 0.4s var(--ease-spring); }
            .icon-link:hover svg, .icon-link.active svg { transform: rotate(90deg); }

            /* ─── Lado direito da barra ─── */
            .right-section { display: flex; align-items: center; }

            /* ─── Motor de Search (split-down) ─── */
            .mitosis-pill.split-down {
                transform: translateX(calc(-50% + var(--search-x-offset, 0px))) translateY(var(--mitosis-distance, 55px)) scale(1);
                opacity: 1; pointer-events: auto;
            }
            .mitosis-pill.search-expanded {
                width: 560px;
                border-radius: var(--pill-r, var(--default-r));
                transform: translateX(-50%) translateY(var(--mitosis-distance, 55px)) scale(1);
                transition: width 0.34s var(--ease-standard);
            }
            .mitosis-pill.search-expanded.modal {
                width: var(--search-modal-w, min(760px, calc(100vw - 64px)));
            }
            :host([inspecting]) #btn-search { opacity: 0; pointer-events: none; transform: scale(0.7); transition: opacity 0.2s ease, transform 0.2s ease; }
            #btn-search { transition: opacity 0.2s ease, transform 0.2s ease; }
            .search-bar {
                display: flex; align-items: center;
                padding: 0 10px 0 14px;
                width: 100%; height: 100%;
                gap: 8px; overflow: hidden;
            }
            .search-icon-static {
                flex-shrink: 0; color: var(--gray);
                display: flex; align-items: center; justify-content: center;
            }
            .search-input {
                flex: 1; min-width: 0;
                background: transparent; border: none; outline: none;
                color: var(--white); font-size: var(--fs-md, 11px); font-family: var(--font, sans-serif);
                letter-spacing: 0.04em;
                opacity: 0; transform: translateX(-8px); pointer-events: none;
                transition: opacity 0.25s ease 0.3s, transform 0.3s var(--ease-spring) 0.3s;
            }
            .search-input::placeholder { color: var(--gray); }
            .mitosis-pill.search-expanded .search-input { opacity: 1; transform: translateX(0); pointer-events: auto; }
            .search-close {
                flex-shrink: 0; background: none; border: none;
                color: var(--gray); border-radius: 50%;
                width: 24px; height: 24px;
                display: flex; align-items: center; justify-content: center;
                padding: 0;
                opacity: 0; transform: scale(0.5); pointer-events: none;
                transition: opacity 0.2s ease 0.35s, transform 0.25s var(--ease-spring) 0.35s,
                            color 0.15s ease, background 0.15s ease;
            }
            .search-close:hover { color: var(--white); background: var(--color-surface-card-hover); }
            .mitosis-pill.search-expanded .search-close { opacity: 1; transform: scale(1); pointer-events: auto; }

            /* ── State pill ── */
            .search-state {
                display: flex; align-items: center; gap: 5px;
                flex-shrink: 0;
                padding: 2px 7px;
                border-radius: var(--radius-full);
                background: var(--color-surface-interactive);
                color: var(--color-text-secondary);
                font-family: var(--font-mono);
                font-size: var(--fs-xs);
                letter-spacing: 0.06em;
                text-transform: uppercase;
                opacity: 0; transform: translateX(-4px);
                pointer-events: none;
                transition: opacity 0.18s ease, transform 0.22s var(--ease-spring);
            }
            .search-state[data-state="loading"],
            .search-state[data-state="streaming"],
            .search-state[data-state="done"],
            .search-state[data-state="error"] {
                opacity: 1; transform: translateX(0);
            }
            .search-state[data-state="error"] { color: var(--color-accent-danger); }
            .search-state-dot {
                width: 5px; height: 5px;
                border-radius: 50%;
                background: var(--rs-theme-glow, var(--color-text-control));
            }
            .search-state[data-state="loading"] .search-state-dot,
            .search-state[data-state="streaming"] .search-state-dot {
                animation: search-pulse 1.2s ease-in-out infinite;
            }
            .search-state[data-state="error"] .search-state-dot { background: var(--color-accent-danger); }
            @keyframes search-pulse { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }

            /* ── ESC kbd badge ── */
            .search-kbd {
                flex-shrink: 0;
                font-family: var(--font-mono);
                font-size: var(--fs-xs);
                padding: 1px 5px;
                border-radius: var(--radius-xs);
                border: 1px solid var(--color-border-subtle);
                background: var(--color-surface-ghost);
                color: var(--color-text-faint);
                letter-spacing: 0.06em;
                opacity: 0; transform: scale(0.8);
                transition: opacity 0.2s ease 0.4s, transform 0.25s var(--ease-spring) 0.4s;
            }
            .mitosis-pill.search-expanded .search-kbd { opacity: 1; transform: scale(1); }
            .mitosis-pill.search-expanded .search-bar:has(.search-state:not([data-state="idle"])) .search-kbd {
                opacity: 0; transform: scale(0.8); transition-delay: 0s;
            }

            .mitosis-pill.toast-pill {
                border-radius: var(--radius-dynamic-island);
                min-width: 220px;
                max-width: min(460px, calc(100vw - 80px));
                box-shadow: var(--shadow-notification);
                z-index: 930;
            }

            .mitosis-toast-content {
                width: 100%;
                height: 100%;
                padding: 0 12px;
                display: flex;
                align-items: center;
                gap: 8px;
                opacity: 0;
                transition: opacity 0.2s ease 0.18s;
            }

            .mitosis-pill.split-down .mitosis-toast-content { opacity: 1; }

            .mitosis-toast-icon {
                width: 14px;
                height: 14px;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                color: var(--white);
                flex-shrink: 0;
            }

            .mitosis-toast-dot {
                font-size: 14px;
                line-height: 1;
                opacity: 0.88;
            }

            .mitosis-toast-spinner {
                width: 12px;
                height: 12px;
                border: 2px solid var(--color-surface-interactive);
                border-top-color: var(--white);
                border-radius: 50%;
                animation: spin 0.7s linear infinite;
            }

            .mitosis-toast-text {
                min-width: 0;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                font-size: var(--fs-sm, 10px);
                color: var(--white);
                letter-spacing: 0.04em;
            }

            .mitosis-pill.input-pill {
                border-radius: var(--radius-dynamic-island-expanded);
                z-index: 935;
                max-width: min(460px, calc(100vw - 80px));
            }

            .mitosis-input-shell {
                width: 100%;
                height: 100%;
                display: grid;
                grid-template-columns: auto 1fr auto auto;
                align-items: center;
                gap: 7px;
                padding: 0 10px;
                opacity: 0;
                transition: opacity 0.2s ease 0.2s;
            }

            .mitosis-pill.split-down .mitosis-input-shell {
                opacity: 1;
            }

            .mitosis-input-title {
                font-size: var(--fs-xs, 9px);
                color: var(--color-text-muted);
                text-transform: uppercase;
                letter-spacing: 0.09em;
                white-space: nowrap;
            }

            .mitosis-input-field {
                min-width: 0;
                width: 100%;
                height: 30px;
                border-radius: var(--radius-lg);
                border: 1px solid var(--color-border-default);
                background: rgba(255, 255, 255, 0.04);
                color: var(--white);
                padding: 0 8px;
                font-size: var(--fs-sm, 10px);
                outline: none;
            }

            .mitosis-input-field::placeholder {
                color: var(--color-text-muted);
            }

            .mitosis-input-field:focus {
                border-color: var(--color-border-stronger);
                background: rgba(255, 255, 255, 0.06);
            }

            .mitosis-input-btn {
                height: 30px;
                border-radius: var(--radius-lg);
                border: 1px solid var(--color-border-default);
                background: var(--color-surface-interactive);
                color: var(--color-text-secondary);
                padding: 0 9px;
                font-size: var(--fs-xs, 9px);
                text-transform: uppercase;
                letter-spacing: 0.06em;
                cursor: none;
                white-space: nowrap;
                transition: all 0.16s ease;
            }

            .mitosis-input-btn:hover {
                color: var(--white);
                border-color: var(--color-border-stronger);
                background: var(--color-surface-interactive-hover);
            }
        </style>

        <div id="hover-zone">
            <div id="bar-container">
                <div id="bar-content">
                    <div class="logo-section">
                        <div class="now-playing-indicator" aria-hidden="true">
                            <span></span><span></span><span></span>
                        </div>
                        <span class="logo-name">Rolfsound</span>
                    </div>

                    <div class="nav-section">
                        <a href="#" class="nav-link hover-target ${this.activeTab === 'library'  ? 'active' : ''}" data-tab="library">
                            <svg class="nav-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="pointer-events:none">
                                <circle cx="12" cy="12" r="10"/>
                                <circle cx="12" cy="12" r="4"/>
                                <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/>
                            </svg>
                            <span class="nav-label">Library</span>
                        </a>
                        <a href="#" class="nav-link hover-target ${this.activeTab === 'playback' ? 'active' : ''}" data-tab="playback">
                            <svg class="nav-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="pointer-events:none">
                                <rect class="eq-bar eq-bar-1" x="2"  y="9"  width="4" height="12" rx="1.5"/>
                                <rect class="eq-bar eq-bar-2" x="10" y="4"  width="4" height="17" rx="1.5"/>
                                <rect class="eq-bar eq-bar-3" x="18" y="12" width="4" height="9"  rx="1.5"/>
                            </svg>
                            <span class="nav-label">Now Playing</span>
                        </a>
                    </div>

                    <div class="right-section">
                        <a href="#" id="btn-search" class="nav-link icon-link hover-target" aria-label="Abrir pesquisa">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none">
                                <circle cx="11" cy="11" r="8"/>
                                <path d="m21 21-4.35-4.35"/>
                            </svg>
                        </a>
                        <a href="#" class="nav-link icon-link hover-target ${this.activeTab === 'settings' ? 'active' : ''}" data-tab="settings">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;">
                                <circle cx="12" cy="12" r="3"></circle>
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                            </svg>
                        </a>
                    </div>
                </div>

                <div id="filters-drawer">
                    <button class="filter-btn active hover-target" data-filter="all">All</button>
                    <button class="filter-btn hover-target" data-filter="new">✦ New</button>
                    <button class="filter-btn hover-target" data-filter="frequent">⟳ Frequent</button>
                    <button class="filter-btn hover-target" data-filter="era">◷ Era</button>
                    <button class="filter-btn hover-target" data-filter="palette">◐ Palette</button>
                </div>

                <div id="view-notification" class="island-view">
                    <div id="notif-icon"></div>
                    <span id="notif-text"></span>
                </div>
            </div>

            <div id="external-indicator">
                <div class="indicator-line"></div>
                <span class="indicator-text">Filters</span>
            </div>
        </div>
        `;
    }
}

customElements.define('rolfsound-island', RolfsoundIsland);

// static/js/RolfsoundIsland.js

class RolfsoundIsland extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });

        this.activeTab   = this.getAttribute('active-tab') || 'library';
        this.morphTimeout = null;
        this.isLocked    = false;
        this._listenersAttached = false;
    }

    static get observedAttributes() {
        return ['active-tab'];
    }

    connectedCallback() {
        this.render();

        if (!this._listenersAttached) {
            this._attachDelegatedListeners();
            this._listenersAttached = true;
        }

        this.reset();
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'active-tab' && oldValue !== newValue) {
            this.activeTab = newValue;
            this.updateActiveTab();
        }
    }

    _attachDelegatedListeners() {
        this.shadowRoot.addEventListener('click', (e) => {
            // ── Nav links ──
            const navLink = e.target.closest('.nav-link');
            if (navLink) {
                e.preventDefault();
                if (this.isLocked) return;

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
            }
        });
    }

    addEventListeners() {}

    updateActiveTab() {
        const links = this.shadowRoot.querySelectorAll('.nav-link');
        links.forEach(link => {
            link.classList.toggle('active', link.dataset.tab === this.activeTab);
        });
    }

    // ─── Motor de Mitose Modular (DOM Injection) ─────────────────────────────

    mitosis(options) {
        // Trava a ilha principal (esconde o "Filters" e impede o hover de expandir)
        this.setAttribute('inspecting', 'true'); 

        const { 
            id = 'default', 
            icon = '', 
            eventName = 'rolfsound-mitosis-click', 
            direction = 'right', 
            distance = 237 
        } = options;

        const hoverZone = this.shadowRoot.getElementById('hover-zone');
        
        // Evita criar duplicatas se a função for chamada acidentalmente duas vezes
        if (this.shadowRoot.getElementById(`mitosis-${id}`)) return;

        // Constrói o botão do zero na memória
        const pill = document.createElement('div');
        pill.id = `mitosis-${id}`;
        pill.className = `mitosis-pill`;
        pill.style.setProperty('--mitosis-distance', `${distance}px`);
        
        pill.innerHTML = `
            <div class="mitosis-btn hover-target">
                ${icon}
            </div>
        `;

        // Atrela o evento dinâmico diretamente ao botão gerado
        pill.addEventListener('click', (e) => {
            e.stopPropagation(); // Impede que o clique vaze para outros elementos
            this.dispatchEvent(new CustomEvent(eventName, { bubbles: true, composed: true }));
        });

        // Insere fisicamente no início do hover-zone (para ficar atrás da Ilha Principal)
        hoverZone.insertBefore(pill, hoverZone.firstChild);

        // Força a renderização do navegador e dispara a animação CSS deslizando para o lado
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                pill.classList.add(`split-${direction}`);
            });
        });
    }

    undoMitosis(id = null) {
        // Se passar um ID, recolhe aquele. Se não, recolhe todos os botões de mitose abertos na tela.
        const selector = id ? `#mitosis-${id}` : '.mitosis-pill';
        const pills = this.shadowRoot.querySelectorAll(selector);

        pills.forEach(pill => {
            // ─── O DESARME DO CURSOR ───
            // Arranca a classe magnética do botão interno para o cursor soltar na mesma hora
            const btnInterno = pill.querySelector('.hover-target');
            if (btnInterno) btnInterno.classList.remove('hover-target');

            // Remove a classe de direção para a transição CSS fazer a pílula encolher
            pill.className = 'mitosis-pill'; 

            // Quando a animação de recolher acabar (0.5s), deleta o botão da memória
            pill.addEventListener('transitionend', () => {
                if (pill.parentNode) pill.remove();
            }, { once: true });
            
            // Rede de segurança contra abas inativas
            setTimeout(() => { if (pill.parentNode) pill.remove(); }, 600);
        });

        // Destrava a ilha principal para ela voltar ao comportamento normal
        this.removeAttribute('inspecting'); 
    }

    // ─── Motor de Morph ──────────────────────────────────────────────────────

    morph(options) {
        const { width, height = 44, radius = height / 2, viewId, islandClass = '', duration = 0 } = options;

        const container          = this.shadowRoot.getElementById('bar-container');
        const navContent         = this.shadowRoot.getElementById('bar-content');
        const filtersDrawer      = this.shadowRoot.getElementById('filters-drawer');
        const externalIndicator  = this.shadowRoot.getElementById('external-indicator');
        const targetView         = this.shadowRoot.getElementById(viewId);
        const allViews           = this.shadowRoot.querySelectorAll('.island-view');

        if (this.morphTimeout) clearTimeout(this.morphTimeout);
        this.isLocked = (duration === 0);

        navContent.classList.add('hidden');
        filtersDrawer.classList.add('hidden');
        externalIndicator.classList.add('hidden');
        allViews.forEach(v => { if (v.id !== viewId) v.classList.remove('visible'); });

        if (islandClass) container.className = islandClass;
        container.style.setProperty('--island-width',  typeof width  === 'number' ? `${width}px`  : width);
        container.style.setProperty('--island-height', typeof height === 'number' ? `${height}px` : height);
        container.style.setProperty('--island-radius', typeof radius === 'number' ? `${radius}px` : radius);

        setTimeout(() => {
            navContent.style.display = 'none';
            allViews.forEach(v => { if (v.id !== viewId) v.style.display = 'none'; });

            if (targetView) {
                targetView.style.display = 'flex';
                void targetView.offsetWidth;
                targetView.classList.add('visible');
            }
        }, 200);

        if (duration > 0) {
            this.morphTimeout = setTimeout(() => this.reset(), duration);
        }
    }

    reset() {
        const container         = this.shadowRoot.getElementById('bar-container');
        const navContent        = this.shadowRoot.getElementById('bar-content');
        const filtersDrawer     = this.shadowRoot.getElementById('filters-drawer');
        const externalIndicator = this.shadowRoot.getElementById('external-indicator');
        const allViews          = this.shadowRoot.querySelectorAll('.island-view');

        this.isLocked = false;
        allViews.forEach(v => v.classList.remove('visible'));

        setTimeout(() => {
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
        }, 200);
    }

    hideNotification() { this.reset(); }

    showNotification({ text = 'Notificação', spinner = false, duration = 3000 }) {
        const notifContent = this.shadowRoot.getElementById('view-notification');
        const notifIcon    = this.shadowRoot.getElementById('notif-icon');
        const notifText    = this.shadowRoot.getElementById('notif-text');

        notifText.textContent = text;
        if (spinner) {
            notifIcon.innerHTML     = `<div class="spinner"></div>`;
            notifIcon.style.display = 'block';
        } else {
            notifIcon.innerHTML     = '';
            notifIcon.style.display = 'none';
        }

        notifContent.style.display     = 'flex';
        notifContent.style.visibility  = 'hidden';
        let targetWidth = notifContent.scrollWidth + 60;
        if (targetWidth < 220) targetWidth = 220;
        notifContent.style.display    = 'none';
        notifContent.style.visibility = 'visible';

        this.morph({
            width: targetWidth, height: 44, viewId: 'view-notification',
            islandClass: 'notifying', duration
        });
    }

    updateNotificationText(text) {
        const notifText    = this.shadowRoot.getElementById('notif-text');
        if (!notifText || notifText.textContent === text) return;

        notifText.textContent = text;

        const notifContent = this.shadowRoot.getElementById('view-notification');
        const container    = this.shadowRoot.getElementById('bar-container');

        let targetWidth = notifContent.scrollWidth + 60;
        if (targetWidth < 220) targetWidth = 220;
        container.style.setProperty('--island-width', `${targetWidth}px`);
    }

    render() {
        this.shadowRoot.innerHTML = `
        <style>
            * { cursor: none !important; font-family: var(--font, sans-serif); box-sizing: border-box; }

            :host {
                display: block;
                --black-studio: rgba(15, 15, 15, 0.85);
                --white: #ffffff;
                --gray: rgba(255, 255, 255, 0.4);
                --border-metal: rgba(255, 255, 255, 0.06);
                --border-metal-bright: rgba(255, 255, 255, 0.12);

                position: fixed; top: 15px; left: 50%; transform: translateX(-50%);
                z-index: 1000; pointer-events: none;

                --default-w: 450px;
                --default-h: 38px;
                --default-r: 16px;
            }

            #hover-zone {
                display: flex; flex-direction: column; align-items: center;
                padding: 10px 20px 40px 20px;
                margin: -10px -20px -40px -20px;
                pointer-events: auto;
                position: relative; /* Importante para a mitose ficar ancorada aqui */
            }

            /* Desativa o Hover de abrir o Menu de Filtros se estiver Inspecionando um disco */
            :host([active-tab="library"]:not([inspecting])) #hover-zone:hover #bar-container:not(.notifying) {
                --default-h: 90px;
                --default-r: 24px;
            }

            /* ─── CLASSES DINÂMICAS DO MOTOR DE MITOSE ─── */
            .mitosis-pill {
                position: absolute;
                top: 10px; 
                left: 50%;
                width: 38px; height: 38px; border-radius: 19px;
                background: var(--black-studio);
                backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
                border: 1px solid var(--border-metal);
                display: flex; align-items: center; justify-content: center;
                
                opacity: 0; pointer-events: none;
                transform: translateX(-50%) scale(0.6);
                transition: all 0.5s cubic-bezier(0.34, 1.2, 0.64, 1);
                z-index: 900; 
                box-shadow: 0 8px 25px rgba(0,0,0,0.5);
            }
            .mitosis-pill.split-right {
                transform: translateX(calc(-50% + var(--mitosis-distance, 237px))) scale(1);
                opacity: 1; pointer-events: auto;
            }
            .mitosis-pill.split-left {
                transform: translateX(calc(-50% - var(--mitosis-distance, 237px))) scale(1);
                opacity: 1; pointer-events: auto;
            }
            .mitosis-btn { 
                color: var(--gray); transition: color 0.2s ease, background 0.2s ease; 
                width: 100%; height: 100%; border-radius: 50%;
                display: flex; align-items: center; justify-content: center; 
            }
            .mitosis-btn:hover { color: var(--white); background: rgba(255,255,255,0.05); }


            /* ─── ILHA PRINCIPAL ─── */
            #bar-container {
                background: var(--black-studio);
                backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
                border: 1px solid var(--border-metal);

                width: var(--island-width, var(--default-w));
                height: var(--island-height, var(--default-h));
                border-radius: var(--island-radius, var(--default-r));

                display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
                padding: 0 10px; box-shadow: 0 8px 25px rgba(0,0,0,0.5);

                transition: width  0.5s cubic-bezier(0.34, 1.2, 0.64, 1),
                            height 0.5s cubic-bezier(0.34, 1.2, 0.64, 1),
                            border-radius 0.5s cubic-bezier(0.34, 1.2, 0.64, 1),
                            background-color 0.5s ease, border-color 0.5s ease, box-shadow 0.5s ease;

                position: relative; z-index: 1000;
            }

            #bar-container.notifying {
                background: rgba(10, 10, 10, 0.98);
                border-color: var(--border-metal-bright);
                box-shadow: 0 12px 35px rgba(0,0,0,0.8);
            }

            #bar-content {
                display: flex; align-items: center; justify-content: space-between;
                width: 100%; height: 38px; min-height: 38px;
                opacity: 1; transform: scale(1);
                transition: opacity 0.3s ease, transform 0.4s cubic-bezier(0.32, 0.72, 0, 1);
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
            :host([active-tab="library"]:not([inspecting])) #hover-zone:hover #external-indicator {
                opacity: 0; transform: translateY(10px); pointer-events: none;
            }
            #external-indicator.hidden { opacity: 0 !important; pointer-events: none; }
            :host([active-tab="library"]) #external-indicator { display: flex; }

            .indicator-line  { width: 24px; height: 2px; background: rgba(255,255,255,0.3); border-radius: 2px; }
            .indicator-text  { font-size: 8px; font-weight: 700; letter-spacing: 0.15em; color: var(--gray); text-transform: uppercase; }

            #filters-drawer {
                position: absolute; bottom: 18px;
                display: flex; gap: 6px; justify-content: center; align-items: center;
                opacity: 0; pointer-events: none; transform: translateY(10px);
                transition: all 0.4s cubic-bezier(0.34, 1.2, 0.64, 1);
                width: 100%;
            }
            #filters-drawer.hidden { display: none; }

            :host([active-tab="library"]:not([inspecting])) #hover-zone:hover #bar-container:not(.notifying) #filters-drawer {
                opacity: 1; pointer-events: auto; transform: translateY(0);
            }

            .filter-btn {
                background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
                color: var(--gray); border-radius: 12px; padding: 6px 10px;
                font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
                transition: all 0.2s ease; white-space: nowrap;
            }
            .filter-btn:hover  { background: rgba(255,255,255,0.1); color: var(--white); }
            .filter-btn.active { background: var(--white); color: var(--black); border-color: var(--white); }

            .island-view {
                display: none; position: absolute; inset: 0;
                align-items: center; justify-content: center; gap: 12px;
                opacity: 0; transform: scale(0.9);
                transition: opacity 0.3s ease, transform 0.4s cubic-bezier(0.34, 1.2, 0.64, 1);
                z-index: 1300;
            }
            .island-view.visible { opacity: 1; transform: scale(1); }

            #notif-text { font-size: 11px; font-weight: 600; color: var(--white); letter-spacing: 0.05em; white-space: nowrap; }
            .spinner    { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.05); border-top-color: var(--white); border-radius: 50%; animation: spin 0.8s linear infinite; }
            @keyframes spin { to { transform: rotate(360deg); } }

            .logo-section { display: flex; align-items: center; gap: 8px; margin-left: 8px; position: relative; z-index: 1200; }
            .logo-led     { width: 4px; height: 4px; background: rgba(255,255,255,0.2); border-radius: 50%; }
            .logo-name    { font-weight: 700; font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--white); }

            .nav-section {
                display: flex; gap: 2px;
                position: absolute; left: 50%; transform: translateX(-50%);
                z-index: 1200;
            }

            .nav-link {
                color: var(--gray); text-decoration: none; font-size: 9px; text-transform: uppercase;
                letter-spacing: 0.1em; padding: 6px 14px; border-radius: 16px;
                transition: all 0.2s ease; background: transparent; border: 1px solid transparent;
                position: relative; z-index: 1200;
            }
            .nav-link:hover, .nav-link.active { color: var(--white); }
            .nav-link.active { font-weight: 600; background: rgba(255,255,255,0.05); }

            .icon-link { display: flex; align-items: center; justify-content: center; padding: 6px; margin-right: 4px; }
            .icon-link svg { transition: transform 0.4s cubic-bezier(0.34, 1.2, 0.64, 1); }
            .icon-link:hover svg, .icon-link.active svg { transform: rotate(90deg); }
        </style>

        <div id="hover-zone">
            <div id="bar-container">
                <div id="bar-content">
                    <div class="logo-section">
                        <div class="logo-led"></div>
                        <span class="logo-name">Rolfsound</span>
                    </div>

                    <div class="nav-section">
                        <a href="#" class="nav-link hover-target ${this.activeTab === 'library'  ? 'active' : ''}" data-tab="library">Library</a>
                    </div>

                    <a href="#" class="nav-link icon-link hover-target ${this.activeTab === 'settings' ? 'active' : ''}" data-tab="settings">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="pointer-events: none;">
                            <circle cx="12" cy="12" r="3"></circle>
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                        </svg>
                    </a>
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
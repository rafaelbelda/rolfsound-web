// static/js/RolfsoundIsland.js

class RolfsoundIsland extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        
        this.activeTab = this.getAttribute('active-tab') || 'library';
        this.morphTimeout = null; 
        this.isLocked = false;    
    }

    static get observedAttributes() {
        return ['active-tab'];
    }

    connectedCallback() {
        this.render();
        this.addEventListeners();
        this.reset();
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'active-tab' && oldValue !== newValue) {
            this.activeTab = newValue;
            this.updateActiveTab();
        }
    }

    // ─── LÓGICA DE COMPORTAMENTO E SPA ROUTING ───

    addEventListeners() {
        const syncBtn = this.shadowRoot.getElementById('btn-sync');
        if (syncBtn) {
            syncBtn.addEventListener('click', () => {
                if(confirm("Iniciar prensagem de novos discos?")) {
                    this.showNotification({
                        text: "Prensando Novos Vinis...",
                        spinner: true,
                        duration: 0 
                    });
                    
                    this.dispatchEvent(new CustomEvent('rolfsound-sync-start', { bubbles: true, composed: true }));
                }
            });
        }

        const links = this.shadowRoot.querySelectorAll('.nav-link');
        links.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault(); 
                if (this.isLocked) return;

                const tab = link.dataset.tab;
                if (this.activeTab === tab) return; 

                this.setAttribute('active-tab', tab);

                this.dispatchEvent(new CustomEvent('rolfsound-navigate', {
                    bubbles: true, composed: true, detail: { view: tab }
                }));
            });
        });

        const filterBtns = this.shadowRoot.querySelectorAll('.filter-btn');
        filterBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                filterBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                this.dispatchEvent(new CustomEvent('rolfsound-filter', {
                    bubbles: true, composed: true, detail: { filter: btn.dataset.filter }
                }));
            });
        });
    }

    updateActiveTab() {
        const links = this.shadowRoot.querySelectorAll('.nav-link');
        links.forEach(link => {
            if (link.dataset.tab === this.activeTab) {
                link.classList.add('active');
            } else {
                link.classList.remove('active');
            }
        });
    }

    // ─── 1. O MOTOR DE MORPH ─── //

    morph(options) {
        const { width, height = 44, radius = height / 2, viewId, islandClass = '', duration = 0 } = options;

        const container = this.shadowRoot.getElementById('bar-container');
        const navContent = this.shadowRoot.getElementById('bar-content');
        const filtersDrawer = this.shadowRoot.getElementById('filters-drawer');
        const externalIndicator = this.shadowRoot.getElementById('external-indicator');
        const targetView = this.shadowRoot.getElementById(viewId);
        const allViews = this.shadowRoot.querySelectorAll('.island-view');

        if (this.morphTimeout) clearTimeout(this.morphTimeout);
        this.isLocked = (duration === 0);

        navContent.classList.add('hidden');
        filtersDrawer.classList.add('hidden');
        externalIndicator.classList.add('hidden'); // Esconde o texto "Filters" quando notificar
        
        allViews.forEach(v => {
            if (v.id !== viewId) v.classList.remove('visible');
        });

        if (islandClass) container.className = islandClass;
        container.style.setProperty('--island-width', typeof width === 'number' ? `${width}px` : width);
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

    // ─── 2. O MOTOR DE RESET ─── //

    reset() {
        const container = this.shadowRoot.getElementById('bar-container');
        const navContent = this.shadowRoot.getElementById('bar-content');
        const filtersDrawer = this.shadowRoot.getElementById('filters-drawer');
        const externalIndicator = this.shadowRoot.getElementById('external-indicator');
        const allViews = this.shadowRoot.querySelectorAll('.island-view');

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

    hideNotification() {
        this.reset();
    }

    showNotification({ text = "Notificação", spinner = false, duration = 3000 }) {
        const notifContent = this.shadowRoot.getElementById('view-notification');
        const notifIcon = this.shadowRoot.getElementById('notif-icon');
        const notifText = this.shadowRoot.getElementById('notif-text');

        notifText.textContent = text;
        if (spinner) {
            notifIcon.innerHTML = `<div class="spinner"></div>`;
            notifIcon.style.display = 'block';
        } else {
            notifIcon.innerHTML = '';
            notifIcon.style.display = 'none';
        }

        notifContent.style.display = 'flex';
        notifContent.style.visibility = 'hidden';
        let targetWidth = notifContent.scrollWidth + 60; 
        if (targetWidth < 220) targetWidth = 220; 
        notifContent.style.display = 'none';
        notifContent.style.visibility = 'visible';

        this.morph({
            width: targetWidth, height: 44, viewId: 'view-notification', islandClass: 'notifying', duration: duration
        });
    }

    // ─── RENDERIZAÇÃO E STYLES ───

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
            }

            :host([active-tab="library"]) #hover-zone:hover #bar-container:not(.notifying) {
                --default-h: 90px; 
                --default-r: 24px;
            }

            #bar-container {
                background: var(--black-studio);
                backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
                border: 1px solid var(--border-metal);
                
                width: var(--island-width, var(--default-w));
                height: var(--island-height, var(--default-h)); 
                border-radius: var(--island-radius, var(--default-r));
                
                display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
                padding: 0 10px; box-shadow: 0 8px 25px rgba(0,0,0,0.5); 
                
                transition: width 0.5s cubic-bezier(0.34, 1.2, 0.64, 1),
                            height 0.5s cubic-bezier(0.34, 1.2, 0.64, 1),
                            border-radius 0.5s cubic-bezier(0.34, 1.2, 0.64, 1),
                            background-color 0.5s ease, border-color 0.5s ease, box-shadow 0.5s ease;
                
                position: relative; z-index: 1000;
            }

            #bar-container.notifying {
                background: rgba(10, 10, 10, 0.98); border-color: var(--border-metal-bright); box-shadow: 0 12px 35px rgba(0,0,0,0.8);
            }

            #bar-content {
                display: flex; align-items: center; justify-content: space-between;
                width: 100%; height: 38px; min-height: 38px; 
                opacity: 1; transform: scale(1);
                transition: opacity 0.3s ease, transform 0.4s cubic-bezier(0.32, 0.72, 0, 1);
                position: relative; z-index: 1200; 
            }
            #bar-content.hidden { opacity: 0; transform: scale(0.95); }

            #external-indicator {
                display: none; flex-direction: column; align-items: center; gap: 4px;
                margin-top: 8px; transition: opacity 0.3s ease, transform 0.3s ease;
            }
            #external-indicator.hidden { opacity: 0 !important; pointer-events: none; }
            :host([active-tab="library"]) #external-indicator { display: flex; }
            :host([active-tab="library"]) #hover-zone:hover #external-indicator {
                opacity: 0; transform: translateY(10px);
            }

            .indicator-line {
                width: 24px; height: 2px; background: rgba(255, 255, 255, 0.3); border-radius: 2px;
            }
            .indicator-text {
                font-size: 8px; font-weight: 700; letter-spacing: 0.15em; color: var(--gray); text-transform: uppercase;
            }

            /* ─── A GAVETA DE FILTROS REFINADA PARA 5 BOTÕES ─── */
            #filters-drawer {
                position: absolute; bottom: 18px; 
                display: flex; gap: 6px; justify-content: center; align-items: center;
                opacity: 0; pointer-events: none; transform: translateY(10px);
                transition: all 0.4s cubic-bezier(0.34, 1.2, 0.64, 1);
                width: 100%; /* Garante que os botões tenham espaço */
            }
            #filters-drawer.hidden { display: none; }

            :host([active-tab="library"]) #hover-zone:hover #bar-container:not(.notifying) #filters-drawer {
                opacity: 1; pointer-events: auto; transform: translateY(0);
            }

            .filter-btn {
                background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1);
                color: var(--gray); border-radius: 12px; padding: 6px 10px;
                font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
                transition: all 0.2s ease; white-space: nowrap; /* Impede o texto de quebrar linha */
            }
            .filter-btn:hover { background: rgba(255, 255, 255, 0.1); color: var(--white); }
            .filter-btn.active { background: var(--white); color: var(--black); border-color: var(--white); }

            /* ─── NOTIFICAÇÕES E NAVEGAÇÃO ─── */
            .island-view {
                display: none; position: absolute; inset: 0; align-items: center; justify-content: center; gap: 12px;
                opacity: 0; transform: scale(0.9); transition: opacity 0.3s ease, transform 0.4s cubic-bezier(0.34, 1.2, 0.64, 1);
                z-index: 1300;
            }
            .island-view.visible { opacity: 1; transform: scale(1); }
            #notif-text { font-size: 11px; font-weight: 600; color: var(--white); letter-spacing: 0.05em; white-space: nowrap; }
            .spinner { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.05); border-top-color: var(--white); border-radius: 50%; animation: spin 0.8s linear infinite; }
            @keyframes spin { to { transform: rotate(360deg); } }

            .logo-section { display: flex; align-items: center; gap: 8px; margin-left: 8px; position: relative; z-index: 1200; }
            .logo-led { width: 4px; height: 4px; background: rgba(255,255,255,0.2); border-radius: 50%; }
            .logo-name { font-weight: 700; font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--white); }
            .nav-section { display: flex; gap: 2px; position: relative; z-index: 1200; }
            .nav-link { color: var(--gray); text-decoration: none; font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; padding: 6px 14px; border-radius: 16px; transition: all 0.2s ease; background: transparent; border: 1px solid transparent; position: relative; z-index: 1200; }
            .nav-link:hover, .nav-link.active { color: var(--white); }
            .nav-link.active { font-weight: 600; background: rgba(255, 255, 255, 0.05); }
            #btn-sync { background: none; border: 1px solid transparent; color: var(--gray); font-size: 11px; padding: 4px 8px; margin-right: 5px; border-radius: 16px; transition: all 0.2s ease; position: relative; z-index: 1200; }
            #btn-sync:hover { color: var(--white); }
        </style>

        <div id="hover-zone">
            <div id="bar-container">
                <div id="bar-content">
                    <div class="logo-section">
                        <div class="logo-led"></div>
                        <span class="logo-name">Rolfsound</span>
                    </div>
                    <div class="nav-section">
                        <a href="#" class="nav-link hover-target ${this.activeTab === 'library' ? 'active' : ''}" data-tab="library">Library</a>
                        <a href="#" class="nav-link hover-target ${this.activeTab === 'settings' ? 'active' : ''}" data-tab="settings">Settings</a>
                    </div>
                    <button id="btn-sync" class="hover-target" title="Sincronizar Coleção">↻</button>
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
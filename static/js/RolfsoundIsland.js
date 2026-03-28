// static/js/RolfsoundIsland.js

class RolfsoundIsland extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        
        this.isSyncing = false;
        this.activeTab = this.getAttribute('active-tab') || 'library';
    }

    static get observedAttributes() {
        return ['active-tab', 'sync-state'];
    }

    connectedCallback() {
        this.render();
        this.addEventListeners();
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'active-tab' && oldValue !== newValue) {
            this.activeTab = newValue;
            this.updateActiveTab();
        }
        if (name === 'sync-state' && oldValue !== newValue) {
            this.updateSyncState(newValue);
        }
    }

    // ─── LÓGICA DE COMPORTAMENTO ───

    addEventListeners() {
        const syncBtn = this.shadowRoot.getElementById('btn-sync');
        if (syncBtn) {
            syncBtn.addEventListener('click', () => this.dispatchEventSync());
        }
    }

    dispatchEventSync() {
        if (this.isSyncing) return;
        
        if(confirm("Iniciar prensagem de novos discos?")) {
             const event = new CustomEvent('rolfsound-sync-start', {
                bubbles: true,
                composed: true 
            });
            this.dispatchEvent(event);
        }
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

    updateSyncState(state) {
        const container = this.shadowRoot.getElementById('bar-container');
        const content = this.shadowRoot.getElementById('bar-content');
        const loader = this.shadowRoot.getElementById('sync-loader');

        if (state === 'syncing') {
            this.isSyncing = true;
            container.classList.add('syncing');
            content.style.opacity = '0'; 
            
            setTimeout(() => {
                content.style.display = 'none';
                loader.style.display = 'flex';
                setTimeout(() => loader.style.opacity = '1', 50);
            }, 300); 

        } else if (state === 'idle') {
            this.isSyncing = false;
            loader.style.opacity = '0';
            
            setTimeout(() => {
                loader.style.display = 'none';
                content.style.display = 'flex';
                setTimeout(() => content.style.opacity = '1', 50);
                container.classList.remove('syncing');
            }, 300);
        }
    }

    // ─── RENDERIZAÇÃO ───

    render() {
        this.shadowRoot.innerHTML = `
        <style>
            * {
                cursor: none !important;
                font-family: var(--font, sans-serif);
            }
        
            :host {
                display: block;
                --black-studio: rgba(15, 15, 15, 0.85);
                --white: #ffffff;
                --gray: rgba(255, 255, 255, 0.4);
                
                --border-metal: rgba(255, 255, 255, 0.06); 
                --border-metal-bright: rgba(255, 255, 255, 0.12);
                
                position: fixed;
                top: 15px; 
                left: 50%;
                transform: translateX(-50%);
                
                /* CAMADA BASE DA ILHA: 1000 */
                z-index: 1000; 
                pointer-events: none; 
            }
        
            #bar-container {
                background: var(--black-studio);
                backdrop-filter: blur(20px);
                -webkit-backdrop-filter: blur(20px);
                border: 1px solid var(--border-metal);
                
                min-width: 450px;
                height: 38px; 
                border-radius: 16px;
                
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0 10px;
                box-shadow: 0 8px 25px rgba(0,0,0,0.5);
                
                pointer-events: auto; 
                transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
                
                /* IMPORTANTE: Permite que o cursor apareça "dentro" do container */
                overflow: visible; 
                position: relative;
                
                /* FUNDO DA ILHA: Camada 1000 */
                z-index: 1000;
            }
        
            #bar-container.syncing {
                min-width: 470px;
                height: 60px; 
                background: rgba(20, 20, 20, 0.98);
                border-color: var(--border-metal-bright);
                border-radius: 20px;
            }
        
            #bar-content {
                display: flex;
                align-items: center;
                justify-content: space-between;
                width: 100%;
                transition: opacity 0.3s ease;
                opacity: 1;
                
                /* CONTEÚDO (TEXTO): Camada 1200 (acima do cursor 1100) */
                position: relative;
                z-index: 1200; 
            }
        
            .logo-section {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-left: 8px;
                position: relative;
                z-index: 1200;
            }
        
            .logo-led {
                width: 4px; height: 4px;
                background: rgba(255,255,255,0.2);
                border-radius: 50%;
            }
        
            .logo-name {
                font-weight: 700;
                font-size: 10px;
                letter-spacing: 1.5px;
                text-transform: uppercase;
                color: var(--white);
            }
        
            .nav-section {
                display: flex;
                gap: 2px;
                position: relative;
                z-index: 1200;
            }
        
            .nav-link {
                color: var(--gray);
                text-decoration: none;
                font-size: 9px;
                text-transform: uppercase;
                letter-spacing: 0.1em;
                padding: 6px 14px;
                border-radius: 16px;
                transition: all 0.2s ease;
                background: transparent;
                border: 1px solid transparent; 
                
                /* Garante que o texto tenha seu próprio nível de empilhamento */
                position: relative;
                z-index: 1200;
            }
        
            .nav-link:hover, .nav-link.active {
                color: var(--white);
            }
        
            .nav-link.active {
                font-weight: 600;
                /* Um leve brilho de fundo para a aba ativa sem o cursor */
                background: rgba(255, 255, 255, 0.05);
            }
        
            #btn-sync {
                background: none;
                border: 1px solid transparent;
                color: var(--gray);
                font-size: 11px;
                padding: 4px 8px;
                margin-right: 5px;
                border-radius: 16px;
                transition: all 0.2s ease;
                
                position: relative;
                z-index: 1200;
            }
        
            #btn-sync:hover {
                color: var(--white);
            }
        
            /* ... restante do CSS (spinner e loader) ... */
            #sync-loader {
                display: none; 
                position: absolute;
                inset: 0;
                align-items: center;
                justify-content: center;
                gap: 12px;
                opacity: 0;
                transition: opacity 0.3s ease;
                z-index: 1300; /* Loader no topo de tudo */
            }
        
            .spinner {
                width: 14px; height: 14px;
                border: 2px solid rgba(255,255,255,0.05);
                border-top-color: var(--white);
                border-radius: 50%;
                animation: spin 0.8s linear infinite;
            }
        
            #loader-text {
                font-size: 10px;
                text-transform: uppercase;
                color: var(--white);
                letter-spacing: 0.1em;
            }
        
            @keyframes spin {
                to { transform: rotate(360deg); }
            }
        
        </style>
        
        <div id="bar-container">
            <div id="bar-content">
                <div class="logo-section">
                    <div class="logo-led"></div>
                    <span class="logo-name">Rolfsound</span>
                </div>
                
                <div class="nav-section">
                    <a href="/" class="nav-link hover-target ${this.activeTab === 'playing' ? 'active' : ''}" data-tab="playing">Now Playing</a>
                    <a href="/library" class="nav-link hover-target ${this.activeTab === 'library' ? 'active' : ''}" data-tab="library">Library</a>
                    <a href="/settings" class="nav-link hover-target ${this.activeTab === 'settings' ? 'active' : ''}" data-tab="settings">Settings</a>
                </div>
        
                <button id="btn-sync" class="hover-target" title="Sincronizar Coleção">↻</button>
            </div>
        
            <div id="sync-loader">
                <div class="spinner"></div>
                <span id="loader-text">Prensando Novos Vinis no Servidor</span>
            </div>
        </div>
        `;
    }
}

customElements.define('rolfsound-island', RolfsoundIsland);
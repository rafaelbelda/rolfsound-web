// static/js/RolfsoundIsland.js

class RolfsoundIsland extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        
        this.activeTab = this.getAttribute('active-tab') || 'library';
        this.notifTimeout = null; 
        this.isLocked = false;    
    }

    static get observedAttributes() {
        return ['active-tab'];
    }

    connectedCallback() {
        this.render();
        this.addEventListeners();
        // Inicializa o tamanho padrão da Ilha via CSS Variables
        const container = this.shadowRoot.getElementById('bar-container');
        if(container) {
            container.style.setProperty('--island-width', '450px');
            container.style.setProperty('--island-height', '38px');
            container.style.setProperty('--island-radius', '16px');
        }
    }

    attributeChangedCallback(name, oldValue, newValue) {
        if (name === 'active-tab' && oldValue !== newValue) {
            this.activeTab = newValue;
            this.updateActiveTab();
        }
    }

    // ─── LÓGICA DE COMPORTAMENTO E SPA ROUTING ───

    addEventListeners() {
        // 1. Botão de Sincronização (Dispara a notificação de Loading Infinito)
        const syncBtn = this.shadowRoot.getElementById('btn-sync');
        if (syncBtn) {
            syncBtn.addEventListener('click', () => {
                if(confirm("Iniciar prensagem de novos discos?")) {
                    this.showNotification({
                        text: "Prensando Novos Vinis...",
                        spinner: true,
                        duration: 0 
                    });
                    
                    const event = new CustomEvent('rolfsound-sync-start', {
                        bubbles: true,
                        composed: true 
                    });
                    this.dispatchEvent(event);
                }
            });
        }

        // 2. Navegação em Camadas (Single Page Application - Fim dos reloads!)
        const links = this.shadowRoot.querySelectorAll('.nav-link');
        links.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault(); // Bloqueia o recarregamento padrão (a tela branca)

                if (this.isLocked) return;

                const tab = link.dataset.tab;
                if (this.activeTab === tab) return; // Se já está na aba, ignora

                this.activeTab = tab;
                this.updateActiveTab();

                // Grita para o index.html: "Troque a camada de visualização!"
                this.dispatchEvent(new CustomEvent('rolfsound-navigate', {
                    bubbles: true,
                    composed: true,
                    detail: { view: tab }
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

    // ─── O MOTOR PREMIUM DA DYNAMIC ISLAND ───

    showNotification({ text = "Notificação", spinner = false, duration = 3000 }) {
        const container = this.shadowRoot.getElementById('bar-container');
        const navContent = this.shadowRoot.getElementById('bar-content');
        const notifContent = this.shadowRoot.getElementById('notification-content');
        const notifIcon = this.shadowRoot.getElementById('notif-icon');
        const notifText = this.shadowRoot.getElementById('notif-text');

        // Limpa o temporizador antigo caso cheguem duas notificações seguidas
        if (this.notifTimeout) clearTimeout(this.notifTimeout);

        // 1. Prepara o texto e o ícone
        notifText.textContent = text;
        if (spinner) {
            notifIcon.innerHTML = `<div class="spinner"></div>`;
            notifIcon.style.display = 'block';
        } else {
            notifIcon.innerHTML = '';
            notifIcon.style.display = 'none';
        }

        // Bloqueia a ilha para loading infinito se duration = 0
        this.isLocked = (duration === 0);

        // 2. Animação de saída da navegação (Scale Down & Fade Out)
        navContent.classList.add('hidden');

        // 3. Medição Dinâmica: Montamos invisivelmente para ler a largura do texto
        notifContent.style.display = 'flex';
        notifContent.style.visibility = 'hidden';
        
        let targetWidth = notifContent.scrollWidth + 60; // 60px de respiro nas bordas
        if (targetWidth < 220) targetWidth = 220; // Tamanho mínimo aceitável

        notifContent.style.display = 'none';
        notifContent.style.visibility = 'visible';

        // 4. Morfa a Ilha (A Mola entra em ação via CSS Variables)
        container.classList.add('notifying');
        container.style.setProperty('--island-width', `${targetWidth}px`);
        container.style.setProperty('--island-height', `44px`); // Mais gordinha
        container.style.setProperty('--island-radius', `22px`); 

        // 5. Animação de entrada da notificação (Scale Up & Fade In)
        setTimeout(() => {
            navContent.style.display = 'none';
            notifContent.style.display = 'flex';
            
            // Força repaint para transição funcionar
            void notifContent.offsetWidth; 
            
            notifContent.classList.add('visible');
        }, 200); 

        // 6. Agenda a auto-destruição se não for infinito
        if (duration > 0) {
            this.notifTimeout = setTimeout(() => {
                this.hideNotification();
            }, duration);
        }
    }

    hideNotification() {
        const container = this.shadowRoot.getElementById('bar-container');
        const navContent = this.shadowRoot.getElementById('bar-content');
        const notifContent = this.shadowRoot.getElementById('notification-content');

        this.isLocked = false;
        
        // 1. Notificação Scale Down & Fade Out
        notifContent.classList.remove('visible');

        // 2. Devolve a Ilha pro tamanho nativo da navegação
        setTimeout(() => {
            notifContent.style.display = 'none';
            navContent.style.display = 'flex';
            
            container.classList.remove('notifying');
            container.style.setProperty('--island-width', `450px`);
            container.style.setProperty('--island-height', `38px`);
            container.style.setProperty('--island-radius', `16px`);

            // 3. Navegação Scale Up & Fade In
            void navContent.offsetWidth; 
            navContent.classList.remove('hidden');
        }, 200);
    }

    // ─── RENDERIZAÇÃO E STYLES ───

    render() {
        this.shadowRoot.innerHTML = `
        <style>
            * {
                cursor: none !important;
                font-family: var(--font, sans-serif);
                box-sizing: border-box;
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
                z-index: 1000; 
                pointer-events: none; 
            }

            #bar-container {
                background: var(--black-studio);
                backdrop-filter: blur(20px);
                -webkit-backdrop-filter: blur(20px);
                border: 1px solid var(--border-metal);
                
                width: var(--island-width, 450px);
                height: var(--island-height, 38px); 
                border-radius: var(--island-radius, 16px);
                
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0 10px;
                box-shadow: 0 8px 25px rgba(0,0,0,0.5);
                
                pointer-events: auto; 
                
                /* FÍSICA DE MOLA APPLE: Controla a expansão orgânica */
                transition: width 0.5s cubic-bezier(0.32, 0.72, 0, 1),
                            height 0.5s cubic-bezier(0.32, 0.72, 0, 1),
                            border-radius 0.5s cubic-bezier(0.32, 0.72, 0, 1),
                            background-color 0.5s ease,
                            border-color 0.5s ease,
                            box-shadow 0.5s ease;
                
                overflow: visible; 
                position: relative;
                z-index: 1000;
            }

            #bar-container.notifying {
                background: rgba(10, 10, 10, 0.98);
                border-color: var(--border-metal-bright);
                box-shadow: 0 12px 35px rgba(0,0,0,0.8);
            }

            #bar-content, #notification-content {
                transition: opacity 0.3s ease, transform 0.4s cubic-bezier(0.32, 0.72, 0, 1);
            }

            #bar-content {
                display: flex;
                align-items: center;
                justify-content: space-between;
                width: 100%;
                opacity: 1;
                transform: scale(1);
                position: relative;
                z-index: 1200; 
            }

            #bar-content.hidden {
                opacity: 0;
                transform: scale(0.95);
            }

            #notification-content {
                display: none; 
                position: absolute;
                inset: 0;
                align-items: center;
                justify-content: center;
                gap: 12px;
                opacity: 0;
                transform: scale(0.9); 
                z-index: 1300;
            }

            #notification-content.visible {
                opacity: 1;
                transform: scale(1);
            }

            #notif-text {
                font-size: 11px;
                font-weight: 600;
                color: var(--white);
                letter-spacing: 0.05em;
                white-space: nowrap; 
            }

            .spinner {
                width: 14px; height: 14px;
                border: 2px solid rgba(255,255,255,0.05);
                border-top-color: var(--white);
                border-radius: 50%;
                animation: spin 0.8s linear infinite;
            }
            @keyframes spin { to { transform: rotate(360deg); } }

            /* ─── ESTILOS DA NAVEGAÇÃO ─── */
            .logo-section { display: flex; align-items: center; gap: 8px; margin-left: 8px; position: relative; z-index: 1200; }
            .logo-led { width: 4px; height: 4px; background: rgba(255,255,255,0.2); border-radius: 50%; }
            .logo-name { font-weight: 700; font-size: 10px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--white); }
            
            .nav-section { display: flex; gap: 2px; position: relative; z-index: 1200; }
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
                position: relative;
                z-index: 1200;
            }
            .nav-link:hover, .nav-link.active { color: var(--white); }
            .nav-link.active { font-weight: 600; background: rgba(255, 255, 255, 0.05); }

            #btn-sync {
                background: none; border: 1px solid transparent; color: var(--gray); font-size: 11px;
                padding: 4px 8px; margin-right: 5px; border-radius: 16px; transition: all 0.2s ease;
                position: relative; z-index: 1200;
            }
            #btn-sync:hover { color: var(--white); }
        </style>

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

            <div id="notification-content">
                <div id="notif-icon"></div>
                <span id="notif-text"></span>
            </div>
        </div>
        `;
    }
}

customElements.define('rolfsound-island', RolfsoundIsland);
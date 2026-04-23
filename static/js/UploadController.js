// static/js/UploadController.js
// Singleton global controller for drag-and-drop uploads.
// Uses Shadow DOM strictly for CSS encapsulation of the dropzone overlay.

export default class UploadController extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._dragCounter = 0; // Evita flickering quando o rato passa por cima do texto
    }

    connectedCallback() {
        this.render();
        this.cacheDom();
        this.attachGlobalListeners();
    }

    cacheDom() {
        this.overlay = this.shadowRoot.getElementById('upload-overlay');
        this.progressBar = this.shadowRoot.getElementById('progress-bar');
        this.statusText = this.shadowRoot.getElementById('status-text');
    }

    attachGlobalListeners() {
        // Ouve a janela global do navegador
        window.addEventListener('dragenter', this.onDragEnter.bind(this));
        window.addEventListener('dragleave', this.onDragLeave.bind(this));
        window.addEventListener('dragover', (e) => e.preventDefault());
        window.addEventListener('drop', this.onDrop.bind(this));
    }

    onDragEnter(e) {
        e.preventDefault();
        this._dragCounter++;
        if (this._dragCounter === 1) {
            this.overlay.classList.add('visible');
        }
    }

    onDragLeave(e) {
        e.preventDefault();
        this._dragCounter--;
        if (this._dragCounter === 0) {
            this.overlay.classList.remove('visible');
        }
    }

    onDrop(e) {
        e.preventDefault();
        this._dragCounter = 0;
        
        const files = Array.from(e.dataTransfer.files).filter(file => 
            file.type.startsWith('audio/') || file.name.endsWith('.flac') || file.name.endsWith('.mp3')
        );

        if (files.length === 0) {
            this.overlay.classList.remove('visible');
            this.notify('Apenas ficheiros de áudio são permitidos.', false);
            return;
        }

        this.uploadFiles(files);
    }

    uploadFiles(files) {
        this.overlay.classList.add('uploading');
        this.statusText.textContent = `A enviar ${files.length} ficheiro(s)...`;
        this.progressBar.style.width = '0%';

        const formData = new FormData();
        files.forEach(file => formData.append('files', file));

        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/upload', true);

        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
                const pct = (e.loaded / e.total) * 100;
                this.progressBar.style.width = `${pct}%`;
            }
        };

        xhr.onload = () => {
            this.overlay.classList.remove('visible', 'uploading');
            
            if (xhr.status >= 200 && xhr.status < 300) {
                this.notify('Upload concluído! Indexando...', true);
                window.dispatchEvent(new CustomEvent('rolfsound-library-updated'));
            } else {
                this.notify('Erro no upload.', false);
            }
        };

        xhr.onerror = () => {
            this.overlay.classList.remove('visible', 'uploading');
            this.notify('Falha na conexão de rede.', false);
        };

        xhr.send(formData);
    }

    notify(text, isSuccess) {
        const island = document.querySelector('rolfsound-island');
        if (island && typeof island.showNotification === 'function') {
            island.showNotification({ 
                text: text, 
                duration: 3000,
                spinner: isSuccess
            });
        }
    }

    render() {
        this.shadowRoot.innerHTML = `
        <style>
            :host {
                display: block;
                position: fixed; /* Fixa o host para não afetar layout */
                z-index: 9999;
            }

            #upload-overlay {
                position: fixed;
                inset: 0;
                background: rgba(10, 10, 10, 0.6);
                backdrop-filter: blur(12px);
                -webkit-backdrop-filter: blur(12px);
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                opacity: 0;
                pointer-events: none;
                transition: opacity 0.3s ease;
            }

            #upload-overlay.visible {
                opacity: 1;
                pointer-events: auto;
            }

            .drop-box {
                border: 2px dashed rgba(255, 255, 255, 0.3);
                border-radius: 24px;
                padding: 60px;
                text-align: center;
                transition: all 0.3s var(--ease-spring, ease);
                background: rgba(255, 255, 255, 0.05);
            }

            #upload-overlay.visible:not(.uploading) .drop-box {
                transform: scale(1.05);
                border-color: rgba(255, 255, 255, 0.8);
                background: rgba(255, 255, 255, 0.1);
            }

            .icon { color: white; margin-bottom: 16px; }
            h2 { color: white; font-family: sans-serif; font-weight: 600; margin: 0 0 8px 0; font-size: 24px; }
            p { color: rgba(255, 255, 255, 0.6); margin: 0; font-family: sans-serif; }

            /* --- ESTADO UPLOADING --- */
            #progress-container {
                display: none; width: 100%; max-width: 300px; height: 6px;
                background: rgba(255, 255, 255, 0.1); border-radius: 4px;
                margin-top: 24px; overflow: hidden;
            }

            #progress-bar { width: 0%; height: 100%; background: white; transition: width 0.1s linear; }

            #upload-overlay.uploading .drop-box { border-color: transparent; background: transparent; }
            #upload-overlay.uploading .icon, #upload-overlay.uploading p { display: none; }
            #upload-overlay.uploading #progress-container { display: block; }
        </style>

        <div id="upload-overlay">
            <div class="drop-box">
                <svg class="icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="17 8 12 3 7 8"/>
                    <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <h2 id="status-text">Drop music here</h2>
                <p>Support for FLAC, MP3, WAV</p>
                <div id="progress-container">
                    <div id="progress-bar"></div>
                </div>
            </div>
        </div>
        `;
    }
}

// Regista o componente globalmente
customElements.define('rolfsound-global-uploader', UploadController);
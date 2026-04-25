// static/js/ContextMenuController.js
// Menu de clique direito customizado da Dashboard.

export default class ContextMenuController {
    constructor(options = {}) {
        this._island = options.island || null;

        this._menuEl = null;
        this._isOpen = false;
        this._context = null;
        this._items = [];

        this._boundOnContextMenu = this._onContextMenu.bind(this);
        this._boundOnDocumentClick = this._onDocumentClick.bind(this);
        this._boundOnKeydown = this._onKeydown.bind(this);
        this._boundClose = this.close.bind(this);

        this._attach();
    }

    registerItem(item) {
        if (!item || item.type !== 'separator' && !item.id) return;
        this._items.push(item);
    }

    destroy() {
        document.removeEventListener('contextmenu', this._boundOnContextMenu);
        document.removeEventListener('click', this._boundOnDocumentClick, true);
        document.removeEventListener('keydown', this._boundOnKeydown, true);
        window.removeEventListener('blur', this._boundClose);
        window.removeEventListener('resize', this._boundClose);
        document.removeEventListener('scroll', this._boundClose, true);
        this.close();
        if (this._menuEl?.parentNode) this._menuEl.remove();
    }

    _attach() {
        document.addEventListener('contextmenu', this._boundOnContextMenu);
        document.addEventListener('click', this._boundOnDocumentClick, true);
        document.addEventListener('keydown', this._boundOnKeydown, true);
        window.addEventListener('blur', this._boundClose);
        window.addEventListener('resize', this._boundClose);
        document.addEventListener('scroll', this._boundClose, true);
    }

    // Intentionally no default items.
    // Views contribute context-specific actions through `rolfsound-context-build`.

    _onContextMenu(e) {
        if (e.defaultPrevented) return;

        const target = e.target;
        if (target?.closest?.('[data-native-context="true"]')) {
            this.close();
            return;
        }

        const context = this._buildContext(target);
        const items = this._buildVisibleItems(context);
        if (!items.length) {
            this.close();
            return;
        }

        e.preventDefault();
        this.openAt(e.clientX, e.clientY, target, { context, items });
    }

    _onDocumentClick(e) {
        if (!this._isOpen) return;
        if (this._menuEl && this._menuEl.contains(e.target)) return;
        this.close();
    }

    _onKeydown(e) {
        if (e.key === 'Escape' && this._isOpen) {
            this.close();
            return;
        }

        const keyboardContextMenu = e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10');
        if (!keyboardContextMenu) return;

        const focused = document.activeElement || document.body;
        const rect = focused.getBoundingClientRect();
        const x = Math.round(rect.left + Math.min(rect.width / 2, 20));
        const y = Math.round(rect.top + Math.min(rect.height / 2, 20));

        if (this.openAt(x, y, focused)) {
            e.preventDefault();
        }
    }

    openAt(x, y, sourceTarget, prepared = null) {
        this._ensureMenu();
        this._menuEl.classList.remove('active');
        this._menuEl.classList.remove('opening');

        const context = prepared?.context || this._buildContext(sourceTarget);
        const items = prepared?.items || this._buildVisibleItems(context);

        if (!items.length) {
            this.close();
            return false;
        }

        this._context = context;
        this._renderItems(items);

        this._positionMenu(x, y);
        this._prepareMorphFromCursor(x, y);
        this._isOpen = true;

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                if (!this._menuEl) return;
                this._menuEl.classList.remove('opening');
                this._menuEl.classList.add('active');
            });
        });

        window.dispatchEvent(new CustomEvent('rolfsound-context-open', {
            detail: { context, x, y }
        }));

        return true;
    }

    close() {
        if (!this._menuEl) return;
        const wasOpen = this._isOpen;
        this._menuEl.classList.remove('active');
        this._menuEl.classList.remove('opening');
        this._isOpen = false;
        this._context = null;

        if (wasOpen) {
            window.dispatchEvent(new CustomEvent('rolfsound-context-close'));
        }
    }

    _ensureMenu() {
        if (this._menuEl) return;

        const menu = document.createElement('div');
        menu.id = 'rolfsound-context-menu';
        menu.className = 'rs-context-menu';
        menu.setAttribute('role', 'menu');
        menu.setAttribute('aria-label', 'Menu de contexto');
        document.body.appendChild(menu);

        this._menuEl = menu;
    }

    _buildContext(sourceTarget) {
        const selectedText = (window.getSelection?.().toString() || '').trim();
        const activeView = this._island?.getAttribute('active-tab') || 'library';
        const cardElement = sourceTarget?.closest?.('.track-card, .playlist-card') || null;

        return {
            activeView,
            selectedText,
            target: sourceTarget,
            targetTag: sourceTarget?.tagName?.toLowerCase() || '',
            cardElement,
            trackId: cardElement?.dataset?.trackId || ''
        };
    }

    _buildVisibleItems(context) {
        const dynamicItems = [];

        window.dispatchEvent(new CustomEvent('rolfsound-context-build', {
            detail: {
                context,
                items: dynamicItems
            }
        }));

        return [...this._items, ...dynamicItems].filter((item) => {
            if (item.type === 'separator') return true;
            if (typeof item.when === 'function') return !!item.when(context);
            return true;
        });
    }

    _renderItems(items) {
        this._menuEl.innerHTML = '';

        let previousWasSeparator = true;

        items.forEach((item) => {
            if (item.type === 'separator') {
                if (previousWasSeparator) return;
                const sep = document.createElement('div');
                sep.className = 'rs-context-separator';
                this._menuEl.appendChild(sep);
                previousWasSeparator = true;
                return;
            }

            const button = document.createElement('button');
            button.className = 'rs-context-item hover-target';
            if (item.danger) button.classList.add('rs-context-item--danger');
            button.type = 'button';
            button.setAttribute('role', 'menuitem');
            button.setAttribute('title', item.label || item.id);

            const iconEl = document.createElement('span');
            iconEl.className = 'rs-context-item-icon';
            iconEl.setAttribute('aria-hidden', 'true');
            if (item.icon) {
                iconEl.innerHTML = item.icon;
            } else {
                iconEl.textContent = (item.label || item.id || '·')[0].toUpperCase();
            }

            const labelEl = document.createElement('span');
            labelEl.className = 'rs-context-item-label';
            labelEl.textContent = item.label || item.id;

            button.appendChild(iconEl);
            button.appendChild(labelEl);

            if (typeof item.disabled === 'function' ? item.disabled(this._context) : !!item.disabled) {
                button.disabled = true;
            }

            button.addEventListener('click', async () => {
                const actionContext = this._context;
                this.close();

                if (button.disabled || typeof item.action !== 'function') return;

                await item.action(actionContext);

                window.dispatchEvent(new CustomEvent('rolfsound-context-action', {
                    detail: {
                        id: item.id,
                        context: actionContext
                    }
                }));
            });

            this._menuEl.appendChild(button);
            previousWasSeparator = false;
        });

        const last = this._menuEl.lastElementChild;
        if (last && last.classList.contains('rs-context-separator')) {
            last.remove();
        }
    }

    _positionMenu(x, y) {
        this._menuEl.style.left = '0px';
        this._menuEl.style.top = '0px';

        const rect = this._menuEl.getBoundingClientRect();
        const margin = 12;
        // Reserve space for the expanded pill width so it never clips on hover.
        const expandedWidth = 200;

        const safeX = Math.min(x, window.innerWidth - expandedWidth - margin);
        const safeY = Math.min(y, window.innerHeight - rect.height - margin);

        this._menuEl.style.left = `${Math.max(margin, safeX)}px`;
        this._menuEl.style.top = `${Math.max(margin, safeY)}px`;
    }

    _prepareMorphFromCursor(x, y) {
        const rect = this._menuEl.getBoundingClientRect();
        const cursorEl = document.getElementById('cursor-dot');
        const cursorRect = cursorEl?.getBoundingClientRect();

        const seedWidth = Math.max(4, cursorRect?.width || 6);
        const seedHeight = Math.max(4, cursorRect?.height || 6);
        const startScaleX = Math.min(1, seedWidth / Math.max(rect.width, 1));
        const startScaleY = Math.min(1, seedHeight / Math.max(rect.height, 1));

        const originX = Math.max(0, Math.min(rect.width, x - rect.left));
        const originY = Math.max(0, Math.min(rect.height, y - rect.top));
        const startRadius = `${Math.round(Math.max(seedWidth, seedHeight) / 2)}px`;

        this._menuEl.style.setProperty('--rs-origin-x', `${Math.round(originX)}px`);
        this._menuEl.style.setProperty('--rs-origin-y', `${Math.round(originY)}px`);
        this._menuEl.style.setProperty('--rs-start-sx', startScaleX.toFixed(4));
        this._menuEl.style.setProperty('--rs-start-sy', startScaleY.toFixed(4));
        this._menuEl.style.setProperty('--rs-start-radius', startRadius);

        this._menuEl.classList.remove('active');
        this._menuEl.classList.add('opening');

        // Garante que o navegador pinte o estado inicial antes da expansão.
        void this._menuEl.offsetWidth;
    }
}

const DEFAULT_CLAIM = {
  scrim: 'var(--color-bg-scrim)',
  blur: 'var(--blur-overlay)',
  zIndex: 990,
  interactive: false,
  duration: 320,
  onBackdropClick: null,
};

class OverlayBackdropController {
  constructor() {
    this._claims = new Map();
    this._element = null;
    this._hideTimer = null;
    this._sequence = 0;
    this._handleClick = this._handleClick.bind(this);
  }

  show(id, options = {}) {
    if (!id) return null;
    const claim = {
      ...DEFAULT_CLAIM,
      ...options,
      id,
      order: ++this._sequence,
    };
    this._claims.set(id, claim);
    this._ensureElement();
    this._applyTopClaim();
    return this._element;
  }

  hide(id) {
    if (!id) return;
    this._claims.delete(id);
    if (!this._claims.size) {
      this._hideElement();
      return;
    }
    this._applyTopClaim();
  }

  hideAll() {
    this._claims.clear();
    this._hideElement();
  }

  _ensureElement() {
    if (this._element?.isConnected) return;
    this._element = document.createElement('div');
    this._element.className = 'rs-overlay-backdrop';
    this._element.setAttribute('aria-hidden', 'true');
    this._element.addEventListener('click', this._handleClick);
    document.body.appendChild(this._element);
  }

  _applyTopClaim() {
    const claim = this._topClaim();
    if (!claim || !this._element) return;

    if (this._hideTimer) {
      window.clearTimeout(this._hideTimer);
      this._hideTimer = null;
    }

    this._element.style.setProperty('--rs-overlay-backdrop-bg', claim.scrim);
    this._element.style.setProperty('--rs-overlay-backdrop-blur', claim.blur);
    this._element.style.setProperty('--rs-overlay-backdrop-duration', `${claim.duration}ms`);
    this._element.style.zIndex = String(claim.zIndex);
    this._element.classList.toggle('is-interactive', !!claim.interactive);

    requestAnimationFrame(() => {
      if (!this._element || !this._claims.size) return;
      this._element.classList.add('is-active');
    });
  }

  _hideElement() {
    const element = this._element;
    if (!element) return;
    const duration = Number.parseInt(
      element.style.getPropertyValue('--rs-overlay-backdrop-duration'),
      10,
    ) || DEFAULT_CLAIM.duration;

    element.classList.remove('is-active', 'is-interactive');
    this._hideTimer = window.setTimeout(() => {
      element.removeEventListener('click', this._handleClick);
      element.remove();
      if (this._element === element) this._element = null;
      this._hideTimer = null;
    }, duration + 40);
  }

  _topClaim() {
    return Array.from(this._claims.values()).sort((a, b) => a.order - b.order).at(-1) || null;
  }

  _handleClick(event) {
    if (event.target !== this._element) return;
    const claim = this._topClaim();
    if (typeof claim?.onBackdropClick === 'function') {
      claim.onBackdropClick(event);
    }
  }
}

export default new OverlayBackdropController();

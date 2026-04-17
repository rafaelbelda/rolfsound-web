// static/js/playback/ThumbnailCrossfader.js
// Thumbnail crossfade loader for the playback player cover.
import AnimationEngine from '/static/js/AnimationEngine.js';

export default class ThumbnailCrossfader {
  constructor(manager) {
    this._m      = manager;
    this._currentEl = null;
    this._pendingEl = null;
  }

  thumbSrc(thumbnail) {
    if (!thumbnail) return null;
    if (thumbnail.startsWith('http') || thumbnail.startsWith('/thumbs/')) return thumbnail;
    return '/thumbs/' + thumbnail.split(/[\\/]/).pop();
  }

  getThumbnailCandidates(thumbnail, trackId = '') {
    const normalized = this.thumbSrc(thumbnail);
    const candidates = [];
    const youtubeId  = typeof trackId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(trackId)
      ? trackId : '';

    if (normalized) {
      if (normalized.includes('i.ytimg.com/vi/')) {
        candidates.push(normalized.replace(/\/(?:default|mqdefault|hqdefault|sddefault|maxresdefault)\.(?:jpg|webp).*$/i, '/maxresdefault.jpg'));
        candidates.push(normalized.replace(/\/(?:default|mqdefault|hqdefault|sddefault|maxresdefault)\.(?:jpg|webp).*$/i, '/hqdefault.jpg'));
      }
      candidates.push(normalized);
    }

    if (youtubeId && !normalized) {
      candidates.push(`https://i.ytimg.com/vi/${youtubeId}/maxresdefault.jpg`);
      candidates.push(`https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`);
    }

    return [...new Set(candidates.filter(Boolean))];
  }

  update() {
    const m = this._m;
    if (!m.dom.thumbnail) return;

    const candidates = this.getThumbnailCandidates(m.state.currentTrack.thumbnail, m.state.currentId);
    if (!candidates.length) { this.reset(); return; }

    const thumbKey = `${m.state.currentId || ''}|${m.state.currentTrack.thumbnail || ''}`;

    if (this._currentEl?.dataset.thumbKey === thumbKey) return;
    if (this._pendingEl?.dataset.thumbKey === thumbKey) return;

    if (this._pendingEl) {
      this._pendingEl.onload  = null;
      this._pendingEl.onerror = null;
      this._pendingEl.remove();
      this._pendingEl = null;
    }

    const container = m.dom.thumbnail;
    if (getComputedStyle(container).position === 'static') {
      container.style.position = 'relative';
    }

    const incoming = document.createElement('img');
    incoming.dataset.thumbKey = thumbKey;
    incoming.style.cssText = `
      position: absolute; inset: 0;
      width: 100%; height: 100%;
      object-fit: cover; display: block;
      opacity: 0; transition: opacity 0.32s ease;
    `;
    this._pendingEl = incoming;

    const tryLoad = (index = 0) => {
      const src = candidates[index];
      if (!src) {
        if (this._pendingEl === incoming) this._pendingEl = null;
        this.reset();
        return;
      }

      incoming.onload = () => {
        if (this._pendingEl !== incoming) return;
        this._pendingEl = null;

        incoming.dataset.src = src;
        container.appendChild(incoming);
        incoming.getBoundingClientRect(); // force reflow for transition
        incoming.style.opacity = '1';

        const prev = this._currentEl;
        this._currentEl = incoming;

        const cleanupPrev = () => {
          if (prev?.parentNode === container) prev.remove();
          if (incoming.parentNode === container && this._currentEl === incoming) {
            incoming.style.position   = '';
            incoming.style.inset      = '';
            incoming.style.transition = '';
          }
        };
        let cleaned = false;
        const safeCleanup = () => { if (!cleaned) { cleaned = true; cleanupPrev(); } };
        incoming.addEventListener('transitionend', safeCleanup, { once: true });
        AnimationEngine.schedule(m, safeCleanup, 500, '_thumbCleanup');
      };

      incoming.onerror = () => {
        if (this._pendingEl !== incoming) return;
        tryLoad(index + 1);
      };

      incoming.src = src;
    };

    tryLoad();
  }

  reset() {
    const m = this._m;
    if (!m.dom.thumbnail) return;

    if (this._pendingEl) {
      this._pendingEl.onload  = null;
      this._pendingEl.onerror = null;
      this._pendingEl = null;
    }
    this._currentEl = null;

    if (!m.dom.thumbnail.querySelector('svg')) {
      m.dom.thumbnail.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--color-playback-icon-muted)"
             style="width: 72px; height: 72px; stroke-width: 1.0;">
          <circle cx="12" cy="12" r="10"/>
          <polygon points="10,8 16,12 10,16"/>
        </svg>
      `;
    }
  }

  prefill(container) {
    const m = this._m;
    if (!m.state.currentId) return;

    const thumbEl = container.querySelector('#playback-thumbnail');
    if (!thumbEl) return;

    const candidates = this.getThumbnailCandidates(m.state.currentTrack.thumbnail, m.state.currentId);
    if (!candidates.length) return;

    const thumbKey = `${m.state.currentId || ''}|${m.state.currentTrack.thumbnail || ''}`;

    if (this._pendingEl) {
      this._pendingEl.onload  = null;
      this._pendingEl.onerror = null;
      this._pendingEl = null;
    }

    const img = document.createElement('img');
    img.style.cssText = 'width: 100%; height: 100%; object-fit: cover; display: block; opacity: 0;';
    img.dataset.thumbKey = thumbKey;
    this._pendingEl = img;

    const tryLoad = (index = 0) => {
      const src = candidates[index];
      if (!src) {
        if (this._pendingEl === img) this._pendingEl = null;
        return;
      }

      img.onload = () => {
        if (!container.isConnected) return;
        if (this._pendingEl !== img) return;
        this._pendingEl = null;

        img.dataset.src = src;
        thumbEl.innerHTML = '';
        thumbEl.appendChild(img);
        img.style.transition = 'opacity 0.4s ease';
        img.style.opacity    = '1';
        this._currentEl = img;
      };

      img.onerror = () => tryLoad(index + 1);
      img.src = src;
    };

    tryLoad();
  }

  destroy() {
    if (this._pendingEl) {
      this._pendingEl.onload  = null;
      this._pendingEl.onerror = null;
      this._pendingEl = null;
    }
    this._currentEl = null;
  }
}

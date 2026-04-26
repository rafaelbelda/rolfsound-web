// static/js/features/player/NowPlayingThemeController.js
// Orchestrates the reactive now-playing theme:
// 1. listen for rolfsound-now-playing-changed from playback-mitosis.js
// 2. resolve the best cover URL candidates
// 3. extract and normalize a palette
// 4. publish it to the global reactive backdrop
// 5. emit rolfsound-theme-change for surfaces that inherit the theme

import ColorPaletteExtractor from '/static/js/features/animations/ColorPaletteExtractor.js?v=theme-fidelity-20260426';
import PaletteNormalizer from '/static/js/features/animations/PaletteNormalizer.js?v=theme-fidelity-20260426';
import ReactiveBackdropController from '/static/js/features/player/ReactiveBackdropController.js?v=theme-fidelity-20260426';
import { getThumbnailCandidates } from '/static/js/utils/thumbnails.js?v=theme-fidelity-20260426';

export default class NowPlayingThemeController {
  /**
   * @param {object} [options]
   * @param {number} [options.transitionMs=2400]
   * @param {number} [options.intensityOnMs=900]
   * @param {number} [options.intensityOffMs=1600]
   */
  constructor(options = {}) {
    this._backdrop = new ReactiveBackdropController({
      transitionMs:   options.transitionMs   ?? 2400,
      intensityOnMs:  options.intensityOnMs  ?? 900,
      intensityOffMs: options.intensityOffMs ?? 1600,
    });

    this._currentKey = null;
    this._pendingKey = null;

    this._preextractedKey = null;
    this._preextractedPalette = null;
    this._preextractingKey = null;

    this._onNowPlaying = this._handleNowPlaying.bind(this);
    window.addEventListener('rolfsound-now-playing-changed', this._onNowPlaying);
  }

  destroy() {
    window.removeEventListener('rolfsound-now-playing-changed', this._onNowPlaying);
    this._backdrop.destroy();
    this._currentKey = null;
    this._pendingKey = null;
    this._preextractedKey = null;
    this._preextractedPalette = null;
    this._preextractingKey = null;
  }

  async _handleNowPlaying(event) {
    const { trackId, thumbnail, source, state, nextTrack } = event.detail ?? {};

    if (!trackId || state !== 'playing') {
      this._currentKey = null;
      this._pendingKey = null;
      this._preextractedKey = null;
      this._preextractedPalette = null;
      this._preextractingKey = null;
      this._backdrop.applyNeutral();
      return;
    }

    const trackKey = `${trackId}|${thumbnail ?? ''}`;
    if (trackKey === this._currentKey) return;
    if (trackKey === this._pendingKey) return;

    this._pendingKey = trackKey;

    let normalized = null;
    if (this._preextractedKey === trackKey && this._preextractedPalette) {
      normalized = this._preextractedPalette;
      this._preextractedKey = null;
      this._preextractedPalette = null;
    } else {
      const urls = NowPlayingThemeController._resolveCoverUrls(trackId, thumbnail, source);
      const raw = await this._extractWithFallback(urls, trackKey);
      if (this._pendingKey !== trackKey) return;

      if (!raw) {
        this._pendingKey = null;
        this._currentKey = null;
        this._backdrop.applyNeutral();
        return;
      }

      normalized = PaletteNormalizer.normalize(raw);
    }

    if (this._pendingKey !== trackKey) return;
    this._pendingKey = null;
    this._currentKey = trackKey;

    this._backdrop.applyPalette(normalized, trackKey);

    window.dispatchEvent(new CustomEvent('rolfsound-theme-change', {
      detail: { palette: normalized, trackKey },
    }));

    if (nextTrack) this._preextractTrack(nextTrack);
  }

  async _extractWithFallback(urls, trackKey) {
    if (!urls?.length) return null;

    for (const url of urls) {
      if (this._pendingKey !== trackKey) return null;

      const palette = await ColorPaletteExtractor.extract(url, trackKey);
      if (palette) return palette;
    }
    return null;
  }

  async _preextractTrack(track) {
    const trackId = track?.id || track?.track_id;
    if (!trackId) return;

    const thumbnail = track.thumbnail || '';
    const source = track.source || (String(trackId).length === 11 ? 'youtube' : 'local');
    const trackKey = `${trackId}|${thumbnail}`;

    if (trackKey === this._currentKey) return;
    if (trackKey === this._pendingKey) return;
    if (trackKey === this._preextractedKey) return;
    if (trackKey === this._preextractingKey) return;

    const urls = NowPlayingThemeController._resolveCoverUrls(trackId, thumbnail, source);
    if (!urls.length) return;

    this._preextractingKey = trackKey;

    for (const url of urls) {
      if (this._preextractingKey !== trackKey) return;

      const raw = await ColorPaletteExtractor.extract(url, trackKey);
      if (!raw) continue;

      if (this._preextractingKey !== trackKey) return;
      this._preextractedKey = trackKey;
      this._preextractedPalette = PaletteNormalizer.normalize(raw);
      this._preextractingKey = null;
      return;
    }

    if (this._preextractingKey === trackKey) this._preextractingKey = null;
  }

  static _resolveCoverUrls(trackId, thumbnail, source) {
    return getThumbnailCandidates({ thumbnail, id: trackId, track_id: trackId, source });
  }
}

// static/js/NowPlayingThemeController.js
// Orquestrador do sistema de tema reativo.
// É o único módulo que conhece todos os outros — os outros não se conhecem.
//
// Fluxo:
//   1. escuta `rolfsound-now-playing-changed` (evento emitido por playback-mitosis.js)
//   2. resolve a melhor URL de capa disponível
//   3. pede extração via ColorPaletteExtractor (com cache automático)
//   4. normaliza via PaletteNormalizer
//   5. publica a paleta em ReactiveBackdropController
//   6. emite `rolfsound-theme-change` para qualquer módulo que queira reagir
//
// Regras:
//   - deduplicação estrita por trackKey (mesma faixa tocando = zero trabalho)
//   - CORS fallback: tenta URL de /thumbs/ local se o servidor remoto rejeitar
//   - idle/stop → chama applyNeutral() com fade lento

import ColorPaletteExtractor from '/static/js/ColorPaletteExtractor.js';
import PaletteNormalizer     from '/static/js/PaletteNormalizer.js';
import ReactiveBackdropController from '/static/js/ReactiveBackdropController.js';

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
      intensityOffMs: options.intensityOffMs ?? 1600
    });

    this._currentKey  = null;   // trackKey atualmente renderizado
    this._pendingKey  = null;   // trackKey sendo extraído (evita corrida)

    // Pré-extração da próxima faixa da queue — acelera o início da transição
    this._preextractedKey     = null;   // key da paleta pré-extraída
    this._preextractedPalette = null;   // paleta normalizada pronta para uso imediato

    this._onNowPlaying = this._handleNowPlaying.bind(this);
    window.addEventListener('rolfsound-now-playing-changed', this._onNowPlaying);
  }

  destroy() {
    window.removeEventListener('rolfsound-now-playing-changed', this._onNowPlaying);
    this._backdrop.destroy();
    this._currentKey = null;
    this._pendingKey = null;
  }

  // ─── Handler principal ───────────────────────────────────────────────────

  async _handleNowPlaying(event) {
    const { trackId, thumbnail, source, state, nextTrack } = event.detail ?? {};

    // Só aplica cores quando explicitamente playing — qualquer outro estado vai a neutro.
    // Isso cobre 'paused', 'idle', 'stopped', e qualquer estado inesperado do servidor.
    if (!trackId || state !== 'playing') {
      this._currentKey = null;
      this._pendingKey = null;
      this._backdrop.applyNeutral();
      return;
    }

    const trackKey = `${trackId}|${thumbnail ?? ''}`;

    // Já renderizado → nada a fazer
    if (trackKey === this._currentKey) return;

    // Já está sendo processado → não duplicar
    if (trackKey === this._pendingKey) return;

    this._pendingKey = trackKey;

    // ─ Verifica se a próxima faixa foi pré-extraída enquanto a atual tocava ─
    let normalized = null;
    if (this._preextractedKey === trackKey && this._preextractedPalette) {
      normalized = this._preextractedPalette;
      this._preextractedKey     = null;
      this._preextractedPalette = null;
    } else {
      const urls = NowPlayingThemeController._resolveCoverUrls(trackId, thumbnail, source);
      if (!urls.length) {
        this._backdrop.applyNeutral();
        this._pendingKey = null;
        return;
      }

      const raw = await this._extractWithFallback(urls, trackKey);

      // Verifica se outra faixa não ganhou a corrida durante o await
      if (this._pendingKey !== trackKey) return;

      if (!raw) {
        // Extracção falhou totalmente → mantém estado atual sem piscar
        this._pendingKey = null;
        return;
      }

      normalized = PaletteNormalizer.normalize(raw);
    }

    // Verifica novamente após qualquer await
    if (this._pendingKey !== trackKey) return;
    this._pendingKey = null;

    this._currentKey = trackKey;
    this._backdrop.applyPalette(normalized, trackKey);

    window.dispatchEvent(new CustomEvent('rolfsound-theme-change', {
      detail: { palette: normalized, trackKey }
    }));

    // Pré-extrai cores da próxima faixa da queue enquanto a atual está tocando
    if (nextTrack) {
      this._preextractTrack(nextTrack);
    }
  }

  // ─── Extração com fallback entre candidatos ──────────────────────────────

  async _extractWithFallback(urls, trackKey) {
    for (const url of urls) {
      // Se o trackKey mudou (faixa trocada durante await), aborta
      if (this._pendingKey !== trackKey) return null;

      const palette = await ColorPaletteExtractor.extract(url, trackKey);
      if (palette) return palette;
    }
    return null;
  }

  // ─── Resolução da melhor URL de capa ────────────────────────────────────
  // Prioridade: maxresdefault → hqdefault → local /thumbs/
  // As URLs YouTube têm CORS headers ( Access-Control-Allow-Origin: * ),
  // então a maioria funciona. O fallback local é para tracks offline.

  static _resolveCoverUrls(trackId, thumbnail, source) {
    const urls = [];
    const isYouTubeId = typeof trackId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(trackId);

    if (isYouTubeId) {
      urls.push(`https://i.ytimg.com/vi/${trackId}/maxresdefault.jpg`);
      urls.push(`https://i.ytimg.com/vi/${trackId}/hqdefault.jpg`);
    }

    // Normaliza thumbnail local → /thumbs/<filename>
    if (thumbnail) {
      const normalized = thumbnail.startsWith('http') || thumbnail.startsWith('/thumbs/')
        ? thumbnail
        : `/thumbs/${thumbnail.split(/[\\/]/).pop()}`;

      if (normalized && !urls.includes(normalized)) {
        urls.push(normalized);
      }
    }

    return urls;
  }
}

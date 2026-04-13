// static/js/ReactiveBackdropController.js
// Controla a camada de fundo reativa da "caixa de luz".
// Opera SOMENTE em CSS custom properties no :root — nenhum componente da UI
// precisa saber que existe: eles já usam tokens como backdrop-filter + rgba.
//
// Estado:
//   - idle/neutro → fundo escuro sóbrio, sem cor
//   - tocando     → degradê vivo com as 3 cores do álbum, animação suave
//
// Layers do backdrop (renderizadas via .bg-layer em index.html):
//   #rs-bg-base    → massa escura dominante (radial gradient centrado)
//   #rs-bg-accent  → bloom do accent (canto superior, baixa opacidade)
//   #rs-bg-contrast → bloom do contrast (canto inferior oposto)
//
// Tokens CSS publicados em :root:
//   --rs-theme-base-rgb, --rs-theme-accent-rgb, --rs-theme-contrast-rgb
//   --rs-theme-intensity  (0 → neutro, 1 → plena saturação)

export default class ReactiveBackdropController {
  /** @param {object} options
   *  @param {number} [options.transitionMs=2400] — duração da transição entre temas
   *  @param {number} [options.intensityOnMs=900]  — tempo para subir a intensidade
   *  @param {number} [options.intensityOffMs=1600] — tempo para sumir a cor
   */
  constructor(options = {}) {
    this._transitionMs   = options.transitionMs   ?? 2400;
    this._intensityOnMs  = options.intensityOnMs  ?? 900;
    this._intensityOffMs = options.intensityOffMs ?? 1600;

    this._currentKey    = null;  // trackKey da paleta atualmente renderizada
    this._layersOpacity = 0;     // valor real de opacity das layers (rastreado em JS)

    // ── RAF de intensidade (--rs-theme-intensity) ──
    this._intensityRafId = null;
    this._intensityFrom  = 0;
    this._intensityTo    = 0;
    this._intensityStart = 0;
    this._intensityDur   = 0;

    // ── RAF de interpolação RGB (cross-fade real de gradiente) ──
    // CSS não interpola entre radial-gradient() — fazemos em JS frame-a-frame
    this._colorRafId  = null;
    this._colorFrom   = null;    // snapshot RGB no início da transição
    this._colorTarget = null;    // RGB destino
    this._colorStart  = 0;
    this._colorDur    = 0;

    // Valores RGB atualmente renderizados (atualizados tick-a-tick pelo color RAF)
    this._renderedRgb = {
      base:     [5, 5, 5],
      accent:   [18, 18, 18],
      contrast: [12, 12, 12]
    };

    this._layers = {
      base:     null,
      accent:   null,
      contrast: null
    };

    // ── Ambient breathing loop ──
    // Simula reatividade ao áudio (grave/médio/agudo) sem acesso ao stream
    // (reprodução é server-side via sounddevice). Roda só durante playback.
    this._ambientRafId = null;
    this._ambientStart = 0;
    this._ambientBound = this._ambientTick.bind(this); // bound once — zero GC per frame

    this._ensureLayers();
    this._readGradientConfig();
    this._applyNeutral(/* instant */ true);
  }

  // ─── API pública ─────────────────────────────────────────────────────────

  /**
   * Lê os CSS vars de geometria do backdrop e os armazena em `this._gc`.
   * Chamado no constructor e ao chamar `refreshGradientConfig()`.
   * Leitura única (não por frame) — custo de `getComputedStyle` é irrelevante aqui.
   */
  _readGradientConfig() {
    const s   = getComputedStyle(document.documentElement);
    const str = (v, d) => s.getPropertyValue(v).trim() || d;
    const num = (v, d) => { const p = parseFloat(s.getPropertyValue(v)); return isFinite(p) ? p : d; };

    this._gc = {
      baseShape:         str('--rs-backdrop-base-shape',         '130% 100%'),
      basePos:           str('--rs-backdrop-base-pos',           '50% 60%'),
      baseOpMid:         num('--rs-backdrop-base-op-mid',        0.5),
      baseOpEdge:        num('--rs-backdrop-base-op-edge',       0.95),
      accentShape:       str('--rs-backdrop-accent-shape',       '80% 55%'),
      accentPos:         str('--rs-backdrop-accent-pos',         '25% 8%'),
      accentOpPeak:      num('--rs-backdrop-accent-op-peak',     0.55),
      accentOpFade:      num('--rs-backdrop-accent-op-fade',     0.15),
      contrastShape:     str('--rs-backdrop-contrast-shape',     '70% 50%'),
      contrastPos:       str('--rs-backdrop-contrast-pos',       '78% 95%'),
      contrastOpPeak:    num('--rs-backdrop-contrast-op-peak',   0.45),
      contrastOpFade:    num('--rs-backdrop-contrast-op-fade',   0.12),
    };
  }

  /**
   * Re-reads CSS gradient geometry vars.
   * Call this if you override the `--rs-backdrop-*` vars at runtime and want
   * the new values to take effect immediately on the next rendered frame.
   */
  refreshGradientConfig() {
    this._readGradientConfig();
  }

  /**
   * Aplica uma paleta normalizada ao fundo.
   * @param {{ base: string, accent: string, contrast: string }} palette — formato 'R G B'
   * @param {string} key — chave única da faixa (para deduplicação)
   */
  applyPalette(palette, key) {
    if (key === this._currentKey) return;
    this._currentKey = key;

    const targetRgb = {
      base:     ReactiveBackdropController._parseRgb(palette.base),
      accent:   ReactiveBackdropController._parseRgb(palette.accent),
      contrast: ReactiveBackdropController._parseRgb(palette.contrast)
    };

    // Torna as layers visíveis se ainda estão em opacity 0 (primeira faixa)
    if (Math.abs(this._layersOpacity - 1) > 0.01) {
      this._setLayersOpacity(1, this._intensityOnMs);
    }

    // Interpola cada canal RGB frame-a-frame → cross-fade real de gradiente
    this._startColorTransition(targetRgb, this._transitionMs);
    this._animateIntensityTo(1, this._intensityOnMs);
    this._startAmbientLoop();
  }

  /**
   * Retorna o backdrop ao estado neutro/sóbrio (sem música ou idle).
   * @param {boolean} [instant=false]
   */
  applyNeutral(instant = false) {
    this._currentKey = null;
    this._stopAmbientLoop();
    this._applyNeutral(instant);
  }

  // ─── Ambient breathing loop ─────────────────────────────────────────────
  //
  // Como o áudio é reproduzido pelo backend (sounddevice/PortAudio), o browser
  // não tem acesso ao stream para análise real. Em vez disso, usamos ondas seno
  // em frequências incomensurabilizadas (nenhum par tem razão racional simples)
  // para gerar padrões que nunca se repetem exatamente — simula grave/médio/agudo.
  //
  // Frequências:   0.41 Hz  ≈ sub-grave (peso lento)
  //                0.73 Hz  ≈ grave      (batida orgânica)
  //                1.97 Hz  ≈ médio      (presença)
  //                5.13 Hz  ≈ agudo      (brilho sutil)
  //
  // Amplitudes máximas: accent ±7%, contrast ±5.5%  →  variação perceptível mas sutil.
  // Accent e contrast têm fases distintas — criam contramovimento de profundidade.
  //
  // Tecnicamente: filter:brightness() por RAF (GPU compositor), sem layout recalc.

  _startAmbientLoop() {
    if (this._ambientRafId) return;           // já rodando (track change não reinicia)
    this._ambientStart = performance.now();
    this._ambientRafId = requestAnimationFrame(this._ambientBound);
  }

  _stopAmbientLoop() {
    if (this._ambientRafId) {
      cancelAnimationFrame(this._ambientRafId);
      this._ambientRafId = null;
    }
    // Limpa o filtro residual para não travar num brightness != 1
    if (this._layers.accent)   this._layers.accent.style.filter   = '';
    if (this._layers.contrast) this._layers.contrast.style.filter = '';
  }

  _ambientTick(ts) {
    this._ambientRafId = requestAnimationFrame(this._ambientBound);
    const t = (ts - this._ambientStart) * 0.001; // ms → segundos

    // Constantes pré-calculadas: 2π × frequência
    //   2π×0.41  ≈ 2.576   2π×1.97  ≈ 12.38
    //   2π×0.73  ≈ 4.587   2π×5.13  ≈ 32.23

    // Camada accent — quente, guiada pelo sub-grave
    const bassA = Math.sin(t * 2.576)  * 0.045;  // sub-grave: ±4.5%
    const midA  = Math.sin(t * 12.38)  * 0.018;  // médio:     ±1.8%
    const hiA   = Math.sin(t * 32.23)  * 0.007;  // agudo:     ±0.7%

    // Camada contrast — fora de fase, cria contramovimento
    const bassC = Math.sin(t * 4.587)          * 0.038;  // grave:  ±3.8%  (freq diferente)
    const midC  = Math.sin(t * 12.38 + 1.99)   * 0.017;  // médio: ±1.7%  (fase deslocada)

    const bAccent   = (1 + bassA + midA + hiA).toFixed(3);
    const bContrast = (1 + bassC + midC).toFixed(3);

    if (this._layers.accent)   this._layers.accent.style.filter   = `brightness(${bAccent})`;
    if (this._layers.contrast) this._layers.contrast.style.filter = `brightness(${bContrast})`;
  }

  destroy() {
    this._cancelColorRaf();
    this._cancelIntensityRaf();
    this._stopAmbientLoop();

    Object.values(this._layers).forEach(el => el?.remove());
    this._layers = { base: null, accent: null, contrast: null };

    const root = document.documentElement;
    ['--rs-theme-base-rgb', '--rs-theme-accent-rgb', '--rs-theme-contrast-rgb', '--rs-theme-intensity']
      .forEach(v => root.style.removeProperty(v));
  }

  // ─── Layers ──────────────────────────────────────────────────────────────

  _ensureLayers() {
    // Insere atrás de tudo mas na frente de <body> — usa #rs-bg-* IDs para idempotência
    const insert = (id, zIndex, willChange = 'opacity') => {
      let el = document.getElementById(id);
      if (!el) {
        el = document.createElement('div');
        el.id = id;
        // background não tem transition CSS — o JS RAF de cor cuida da interpolação
        el.style.cssText = `
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: ${zIndex};
          opacity: 0;
          will-change: ${willChange};
        `;
        document.body.insertBefore(el, document.body.firstChild);
      }
      return el;
    };

    // Accent + contrast layers animam filter:brightness() a cada frame — promove a filter
    this._layers.base     = insert('rs-bg-base',     1, 'opacity');
    this._layers.accent   = insert('rs-bg-accent',   2, 'opacity, filter');
    this._layers.contrast = insert('rs-bg-contrast', 3, 'opacity, filter');
  }

  // Reconstrói os gradientes com os valores RGB atualmente interpolados.
  // Chamado a cada frame pelo color RAF — sem CSS transition, o browser pinta direto.
  _applyRenderedRgbToLayers() {
    const b = ReactiveBackdropController._fmtRgb(this._renderedRgb.base);
    const a = ReactiveBackdropController._fmtRgb(this._renderedRgb.accent);
    const c = ReactiveBackdropController._fmtRgb(this._renderedRgb.contrast);
    const { base: lBase, accent: lAccent, contrast: lContrast } = this._layers;
    const g = this._gc;

    if (lBase) {
      lBase.style.background = `
        radial-gradient(ellipse ${g.baseShape} at ${g.basePos},
          rgb(${b}) 0%,
          rgb(${b}) 30%,
          rgba(${b} / ${g.baseOpMid}) 65%,
          rgba(5 5 5 / ${g.baseOpEdge}) 100%
        )
      `;
    }
    if (lAccent) {
      lAccent.style.background = `
        radial-gradient(ellipse ${g.accentShape} at ${g.accentPos},
          rgba(${a} / ${g.accentOpPeak}) 0%,
          rgba(${a} / ${g.accentOpFade}) 50%,
          transparent 100%
        )
      `;
    }
    if (lContrast) {
      lContrast.style.background = `
        radial-gradient(ellipse ${g.contrastShape} at ${g.contrastPos},
          rgba(${c} / ${g.contrastOpPeak}) 0%,
          rgba(${c} / ${g.contrastOpFade}) 50%,
          transparent 100%
        )
      `;
    }
  }

  // Publica os RGB interpolados como CSS vars para componentes externos
  _publishCssVars() {
    const root = document.documentElement;
    root.style.setProperty('--rs-theme-base-rgb',     ReactiveBackdropController._fmtRgb(this._renderedRgb.base));
    root.style.setProperty('--rs-theme-accent-rgb',   ReactiveBackdropController._fmtRgb(this._renderedRgb.accent));
    root.style.setProperty('--rs-theme-contrast-rgb', ReactiveBackdropController._fmtRgb(this._renderedRgb.contrast));
  }

  // ─── Neutro ──────────────────────────────────────────────────────────────

  _applyNeutral(instant) {
    this._cancelColorRaf();

    // Reinicia o RGB para neutro — a próxima faixa sempre fará fade-in a partir
    // do preto, sem herdar resíduos de cor da faixa anterior
    this._renderedRgb = {
      base:     [5, 5, 5],
      accent:   [18, 18, 18],
      contrast: [12, 12, 12]
    };

    this._cancelIntensityRaf();
    this._setLayersOpacity(0, instant ? 0 : this._intensityOffMs);
    document.documentElement.style.setProperty('--rs-theme-intensity', '0');
  }

  // ─── Intensidade (fade suave entre neutro e saturado) ────────────────────

  _animateIntensityTo(targetIntensity, durationMs) {
    this._cancelIntensityRaf();

    const root = document.documentElement;
    const from = parseFloat(root.style.getPropertyValue('--rs-theme-intensity') || '0');
    this._intensityFrom  = from;
    this._intensityTo    = targetIntensity;
    this._intensityStart = performance.now();
    this._intensityDur   = durationMs;

    const tick = (now) => {
      const t     = Math.min(1, (now - this._intensityStart) / this._intensityDur);
      const eased = ReactiveBackdropController._easeOut(t);
      const val   = from + (targetIntensity - from) * eased;
      root.style.setProperty('--rs-theme-intensity', val.toFixed(4));
      if (t < 1) {
        this._intensityRafId = requestAnimationFrame(tick);
      } else {
        this._intensityRafId = null;
      }
    };

    this._intensityRafId = requestAnimationFrame(tick);
  }

  _setLayersOpacity(target, transitionMs) {
    this._layersOpacity = target;
    Object.values(this._layers).forEach(el => {
      if (!el) return;
      el.style.transition = transitionMs > 0 ? `opacity ${transitionMs}ms ease` : 'none';
      el.style.opacity    = target;
    });
  }

  _cancelIntensityRaf() {
    if (this._intensityRafId) {
      cancelAnimationFrame(this._intensityRafId);
      this._intensityRafId = null;
    }
  }

  // ─── Interpolação de cor ─────────────────────────────────────────────────

  _startColorTransition(targetRgb, durationMs) {
    this._cancelColorRaf();

    // Congela snapshot do estado atual antes de começar a interp
    this._colorFrom = {
      base:     [...this._renderedRgb.base],
      accent:   [...this._renderedRgb.accent],
      contrast: [...this._renderedRgb.contrast]
    };
    this._colorTarget = targetRgb;
    this._colorStart  = performance.now();
    this._colorDur    = durationMs;

    const tick = (now) => {
      const t     = Math.min(1, (now - this._colorStart) / this._colorDur);
      const eased = ReactiveBackdropController._easeInOut(t);

      this._renderedRgb = {
        base:     ReactiveBackdropController._lerpRgb(this._colorFrom.base,     this._colorTarget.base,     eased),
        accent:   ReactiveBackdropController._lerpRgb(this._colorFrom.accent,   this._colorTarget.accent,   eased),
        contrast: ReactiveBackdropController._lerpRgb(this._colorFrom.contrast, this._colorTarget.contrast, eased)
      };

      this._applyRenderedRgbToLayers();
      this._publishCssVars();

      if (t < 1) {
        this._colorRafId = requestAnimationFrame(tick);
      } else {
        this._colorRafId = null;
      }
    };

    this._colorRafId = requestAnimationFrame(tick);
  }

  _cancelColorRaf() {
    if (this._colorRafId) {
      cancelAnimationFrame(this._colorRafId);
      this._colorRafId = null;
    }
  }

  // ─── Easing & helpers estáticos ──────────────────────────────────────────

  // ease-in-out quadrático — melhor para transições bidirecionais de cor
  static _easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  // cubic ease-out — para intensidade (sobe rápido, estabiliza suave)
  static _easeOut(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  // Parse '128 64 200' → [128, 64, 200]
  static _parseRgb(str) {
    return str.trim().split(/\s+/).map(Number);
  }

  // Lerp linear entre dois arrays RGB
  static _lerpRgb([r1, g1, b1], [r2, g2, b2], t) {
    return [r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t];
  }

  // [r, g, b] → '128 64 200'
  static _fmtRgb([r, g, b]) {
    return `${Math.round(r)} ${Math.round(g)} ${Math.round(b)}`;
  }
}

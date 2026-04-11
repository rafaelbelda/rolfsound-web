// static/js/PaletteNormalizer.js
// Domestica cores brutas extraídas da capa — sem isso o UI vira neon ou fica ilegível.
//
// Estratégia:
//   - Converte RGB ↔ HSL para manipulação perceptual
//   - Garante que base seja escura e com baixa saturação (fundo sóbrio)
//   - Garante que accent seja vibrante mas não saturado demais
//   - Garante que contrast seja distinto de base em hue e luminância
//   - Se a paleta for muito monocromática, deriva as cores em falta

export default class PaletteNormalizer {
  /**
   * Recebe paleta bruta e devolve paleta normalizada para uso em CSS vars.
   * @param {{ base: string, accent: string, contrast: string }} raw  — formato '255 255 255'
   * @returns {{ base: string, accent: string, contrast: string }}
   */
  static normalize(raw) {
    const base     = PaletteNormalizer._parseChannelStr(raw.base);
    const accent   = PaletteNormalizer._parseChannelStr(raw.accent);
    const contrast = PaletteNormalizer._parseChannelStr(raw.contrast);

    const hslBase     = PaletteNormalizer._toHSL(base);
    const hslAccent   = PaletteNormalizer._toHSL(accent);
    const hslContrast = PaletteNormalizer._toHSL(contrast);

    // ── base: domina o fundo — deve ser escuro e dessaturado ───────────────
    const normalBase = PaletteNormalizer._clampHSL(hslBase, {
      sMin: 0.05, sMax: 0.55,   // não completamente cinza, não vibrante
      lMin: 0.04, lMax: 0.22    // escuro — é o fundo
    });

    // ── accent: ponto de luz — vibrante e de médio brilho ──────────────────
    const normalAccent = PaletteNormalizer._clampHSL(hslAccent, {
      sMin: 0.40, sMax: 0.90,
      lMin: 0.35, lMax: 0.72
    });

    // ── contrast: segundo polo — complementar ao accent em brilho ──────────
    let hslContrastFinal = PaletteNormalizer._clampHSL(hslContrast, {
      sMin: 0.20, sMax: 0.80,
      lMin: 0.25, lMax: 0.65
    });

    // Garante diferença mínima de hue entre accent e contrast (≥ 30°)
    const hueDiff = Math.abs(normalAccent.h - hslContrastFinal.h);
    const wrappedDiff = Math.min(hueDiff, 360 - hueDiff);
    if (wrappedDiff < 30) {
      // Deriva contrast girando o hue do accent em 120° (split-complementar)
      hslContrastFinal = { ...normalAccent, h: (normalAccent.h + 120) % 360, l: Math.max(0.30, normalAccent.l - 0.12) };
    }

    return {
      base:     PaletteNormalizer._toChannelStr(PaletteNormalizer._fromHSL(normalBase)),
      accent:   PaletteNormalizer._toChannelStr(PaletteNormalizer._fromHSL(normalAccent)),
      contrast: PaletteNormalizer._toChannelStr(PaletteNormalizer._fromHSL(hslContrastFinal))
    };
  }

  // ─── Clamp de propriedades HSL ──────────────────────────────────────────
  static _clampHSL(hsl, { sMin, sMax, lMin, lMax }) {
    return {
      h: hsl.h,
      s: Math.max(sMin, Math.min(sMax, hsl.s)),
      l: Math.max(lMin, Math.min(lMax, hsl.l))
    };
  }

  // ─── RGB ↔ HSL ──────────────────────────────────────────────────────────
  static _toHSL([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d   = max - min;
    const l   = (max + min) / 2;

    if (d === 0) return { h: 0, s: 0, l };

    const s = d / (1 - Math.abs(2 * l - 1));

    let h;
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6;
    }

    return { h: Math.round(h * 360), s, l };
  }

  static _fromHSL({ h, s, l }) {
    const c   = (1 - Math.abs(2 * l - 1)) * s;
    const x   = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m   = l - c / 2;

    let r = 0, g = 0, b = 0;
    if      (h < 60)  { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else              { r = c; b = x; }

    return [
      Math.round((r + m) * 255),
      Math.round((g + m) * 255),
      Math.round((b + m) * 255)
    ];
  }

  // ─── Parsing / serialização ─────────────────────────────────────────────
  static _parseChannelStr(str = '') {
    const parts = str.trim().split(/\s+/).map(Number);
    return parts.length === 3 ? parts : [20, 20, 30];
  }

  static _toChannelStr([r, g, b]) {
    return `${Math.round(r)} ${Math.round(g)} ${Math.round(b)}`;
  }
}

// static/js/PaletteNormalizer.js
// Normalizes extracted cover colors for the reactive UI while preserving
// the actual visual vocabulary of the artwork.

export default class PaletteNormalizer {
  /**
   * Receives a raw extracted palette and returns CSS-ready channel strings.
   * @param {{ base: string, accent: string, contrast: string, mode?: string, confidence?: number }} raw
   * @returns {{ base: string, accent: string, contrast: string, mode?: string, confidence?: number }}
   */
  static normalize(raw) {
    if (raw?.mode === 'near-black') {
      return {
        base: '3 3 3',
        accent: '72 72 72',
        contrast: '22 22 22',
        mode: 'near-black',
        confidence: raw.confidence
      };
    }

    const base     = PaletteNormalizer._parseChannelStr(raw.base);
    const accent   = PaletteNormalizer._parseChannelStr(raw.accent);
    const contrast = PaletteNormalizer._parseChannelStr(raw.contrast);

    const hslBase     = PaletteNormalizer._toHSL(base);
    const hslAccent   = PaletteNormalizer._toHSL(accent);
    const hslContrast = PaletteNormalizer._toHSL(contrast);
    const rawHsl = [hslBase, hslAccent, hslContrast];

    if (PaletteNormalizer._isMonochrome(rawHsl)) {
      return PaletteNormalizer._normalizeMonochrome(rawHsl);
    }

    if (PaletteNormalizer._isLimitedPalette(rawHsl)) {
      return PaletteNormalizer._normalizeLimitedPalette({ hslBase, hslAccent, hslContrast });
    }

    const normalBase = PaletteNormalizer._clampHSL(hslBase, {
      sMin: 0.05, sMax: 0.55,
      lMin: 0.04, lMax: 0.22
    });

    const normalAccent = PaletteNormalizer._clampHSL(hslAccent, {
      sMin: 0.40, sMax: 0.90,
      lMin: 0.35, lMax: 0.72
    });

    const contrastIsNeutral = PaletteNormalizer._isNeutral(hslContrast);
    let hslContrastFinal = contrastIsNeutral
      ? { h: 0, s: 0, l: PaletteNormalizer._clamp(hslContrast.l, 0.38, 0.76) }
      : PaletteNormalizer._clampHSL(hslContrast, {
        sMin: 0.20, sMax: 0.80,
        lMin: 0.25, lMax: 0.65
      });

    if (!contrastIsNeutral && PaletteNormalizer._hueDistance(normalAccent.h, hslContrastFinal.h) < 30) {
      hslContrastFinal = PaletteNormalizer._separateLuminance(normalAccent, hslContrastFinal);
    }

    return {
      base:     PaletteNormalizer._toChannelStr(PaletteNormalizer._fromHSL(normalBase)),
      accent:   PaletteNormalizer._toChannelStr(PaletteNormalizer._fromHSL(normalAccent)),
      contrast: PaletteNormalizer._toChannelStr(PaletteNormalizer._fromHSL(hslContrastFinal)),
      mode: 'color'
    };
  }

  static _normalizeMonochrome(hsls) {
    const sorted = [...hsls].sort((a, b) => a.l - b.l);
    const darkest = sorted[0];
    const middle = sorted[1] ?? sorted[0];
    const lightest = sorted[2] ?? sorted[sorted.length - 1];

    return {
      base: PaletteNormalizer._toChannelStr(PaletteNormalizer._fromHSL({
        h: 0,
        s: 0,
        l: PaletteNormalizer._clamp(darkest.l, 0.035, 0.18)
      })),
      accent: PaletteNormalizer._toChannelStr(PaletteNormalizer._fromHSL({
        h: 0,
        s: 0,
        l: PaletteNormalizer._clamp(lightest.l, 0.38, 0.76)
      })),
      contrast: PaletteNormalizer._toChannelStr(PaletteNormalizer._fromHSL({
        h: 0,
        s: 0,
        l: PaletteNormalizer._clamp(middle.l, 0.20, 0.56)
      })),
      mode: 'monochrome'
    };
  }

  static _normalizeLimitedPalette({ hslBase, hslAccent, hslContrast }) {
    const colored = [hslBase, hslAccent, hslContrast].filter(hsl => PaletteNormalizer._isMeaningfulColor(hsl));
    const anchor = PaletteNormalizer._mostSaturated(colored) ?? hslAccent;
    const accentSource = PaletteNormalizer._isMeaningfulColor(hslAccent) ? hslAccent : anchor;

    const normalBase = {
      h: PaletteNormalizer._isMeaningfulColor(hslBase) ? hslBase.h : anchor.h,
      s: PaletteNormalizer._clamp(PaletteNormalizer._isMeaningfulColor(hslBase) ? hslBase.s : anchor.s * 0.70, 0.16, 0.62),
      l: PaletteNormalizer._clamp(hslBase.l, 0.045, 0.22)
    };

    const normalAccent = {
      h: accentSource.h,
      s: PaletteNormalizer._clamp(accentSource.s, 0.34, 0.92),
      l: PaletteNormalizer._clamp(accentSource.l, 0.34, 0.72)
    };

    let normalContrast;
    if (PaletteNormalizer._isNeutral(hslContrast)) {
      normalContrast = {
        h: 0,
        s: 0,
        l: PaletteNormalizer._clamp(hslContrast.l, 0.42, 0.78)
      };
    } else {
      normalContrast = {
        h: hslContrast.h,
        s: PaletteNormalizer._clamp(hslContrast.s, 0.24, 0.82),
        l: PaletteNormalizer._clamp(hslContrast.l, 0.28, 0.70)
      };

      if (PaletteNormalizer._hueDistance(normalAccent.h, normalContrast.h) < 24) {
        normalContrast = PaletteNormalizer._separateLuminance(normalAccent, normalContrast);
      }
    }

    return {
      base: PaletteNormalizer._toChannelStr(PaletteNormalizer._fromHSL(normalBase)),
      accent: PaletteNormalizer._toChannelStr(PaletteNormalizer._fromHSL(normalAccent)),
      contrast: PaletteNormalizer._toChannelStr(PaletteNormalizer._fromHSL(normalContrast)),
      mode: 'limited-palette'
    };
  }

  static _isMonochrome(hsls) {
    return hsls.every(hsl => PaletteNormalizer._isNeutral(hsl));
  }

  static _isLimitedPalette(hsls) {
    const colored = hsls.filter(hsl => PaletteNormalizer._isMeaningfulColor(hsl));
    if (colored.length <= 1) return true;

    for (let i = 0; i < colored.length; i++) {
      for (let j = i + 1; j < colored.length; j++) {
        if (PaletteNormalizer._hueDistance(colored[i].h, colored[j].h) > 26) {
          return false;
        }
      }
    }

    return true;
  }

  static _isNeutral(hsl) {
    return hsl.s < 0.10 || hsl.l <= 0.035 || hsl.l >= 0.96;
  }

  static _isMeaningfulColor(hsl) {
    return hsl.s >= 0.14 && hsl.l > 0.04 && hsl.l < 0.94;
  }

  static _mostSaturated(hsls) {
    return hsls.reduce((best, hsl) => (!best || hsl.s > best.s ? hsl : best), null);
  }

  static _separateLuminance(reference, candidate) {
    const shouldGoLight = reference.l < 0.50;
    const targetL = shouldGoLight
      ? Math.max(candidate.l, reference.l + 0.20, 0.52)
      : Math.min(candidate.l, reference.l - 0.20, 0.30);

    return {
      ...candidate,
      l: PaletteNormalizer._clamp(targetL, 0.25, 0.72)
    };
  }

  static _hueDistance(a, b) {
    const diff = Math.abs(a - b);
    return Math.min(diff, 360 - diff);
  }

  static _clampHSL(hsl, { sMin, sMax, lMin, lMax }) {
    return {
      h: hsl.h,
      s: PaletteNormalizer._clamp(hsl.s, sMin, sMax),
      l: PaletteNormalizer._clamp(hsl.l, lMin, lMax)
    };
  }

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

  static _parseChannelStr(str = '') {
    const parts = str.trim().split(/\s+/).map(Number);
    return parts.length === 3 ? parts : [20, 20, 30];
  }

  static _toChannelStr([r, g, b]) {
    return `${Math.round(r)} ${Math.round(g)} ${Math.round(b)}`;
  }

  static _clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
}

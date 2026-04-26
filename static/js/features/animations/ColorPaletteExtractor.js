// static/js/ColorPaletteExtractor.js
// Extrai 3 cores dominantes de uma imagem usando Canvas 2D.
// Funciona via k-means de 3 passes em uma amostra redimensionada a 64x64 px.
// Retorna { base, accent, contrast } como strings 'R G B' (canal separado por espaço).
//
// Limitação de CORS: imagens de origens externas (YouTube) precisam de crossOrigin='anonymous'.
// Se o servidor remoto não enviar CORS headers, o canvas fica "tainted" e lança SecurityError.
// Nesse caso o extractor retorna null silenciosamente — o caller recorre ao fallback.

export default class ColorPaletteExtractor {
  // Cache: thumbKey -> paleta { base, accent, contrast }
  static _cache = new Map();
  static _MAX_CACHE = 64;

  /**
   * Resolve a URL de uma imagem para uma paleta de 3 cores.
   * @param {string} srcUrl - URL completa da imagem
   * @param {string} cacheKey - chave única para este track (geralmente trackId|thumbnail)
   * @returns {Promise<{ base: string, accent: string, contrast: string, mode?: string, confidence?: number } | null>}
   */
  static async extract(srcUrl, cacheKey = srcUrl) {
    if (ColorPaletteExtractor._cache.has(cacheKey)) {
      return ColorPaletteExtractor._cache.get(cacheKey);
    }

    try {
      const pixels = await ColorPaletteExtractor._sampleImage(srcUrl);
      if (!pixels) return null;

      const nearBlack = ColorPaletteExtractor._detectNearBlack(pixels);
      if (nearBlack) {
        const palette = ColorPaletteExtractor._nearBlackPalette(nearBlack.confidence);
        ColorPaletteExtractor._remember(cacheKey, palette);
        return palette;
      }

      const clusters = ColorPaletteExtractor._kMeans(pixels, 3, 12);
      if (!clusters || clusters.length < 3) return null;

      const palette = ColorPaletteExtractor._assignRoles(clusters);

      ColorPaletteExtractor._remember(cacheKey, palette);
      return palette;
    } catch (err) {
      // SecurityError (canvas tainted) ou rede — falha silenciosa
      if (err?.name !== 'SecurityError') {
        console.warn('[ColorPaletteExtractor] extract:', err?.message);
      }
      return null;
    }
  }

  // ─── Baixa + samplea a imagem para um array de pixels RGB ───────────────
  static _sampleImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';

      const cleanup = () => {
        img.onload  = null;
        img.onerror = null;
      };

      img.onload = () => {
        cleanup();
        try {
          const SIZE = 64; // resolução de amostra — suficiente, zero desperdício
          const canvas = document.createElement('canvas');
          canvas.width  = SIZE;
          canvas.height = SIZE;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, SIZE, SIZE);

          // getImageData pode lançar SecurityError se a imagem for cross-origin sem CORS
          const data = ctx.getImageData(0, 0, SIZE, SIZE).data;
          const pixels = [];

          // Coleta pixels com passo 4 (RGBA × stride) — 1/4 dos píxeis, totalmente OK para k-means
          for (let i = 0; i < data.length; i += 16) {
            const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
            if (a < 128) continue; // ignora transparentes
            pixels.push([r, g, b]);
          }

          resolve(pixels.length > 32 ? pixels : null);
        } catch (e) {
          resolve(null); // tainted canvas — falha silenciosa
        }
      };

      img.onerror = () => {
        cleanup();
        resolve(null);
      };

      img.src = url;
    });
  }

  // ─── K-Means simplificado ────────────────────────────────────────────────
  static _kMeans(pixels, k, maxIterations = 12) {
    // Inicialização por escolha mais distante (k-means++)
    const centers = [pixels[Math.floor(Math.random() * pixels.length)]];
    while (centers.length < k) {
      const distances = pixels.map(p => Math.min(...centers.map(c => ColorPaletteExtractor._distSq(p, c))));
      const total = distances.reduce((a, b) => a + b, 0);
      let rand = Math.random() * total;
      for (let i = 0; i < pixels.length; i++) {
        rand -= distances[i];
        if (rand <= 0) {
          centers.push(pixels[i]);
          break;
        }
      }
    }

    let assignments = new Int32Array(pixels.length);

    for (let iter = 0; iter < maxIterations; iter++) {
      let changed = false;

      // Atribuição
      for (let i = 0; i < pixels.length; i++) {
        let best = 0, bestDist = Infinity;
        for (let c = 0; c < k; c++) {
          const d = ColorPaletteExtractor._distSq(pixels[i], centers[c]);
          if (d < bestDist) { bestDist = d; best = c; }
        }
        if (assignments[i] !== best) { assignments[i] = best; changed = true; }
      }

      if (!changed && iter > 0) break;

      // Recentrar
      const sums  = Array.from({ length: k }, () => [0, 0, 0]);
      const counts = new Int32Array(k);
      for (let i = 0; i < pixels.length; i++) {
        const c = assignments[i];
        sums[c][0] += pixels[i][0];
        sums[c][1] += pixels[i][1];
        sums[c][2] += pixels[i][2];
        counts[c]++;
      }
      for (let c = 0; c < k; c++) {
        if (counts[c] > 0) {
          centers[c] = [
            Math.round(sums[c][0] / counts[c]),
            Math.round(sums[c][1] / counts[c]),
            Math.round(sums[c][2] / counts[c])
          ];
        }
      }
    }

    // Anotações de cluster: centroide + tamanho (popularidade)
    const counts = new Int32Array(k);
    for (let i = 0; i < pixels.length; i++) counts[assignments[i]]++;

    return centers.map((center, i) => ({
      rgb: center,
      size: counts[i],
      l: ColorPaletteExtractor._luminance(center),
      s: ColorPaletteExtractor._saturation(center)
    }));
  }

  // ─── Atribuição de papeis: base / accent / contrast ─────────────────────
  static _assignRoles(clusters) {
    // Ordena por popularidade (tamanho do cluster)
    const sorted = [...clusters].sort((a, b) => b.size - a.size);

    // base: cluster dominante (o maior)
    const base = sorted[0];

    // accent: cluster com maior saturação entre os restantes
    const remaining = sorted.slice(1);
    remaining.sort((a, b) => b.s - a.s);
    const accent = remaining[0];

    // contrast: o que sobrar
    const contrast = remaining[1] ?? sorted[0];

    return {
      base:     ColorPaletteExtractor._toChannelStr(base.rgb),
      accent:   ColorPaletteExtractor._toChannelStr(accent.rgb),
      contrast: ColorPaletteExtractor._toChannelStr(contrast.rgb)
    };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────
  static _detectNearBlack(pixels) {
    const total = pixels?.length ?? 0;
    if (total < 64) return null;

    let nearPure = 0;
    let deepNeutral = 0;
    let bright = 0;
    let veryBright = 0;
    let colored = 0;
    let lumaSum = 0;
    let chromaSum = 0;

    for (const [r, g, b] of pixels) {
      const luma = ColorPaletteExtractor._luminance([r, g, b]);
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);

      lumaSum += luma;
      chromaSum += chroma;

      if (luma <= 22 && chroma <= 12) nearPure++;
      if (luma <= 34 && chroma <= 18) deepNeutral++;
      if (luma > 58) bright++;
      if (luma > 90) veryBright++;
      if (luma > 16 && chroma > 20) colored++;
    }

    const nearPureRatio = nearPure / total;
    const deepNeutralRatio = deepNeutral / total;
    const brightRatio = bright / total;
    const veryBrightRatio = veryBright / total;
    const coloredRatio = colored / total;
    const avgLuma = lumaSum / total;
    const avgChroma = chromaSum / total;

    const passes =
      nearPureRatio >= 0.92 &&
      deepNeutralRatio >= 0.985 &&
      brightRatio <= 0.006 &&
      veryBrightRatio <= 0.002 &&
      coloredRatio <= 0.006 &&
      avgLuma <= 19 &&
      avgChroma <= 5.5;

    if (!passes) return null;

    return {
      confidence: Math.min(1, Math.max(0.92,
        (nearPureRatio * 0.34) +
        (deepNeutralRatio * 0.34) +
        ((1 - brightRatio) * 0.12) +
        ((1 - coloredRatio) * 0.12) +
        ((1 - Math.min(1, avgLuma / 32)) * 0.08)
      ))
    };
  }

  static _nearBlackPalette(confidence = 1) {
    return {
      base: '3 3 3',
      accent: '72 72 72',
      contrast: '22 22 22',
      mode: 'near-black',
      confidence
    };
  }

  static _remember(cacheKey, palette) {
    // Evict LRU se o cache atingiu o limite
    if (ColorPaletteExtractor._cache.size >= ColorPaletteExtractor._MAX_CACHE) {
      const oldest = ColorPaletteExtractor._cache.keys().next().value;
      ColorPaletteExtractor._cache.delete(oldest);
    }

    ColorPaletteExtractor._cache.set(cacheKey, palette);
  }

  static _distSq([r1, g1, b1], [r2, g2, b2]) {
    const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return dr * dr + dg * dg + db * db;
  }

  static _luminance([r, g, b]) {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  static _saturation([r, g, b]) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === 0) return 0;
    return (max - min) / max;
  }

  // Formato para CSS: '51 64 117'  (usado com rgb(var(--x)) ou rgba())
  static _toChannelStr([r, g, b]) {
    return `${r} ${g} ${b}`;
  }
}

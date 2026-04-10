// static/js/MitosisMetrics.js
// Utilitarios de geometria para animacoes de mitose e morph.

const DEFAULTS = {
  originTop: 15,
  originLeft: null,
  originWidth: 450,
  originHeight: 38,
  copyGap: 7,
  extraDrop: 22
};

function toInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

export function measureMitosisFromRect(rect, options = {}) {
  const cfg = {
    ...DEFAULTS,
    ...options
  };

  if (!rect) {
    const copyTop = cfg.originTop + cfg.originHeight + cfg.copyGap;
    return {
      originTop: cfg.originTop,
      originLeft: cfg.originLeft,
      originWidth: cfg.originWidth,
      originHeight: cfg.originHeight,
      copyTop,
      lowerTop: copyTop + cfg.extraDrop
    };
  }

  const originTop = toInt(rect.top, cfg.originTop);
  const originLeft = toInt(rect.left, cfg.originLeft);
  const originWidth = toInt(rect.width, cfg.originWidth);
  const originHeight = toInt(rect.height, cfg.originHeight);
  const copyTop = originTop + originHeight + toInt(cfg.copyGap, DEFAULTS.copyGap);

  return {
    originTop,
    originLeft,
    originWidth,
    originHeight,
    copyTop,
    lowerTop: copyTop + toInt(cfg.extraDrop, DEFAULTS.extraDrop)
  };
}

export function measureIslandBarMitosis(island, options = {}) {
  const bar = island?.shadowRoot?.getElementById('bar-container');
  const rect = bar ? bar.getBoundingClientRect() : null;
  return measureMitosisFromRect(rect, options);
}

export default {
  measureMitosisFromRect,
  measureIslandBarMitosis
};

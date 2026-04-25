// static/js/IslandImpactEngine.js
// Resposta elástica vetorial para a Dynamic Island.

const DEFAULTS = {
  durationMs: 420,
  minTravel: 4,
  maxTravel: 12,
  growMin: 0.008,
  growMax: 0.024,
  crossGrow: 0.006,
  reboundRatio: 0.24,
  settleRatio: 0.08,
  fallbackVector: { x: 0, y: -1 }
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readRootNumber(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readRootTimeMs(name, fallback) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parsed = Number.parseFloat(raw);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return raw.endsWith('ms') ? parsed : parsed * 1000;
}

function getRectCenter(rect) {
  if (!rect) {
    return { x: 0, y: 0 };
  }

  return {
    x: rect.left + (rect.width / 2),
    y: rect.top + (rect.height / 2)
  };
}

function buildTransform(translateX, translateY, scaleX = 1, scaleY = 1) {
  const tx = Math.round(translateX * 100) / 100;
  const ty = Math.round(translateY * 100) / 100;
  const sx = Math.round(scaleX * 10000) / 10000;
  const sy = Math.round(scaleY * 10000) / 10000;

  return `translate3d(${tx}px, ${ty}px, 0) scale(${sx}, ${sy})`;
}

function resolveImpactOrigin(vector) {
  const horizontal = Math.abs(vector.x) < 0.16
    ? '50%'
    : (vector.x > 0 ? '0%' : '100%');
  const vertical = Math.abs(vector.y) < 0.16
    ? '50%'
    : (vector.y > 0 ? '0%' : '100%');

  return `${horizontal} ${vertical}`;
}

function resolveConfig(options = {}) {
  const minTravel = Number.isFinite(options.minTravel)
    ? options.minTravel
    : readRootNumber('--impact-travel-min', DEFAULTS.minTravel);

  const maxTravel = Number.isFinite(options.maxTravel)
    ? options.maxTravel
    : readRootNumber('--impact-travel-max', DEFAULTS.maxTravel);

  return {
    duration: Number.isFinite(options.duration)
      ? options.duration
      : readRootTimeMs('--duration-impact', DEFAULTS.durationMs),
    minTravel,
    maxTravel: Math.max(minTravel, maxTravel),
    growMin: Number.isFinite(options.growMin)
      ? options.growMin
      : readRootNumber('--impact-grow-min', DEFAULTS.growMin),
    growMax: Number.isFinite(options.growMax)
      ? options.growMax
      : readRootNumber('--impact-grow-max', DEFAULTS.growMax),
    crossGrow: Number.isFinite(options.crossGrow)
      ? options.crossGrow
      : readRootNumber('--impact-cross-grow', DEFAULTS.crossGrow),
    reboundRatio: Number.isFinite(options.reboundRatio)
      ? options.reboundRatio
      : readRootNumber('--impact-rebound-ratio', DEFAULTS.reboundRatio),
    settleRatio: Number.isFinite(options.settleRatio)
      ? options.settleRatio
      : readRootNumber('--impact-settle-ratio', DEFAULTS.settleRatio),
    strength: clamp(
      Number.isFinite(options.strength) ? options.strength : 1,
      0.45,
      1.6
    )
  };
}

export function resolveImpactVector(options = {}) {
  const fallbackVector = options.fallbackVector || DEFAULTS.fallbackVector;

  let deltaX = 0;
  let deltaY = 0;

  if (options.sourceVector && (options.sourceVector.x || options.sourceVector.y)) {
    deltaX = Number(options.sourceVector.x) || 0;
    deltaY = Number(options.sourceVector.y) || 0;
  } else if (options.targetRect && options.sourceRect) {
    const sourceCenter = getRectCenter(options.sourceRect);
    const targetCenter = getRectCenter(options.targetRect);
    deltaX = targetCenter.x - sourceCenter.x;
    deltaY = targetCenter.y - sourceCenter.y;
  } else {
    deltaX = Number(fallbackVector.x) || 0;
    deltaY = Number(fallbackVector.y) || -1;
  }

  const distance = Math.hypot(deltaX, deltaY);

  if (!distance) {
    const fallbackLength = Math.hypot(fallbackVector.x || 0, fallbackVector.y || -1) || 1;
    return {
      x: (fallbackVector.x || 0) / fallbackLength,
      y: (fallbackVector.y || -1) / fallbackLength,
      distance: 0
    };
  }

  return {
    x: deltaX / distance,
    y: deltaY / distance,
    distance
  };
}

export function playElasticImpact(target, options = {}) {
  if (!target || typeof target.animate !== 'function') {
    return null;
  }

  const targetRect = options.targetRect || target.getBoundingClientRect();
  const vector = resolveImpactVector({
    ...options,
    targetRect
  });
  const config = resolveConfig(options);

  const explicitTravel = Number(options.travel);
  const travelBase = Number.isFinite(explicitTravel)
    ? explicitTravel
    : (config.minTravel + (vector.distance * 0.035));
  const travel = clamp(travelBase * config.strength, config.minTravel, config.maxTravel);

  const axisWeightX = Math.abs(vector.x);
  const axisWeightY = Math.abs(vector.y);
  const directionalGrow = clamp(travel * 0.00175, config.growMin, config.growMax);
  const crossGrow = clamp(config.crossGrow * config.strength, 0.002, config.growMax * 0.7);
  const volumeGrow = crossGrow * 0.26;

  const expandScaleX = 1 + volumeGrow + (directionalGrow * axisWeightX) + (crossGrow * axisWeightY * 0.5);
  const expandScaleY = 1 + volumeGrow + (directionalGrow * axisWeightY) + (crossGrow * axisWeightX * 0.5);
  const reboundScaleX = 1 - ((directionalGrow * axisWeightX) * config.reboundRatio) - (crossGrow * axisWeightY * 0.18);
  const reboundScaleY = 1 - ((directionalGrow * axisWeightY) * config.reboundRatio) - (crossGrow * axisWeightX * 0.18);
  const settleScaleX = 1 + ((directionalGrow * axisWeightX) * config.settleRatio) + (crossGrow * axisWeightY * 0.08);
  const settleScaleY = 1 + ((directionalGrow * axisWeightY) * config.settleRatio) + (crossGrow * axisWeightX * 0.08);

  target.style.willChange = 'transform';
  target.style.transformOrigin = resolveImpactOrigin(vector);

  const animation = target.animate([
    {
      offset: 0,
      transform: buildTransform(0, 0, 1, 1)
    },
    {
      offset: 0.34,
      transform: buildTransform(0, 0, expandScaleX, expandScaleY)
    },
    {
      offset: 0.72,
      transform: buildTransform(0, 0, reboundScaleX, reboundScaleY)
    },
    {
      offset: 0.9,
      transform: buildTransform(0, 0, settleScaleX, settleScaleY)
    },
    {
      offset: 1,
      transform: buildTransform(0, 0, 1, 1)
    }
  ], {
    duration: config.duration,
    easing: 'linear',
    fill: 'none'
  });

  const cleanup = () => {
    target.style.removeProperty('will-change');
    target.style.removeProperty('transform-origin');
  };

  animation.addEventListener('finish', cleanup, { once: true });
  animation.addEventListener('cancel', cleanup, { once: true });

  return animation;
}

export default {
  playElasticImpact,
  resolveImpactVector
};
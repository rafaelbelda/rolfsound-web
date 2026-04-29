import Animator from '/static/js/features/animations/Animator.js';

const DEFAULT_DURATION = 440;
const DEFAULT_CLOSE_DURATION = 340;
const DEFAULT_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
const HIDDEN_CLASS = 'is-morph-origin-hidden';

function isValidRect(rect) {
  return rect && rect.width > 0 && rect.height > 0;
}

function resolveEasing(easing) {
  return easing || Animator.resolveEasing('--ease-standard', DEFAULT_EASING);
}

function numericRadius(element, fallback = 12) {
  if (!element) return fallback;
  const value = parseFloat(getComputedStyle(element).borderTopLeftRadius);
  return Number.isFinite(value) ? value : fallback;
}

function transformBetween(fromRect, toRect) {
  const scaleX = fromRect.width / toRect.width;
  const scaleY = fromRect.height / toRect.height;
  const translateX = fromRect.left - toRect.left;
  const translateY = fromRect.top - toRect.top;
  return `translate(${translateX.toFixed(3)}px, ${translateY.toFixed(3)}px) scale(${scaleX.toFixed(5)}, ${scaleY.toFixed(5)})`;
}

export default class GeometryMorphAnimator {
  constructor() {
    this._animator = new Animator();
    this._hiddenOrigins = new Set();
  }

  async open(options = {}) {
    const {
      sourceEl,
      targetEl,
      originEl = sourceEl,
      contentEl = null,
      duration = DEFAULT_DURATION,
      easing = null,
      hiddenClass = HIDDEN_CLASS,
    } = options;

    if (!targetEl) return false;

    const sourceRect = sourceEl?.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();
    this._hideOrigin(originEl, hiddenClass);

    if (contentEl) {
      contentEl.style.opacity = '0';
      contentEl.style.transform = 'translateY(6px) scale(0.985)';
    }

    if (Animator.reducedMotion || !isValidRect(sourceRect) || !isValidRect(targetRect)) {
      await this._fade(targetEl, {
        from: { opacity: 0, transform: 'scale(0.985)' },
        to: { opacity: 1, transform: 'scale(1)' },
        duration: Math.min(duration, 180),
        easing: resolveEasing(easing),
      });
      this._settleTarget(targetEl);
      this._settleContent(contentEl);
      return true;
    }

    targetEl.style.transformOrigin = 'top left';
    targetEl.style.willChange = 'transform, opacity, border-radius';
    targetEl.style.opacity = '1';

    const sourceRadius = numericRadius(sourceEl, 8);
    const targetRadius = numericRadius(targetEl, 14);
    const animation = this._animator.play(targetEl, [
      {
        opacity: 0.92,
        transform: transformBetween(sourceRect, targetRect),
        borderRadius: `${sourceRadius}px`,
      },
      {
        opacity: 1,
        transform: 'translate(0, 0) scale(1, 1)',
        borderRadius: `${targetRadius}px`,
      },
    ], {
      duration,
      easing: resolveEasing(easing),
    });

    await animation?.finished.catch(() => {});
    this._settleTarget(targetEl);
    this._settleContent(contentEl);
    return true;
  }

  async close(options = {}) {
    const {
      sourceEl,
      targetEl,
      originEl = sourceEl,
      duration = DEFAULT_CLOSE_DURATION,
      easing = null,
      hiddenClass = HIDDEN_CLASS,
    } = options;

    if (!targetEl) {
      this._showAllOrigins(hiddenClass);
      return false;
    }

    const sourceRect = sourceEl?.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();

    if (Animator.reducedMotion || !isValidRect(sourceRect) || !isValidRect(targetRect)) {
      await this._fade(targetEl, {
        from: { opacity: 1, transform: 'scale(1)' },
        to: { opacity: 0, transform: 'scale(0.985)' },
        duration: Math.min(duration, 160),
        easing: resolveEasing(easing),
      });
      this._showAllOrigins(hiddenClass);
      this._settleTarget(targetEl);
      return true;
    }

    this._hideOrigin(originEl, hiddenClass);
    targetEl.style.transformOrigin = 'top left';
    targetEl.style.willChange = 'transform, opacity, border-radius';

    const sourceRadius = numericRadius(sourceEl, 8);
    const targetRadius = numericRadius(targetEl, 14);
    const animation = this._animator.play(targetEl, [
      {
        opacity: 1,
        transform: 'translate(0, 0) scale(1, 1)',
        borderRadius: `${targetRadius}px`,
      },
      {
        opacity: 0.94,
        transform: transformBetween(sourceRect, targetRect),
        borderRadius: `${sourceRadius}px`,
      },
    ], {
      duration,
      easing: resolveEasing(easing),
    });

    await animation?.finished.catch(() => {});
    this._showAllOrigins(hiddenClass);
    this._settleTarget(targetEl);
    return true;
  }

  _hideOrigin(originEl, hiddenClass) {
    if (!originEl) return;
    originEl.classList.add(hiddenClass);
    this._hiddenOrigins.add(originEl);
  }

  _showAllOrigins(hiddenClass) {
    this._hiddenOrigins.forEach((origin) => origin?.classList?.remove(hiddenClass));
    this._hiddenOrigins.clear();
  }

  _settleTarget(targetEl) {
    this._animator.releaseAll(targetEl);
    targetEl.style.opacity = '';
    targetEl.style.transform = '';
    targetEl.style.borderRadius = '';
    targetEl.style.transformOrigin = '';
    targetEl.style.willChange = '';
  }

  _settleContent(contentEl) {
    if (!contentEl) return;
    contentEl.style.opacity = '';
    contentEl.style.transform = '';
  }

  async _fade(targetEl, { from, to, duration, easing }) {
    targetEl.style.transformOrigin = 'center';
    targetEl.style.willChange = 'opacity, transform';
    const animation = this._animator.play(targetEl, [from, to], { duration, easing });
    await animation?.finished.catch(() => {});
  }
}

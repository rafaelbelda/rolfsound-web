// static/js/Animator.js
// WAAPI-based animation controller with mid-flight interruption support.
// Each element can have at most one active animation — starting a new one
// commits the current computed style and cancels the previous animation,
// so the new animation picks up from the exact visual state.

export class Animator {
  #animations = new Map();

  /**
   * Returns true when the user has opted into reduced motion.
   * Checked per-call so runtime changes (e.g. OS toggle) take effect immediately.
   */
  static get reducedMotion() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  /**
   * Animate an element, interrupting any in-flight animation on it.
   * The previous animation's computed state is committed before cancellation,
   * so the new animation starts from wherever the element visually is.
   *
   * When prefers-reduced-motion is active, duration collapses to 1ms so
   * keyframe end-states still apply (fill:forwards) without visible animation.
   *
   * @param {HTMLElement} element
   * @param {Keyframe[]} keyframes
   * @param {KeyframeAnimationOptions} options
   * @returns {Animation|null}
   */
  play(element, keyframes, options = {}) {
    if (!element || typeof element.animate !== 'function') return null;

    // Collapse duration when the user prefers no motion
    const finalOptions = Animator.reducedMotion
      ? { ...options, duration: 1 }
      : options;

    const prev = this.#animations.get(element);
    if (prev) {
      try { prev.commitStyles(); } catch { /* element may be disconnected */ }
      prev.cancel();
    }

    const anim = element.animate(keyframes, {
      fill: 'forwards',
      ...finalOptions
    });

    this.#animations.set(element, anim);

    anim.finished
      .then(() => this.#animations.delete(element))
      .catch(() => { /* cancelled — expected */ });

    return anim;
  }

  /**
   * Cancel any active animation on an element and commit its current style.
   * @param {HTMLElement} element
   */
  cancel(element) {
    const anim = this.#animations.get(element);
    if (!anim) return;

    try { anim.commitStyles(); } catch {}
    anim.cancel();
    this.#animations.delete(element);
  }

  /**
   * Cancel all tracked animations, committing styles.
   */
  cancelAll() {
    for (const [el, anim] of this.#animations) {
      try { anim.commitStyles(); } catch {}
      anim.cancel();
    }
    this.#animations.clear();
  }

  /**
   * Cancel ALL animations on an element — including ones that have already
   * finished with fill:'forwards' and been removed from the tracking map.
   * Commits styles before cancelling so the element doesn't snap back.
   *
   * Use this instead of cancel() whenever you need to set explicit inline
   * styles immediately after (e.g. in settle/cleanup callbacks).
   *
   * @param {HTMLElement} element
   */
  releaseAll(element) {
    if (!element) return;

    // Cancel if still in-progress (tracked in map)
    const tracked = this.#animations.get(element);
    if (tracked) {
      try { tracked.commitStyles(); } catch {}
      tracked.cancel();
      this.#animations.delete(element);
    }

    // Cancel any fill:forwards animations that have already finished and
    // been removed from the tracking map (they still override inline styles).
    if (typeof element.getAnimations === 'function') {
      element.getAnimations().forEach(a => {
        try { a.commitStyles(); } catch {}
        a.cancel();
      });
    }
  }

  /**
   * Get the active animation for an element (or null).
   * @param {HTMLElement} element
   * @returns {Animation|null}
   */
  get(element) {
    return this.#animations.get(element) || null;
  }

  /**
   * Number of currently tracked animations.
   * @returns {number}
   */
  get activeCount() {
    return this.#animations.size;
  }

  /**
   * Helper: read a CSS custom property value, usable as a WAAPI easing string.
   * Falls back to the provided default if the property is empty.
   * @param {string} varName  e.g. '--ease-standard'
   * @param {string} fallback e.g. 'cubic-bezier(0.32, 0.72, 0, 1)'
   * @returns {string}
   */
  static resolveEasing(varName, fallback = 'ease') {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue(varName).trim();
    return raw || fallback;
  }
}

export default Animator;

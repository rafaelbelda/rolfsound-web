// static/js/DivisionAnimator.js
//
// Modular cell-division animation primitive with spring-generated motion.
//
// Lifecycle (divide):  bud -> pinch -> snap -> split -> settle
// Lifecycle (absorb):  shrink -> absorb -> remove
//
// Layout-bound phases keep using CSS transitions so the membrane can read
// live DOM rects every frame. Snap and split are spring-driven via WAAPI.

import { Animator } from '/static/js/Animator.js';
import { AnimationEngine } from '/static/js/AnimationEngine.js';

class SpringSim {
  constructor({ k = 180, d = 24 } = {}) {
    this.k = k;
    this.d = d;
  }

  simulate(from, to) {
    const dt = 1 / 60;
    const out = [from];
    let position = from;
    let velocity = 0;

    for (let i = 1; i < 400; i += 1) {
      const force = -this.k * (position - to) - this.d * velocity;
      velocity += force * dt;
      position += velocity * dt;
      out.push(position);

      if (i > 8 && Math.abs(position - to) < 0.04 && Math.abs(velocity) < 0.04) {
        out.push(to);
        break;
      }
    }

    return out;
  }

  durationMs(from, to) {
    return Math.max(100, (this.simulate(from, to).length - 1) * (1000 / 60));
  }

  translateKFs(from, to, axis = 'Y') {
    const values = this.simulate(from, to);
    return values.map((value, index) => ({
      offset: index / (values.length - 1),
      transform: `translate${axis}(${value.toFixed(3)}px)`,
    }));
  }

  translateAndScaleKFs({
    fromTx = 0,
    toTx = 0,
    fromTy = 0,
    toTy = 0,
    fromSx = 1,
    toSx = 1,
    fromSy = 1,
    toSy = 1,
    axis = 'Y',
  } = {}) {
    const translate = this.simulate(fromTy !== 0 ? fromTy : fromTx, fromTy !== 0 ? toTy : toTx);
    const scaleX = this.simulate(fromSx, toSx);
    const scaleY = this.simulate(fromSy, toSy);
    const length = Math.max(translate.length, scaleX.length, scaleY.length);

    return Array.from({ length }, (_, index) => {
      const translateValue = translate[Math.min(index, translate.length - 1)];
      const scaleXValue = scaleX[Math.min(index, scaleX.length - 1)];
      const scaleYValue = scaleY[Math.min(index, scaleY.length - 1)];
      const tx = axis === 'Y' ? 0 : translateValue;
      const ty = axis === 'Y' ? translateValue : 0;

      return {
        offset: index / (length - 1),
        transform: `translate(${tx.toFixed(3)}px, ${ty.toFixed(3)}px) scale(${scaleXValue.toFixed(5)}, ${scaleYValue.toFixed(5)})`,
      };
    });
  }
}

const SPR = {
  ENTRY: new SpringSim({ k: 320, d: 30 }),    // ζ≈0.84  snappy settle, minimal overshoot
  STANDARD: new SpringSim({ k: 170, d: 24 }),  // ζ≈0.92  smooth default
  TRAVEL: new SpringSim({ k: 200, d: 26 }),    // ζ≈0.92  confident expansion
  RECOIL: new SpringSim({ k: 380, d: 36 }),    // ζ≈0.92  controlled detach
  TREMOR: new SpringSim({ k: 800, d: 52 }),    // ζ≈0.92  subliminal tension beat
  ABSORB: new SpringSim({ k: 220, d: 28 }),    // ζ≈0.94  decisive retract
};

const EASE = {
  standard: 'var(--ease-standard)',
  spring: 'var(--ease-spring)',
  snappy: 'var(--ease-snappy)',
  exit: 'var(--ease-exit)',
};

const TIMER_PROP = '_divisionTimers';

const AXIS_MAP = {
  down: {
    mainPos: 'top', crossPos: 'left',
    mainSize: 'height', crossSize: 'width',
    parentEdge: r => r.bottom,
    parentCross: r => r.left,
    parentCrossSize: r => r.width,
    sign: 1,
    translateAxis: 'Y',
    squashIsY: true,
    clipSide: 'bottom',
    membraneAxis: 'vertical',
    membraneNormal: 'topBottom',
  },
  up: {
    mainPos: 'top', crossPos: 'left',
    mainSize: 'height', crossSize: 'width',
    parentEdge: r => r.top,
    parentCross: r => r.left,
    parentCrossSize: r => r.width,
    sign: -1,
    translateAxis: 'Y',
    squashIsY: true,
    clipSide: 'top',
    membraneAxis: 'vertical',
    membraneNormal: 'bottomTop',
  },
  right: {
    mainPos: 'left', crossPos: 'top',
    mainSize: 'width', crossSize: 'height',
    parentEdge: r => r.right,
    parentCross: r => r.top,
    parentCrossSize: r => r.height,
    sign: 1,
    translateAxis: 'X',
    squashIsY: false,
    clipSide: 'right',
    membraneAxis: 'horizontal',
    membraneNormal: 'leftRight',
  },
  left: {
    mainPos: 'left', crossPos: 'top',
    mainSize: 'width', crossSize: 'height',
    parentEdge: r => r.left,
    parentCross: r => r.top,
    parentCrossSize: r => r.height,
    sign: -1,
    translateAxis: 'X',
    squashIsY: false,
    clipSide: 'left',
    membraneAxis: 'horizontal',
    membraneNormal: 'rightLeft',
  },
};

export class DivisionAnimator {
  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.parent
   * @param {HTMLElement} opts.child
   * @param {Object} [opts.target]
   * @param {'down'|'up'|'left'|'right'} [opts.direction='down']
   * @param {HTMLElement} [opts.shellTarget]
   * @param {string} [opts.shellAttribute='division-shell']
   * @param {number} [opts.budSize=52]
   * @param {number} [opts.budOverlap=6]
   * @param {number} [opts.budDuration]
   * @param {number} [opts.pinchGap=14]
   * @param {number} [opts.pinchWidth=14]
   * @param {number} [opts.pinchDuration]
   * @param {number} [opts.splitDuration]
   * @param {boolean} [opts.membrane=true]
   * @param {boolean} [opts.squashChild=true]
   * @param {number} [opts.childZIndex=996]
   * @param {Function} [opts.onPhase]
   * @param {Function} [opts.onSettled]
   * @param {Function} [opts.onRemoved]
   * @param {Object} [opts.owner]
   * @param {Object} [opts.membraneOptions]
   */
  constructor(opts = {}) {
    this._parent = opts.parent;
    this._child = opts.child;
    this._target = opts.target || null;
    this._direction = opts.direction || 'down';
    this._ax = AXIS_MAP[this._direction] || AXIS_MAP.down;
    this._shellTarget = opts.shellTarget || opts.parent;
    this._shellAttr = opts.shellAttribute || 'division-shell';
    this._membraneOpts = opts.membraneOptions || {};

    this._budSize = opts.budSize ?? 52;
    this._budOverlap = opts.budOverlap ?? 6;
    this._pinchGap = opts.pinchGap ?? 14;
    this._pinchWidth = opts.pinchWidth ?? 14;
    this._budDuration = Number.isFinite(opts.budDuration) && opts.budDuration > 0 ? opts.budDuration : null;
    this._pinchDuration = Number.isFinite(opts.pinchDuration) && opts.pinchDuration > 0 ? opts.pinchDuration : null;
    this._splitDuration = Number.isFinite(opts.splitDuration) && opts.splitDuration > 0 ? opts.splitDuration : null;
    this._useMembrane = opts.membrane !== false;
    this._squashChild = opts.squashChild !== false;
    this._childZIndex = opts.childZIndex ?? 996;

    this._onPhase = opts.onPhase || null;
    this._onSettled = opts.onSettled || null;
    this._onRemoved = opts.onRemoved || null;
    this._owner = opts.owner || this;

    this._phase = 'idle';
    this._membrane = null;
    this._bridge = null;
    this._animator = new Animator();
    this._aborted = false;
  }

  get phase() { return this._phase; }
  get isActive() { return !this._aborted && this._child != null; }

  async divide() {
    if (this._phase !== 'idle') return;

    try {
      await this._phaseBud();
      if (!this.isActive) return;
      await this._phasePinch();
      if (!this.isActive) return;
      await this._phaseSnap();
      if (!this.isActive) return;
      await this._phaseSplit();
      if (!this.isActive) return;
      this._phaseSettle();
    } catch (error) {
      if (error?.message !== 'division-aborted') throw error;
    }
  }

  async absorb() {
    if (this._phase !== 'settled') return;

    try {
      await this._phaseShrink();
      if (!this.isActive) return;
      await this._phaseAbsorb();
      if (!this.isActive) return;
      this._phaseRemove();
    } catch (error) {
      if (error?.message !== 'division-aborted') throw error;
    }
  }

  abort() {
    if (this._aborted) return;

    this._aborted = true;
    this._animator.cancelAll();
    AnimationEngine.clearScheduled(this._owner, TIMER_PROP);
    this._removeMembrane();
    this._removeBridge();
  }

  destroy() {
    this.abort();
    this._parent = null;
    this._child = null;
    this._shellTarget = null;
  }

  _setPhase(name) {
    this._phase = name;

    if (this._onPhase) {
      this._onPhase(name, {
        parent: this._parent,
        child: this._child,
        bridge: this._bridge,
        membrane: this._membrane,
      });
    }
  }

  _guard() {
    if (this._aborted) throw new Error('division-aborted');
  }

  _resolveDuration(fallbackMs, overrideMs = null) {
    const duration = Number.isFinite(overrideMs) ? overrideMs : Math.round(fallbackMs);
    return Animator.reducedMotion ? 1 : Math.max(1, Math.round(duration));
  }

  _phaseBud() {
    this._guard();

    return new Promise((resolve, reject) => {
      this._setPhase('bud');

      const ax = this._ax;
      const parentRect = this._parent.getBoundingClientRect();
      const child = this._child;
      const budMain = this._budSize + this._budOverlap;
      const budDur = this._resolveDuration(SPR.ENTRY.durationMs(0, budMain), this._budDuration);

      this._shellEnter();
      this._createBridge(parentRect);

      const budMainPos = ax.sign > 0
        ? ax.parentEdge(parentRect) - this._budOverlap
        : ax.parentEdge(parentRect) + this._budOverlap;

      child.style.position = 'fixed';
      child.style[ax.mainPos] = `${budMainPos}px`;
      child.style[ax.crossPos] = `${ax.parentCross(parentRect)}px`;
      child.style[ax.crossSize] = `${ax.parentCrossSize(parentRect)}px`;
      child.style[ax.mainSize] = '0px';
      child.style.zIndex = String(this._childZIndex);
      child.style.overflow = 'hidden';
      child.style.pointerEvents = 'none';
      child.style.opacity = '1';
      child.style.transform = 'none';
      child.style.transition = 'none';

      if (!child.parentNode) document.body.appendChild(child);

      if (this._useMembrane) {
        this._membrane = AnimationEngine.createDivisionMembrane({
          ...this._membraneOpts,
          ...this._membraneElements(child),
          bridgeElement: this._bridge,
          axis: ax.membraneAxis,
        });
      }

      child.getBoundingClientRect();

      requestAnimationFrame(() => {
        if (this._aborted) {
          reject(new Error('division-aborted'));
          return;
        }

        child.style.transition = ax.sign < 0
          ? `${ax.mainSize} ${budDur}ms ${EASE.spring}, ${ax.mainPos} ${budDur}ms ${EASE.spring}`
          : `${ax.mainSize} ${budDur}ms ${EASE.spring}`;

        child.style[ax.mainSize] = `${budMain}px`;
        if (ax.sign < 0) child.style[ax.mainPos] = `${budMainPos - budMain}px`;
      });

      if (this._squashChild) {
        AnimationEngine.afterFrames(() => {
          if (this._aborted) return;

          const keyframes = ax.squashIsY
            ? SPR.ENTRY.translateAndScaleKFs({ fromSx: 1, toSx: 1, fromSy: 0.82, toSy: 1 })
            : SPR.ENTRY.translateAndScaleKFs({ fromSx: 0.82, toSx: 1, fromSy: 1, toSy: 1 });

          this._animator.play(child, keyframes, {
            duration: budDur,
            fill: 'none',
          });
        }, 1);
      }

      AnimationEngine.afterTransitionOrTimeout(this._owner, child, {
        propertyName: ax.mainSize,
        timeoutMs: budDur + 120,
        timerProperty: TIMER_PROP,
        callback: () => this._aborted ? reject(new Error('division-aborted')) : resolve(),
      });
    });
  }

  _phasePinch() {
    this._guard();

    return new Promise((resolve, reject) => {
      this._setPhase('pinch');

      const ax = this._ax;
      const parentRect = this._parent.getBoundingClientRect();
      const child = this._child;
      const bridge = this._bridge;
      const pinchDur = this._resolveDuration(
        SPR.STANDARD.durationMs(0, this._pinchGap) * 1.15,
        this._pinchDuration,
      );

      const pinchMainPos = ax.sign > 0
        ? ax.parentEdge(parentRect) + this._pinchGap
        : ax.parentEdge(parentRect) - this._pinchGap - this._budSize;

      child.style.transition = `
        ${ax.mainPos} ${pinchDur}ms ${EASE.standard},
        ${ax.mainSize} ${pinchDur}ms ${EASE.standard},
        ${ax.crossSize} ${Math.round(pinchDur * 0.9)}ms ${EASE.standard},
        border-radius ${Math.round(pinchDur * 0.85)}ms ${EASE.snappy},
        border-top 100ms ease,
        box-shadow 300ms ease
      `;
      child.style[ax.mainPos] = `${pinchMainPos}px`;
      child.style[ax.mainSize] = `${this._budSize}px`;
      child.style.borderRadius = 'var(--radius-dynamic-island)';

      if (bridge) {
        const bridgeDur = Math.round(pinchDur * 0.78);
        bridge.style.transition = `
          ${ax.mainSize} ${bridgeDur}ms ${EASE.standard},
          ${ax.crossSize} ${bridgeDur}ms ${EASE.standard},
          border-radius ${Math.round(bridgeDur * 0.88)}ms ease,
          opacity 80ms ease
        `;
        bridge.style[ax.mainSize] = `${this._pinchGap + 2}px`;
        bridge.style[ax.crossSize] = `${this._pinchWidth}px`;
        bridge.style.borderRadius = `${Math.round(this._pinchWidth / 2)}px`;
        bridge.style.opacity = '1';
      }

      AnimationEngine.afterFrames(() => {
        if (this._aborted) return;

        const breathKeyframes = ax.squashIsY
          ? [
              { offset: 0, transform: 'scale(1, 1)' },
              { offset: 0.52, transform: 'scale(1.008, 0.993)' },
              { offset: 1, transform: 'scale(1, 1)' },
            ]
          : [
              { offset: 0, transform: 'scale(1, 1)' },
              { offset: 0.52, transform: 'scale(0.993, 1.008)' },
              { offset: 1, transform: 'scale(1, 1)' },
            ];

        this._animator.play(child, breathKeyframes, {
          duration: Math.max(1, pinchDur - 20),
          easing: 'ease-in-out',
          fill: 'none',
        });
      }, 1);

      AnimationEngine.afterTransitionOrTimeout(this._owner, child, {
        propertyName: ax.mainPos,
        timeoutMs: pinchDur + 100,
        timerProperty: TIMER_PROP,
        callback: () => this._aborted ? reject(new Error('division-aborted')) : resolve(),
      });
    });
  }

  _phaseSnap() {
    this._guard();

    return new Promise((resolve, reject) => {
      this._setPhase('snap');

      const ax = this._ax;
      const child = this._child;
      const tremorAmp = ax.sign * 1.0;
      const tremorDur = this._resolveDuration(
        Math.min(SPR.TREMOR.durationMs(tremorAmp, 0), 72),
      );

      const tremorAnim = this._animator.play(child, SPR.TREMOR.translateKFs(tremorAmp, 0, ax.translateAxis), {
        duration: tremorDur,
        fill: 'none',
      });

      const fireSnap = () => {
        if (this._aborted) {
          reject(new Error('division-aborted'));
          return;
        }

        if (this._membrane) {
          this._membrane.setSplit();
          AnimationEngine.schedule(this._owner, () => {
            if (this._membrane) {
              this._membrane.fadeOut(80);
              this._membrane = null;
            }
          }, 50, TIMER_PROP);
        }

        if (this._bridge) {
          this._bridge.style.transition = `opacity 80ms ease, ${ax.crossSize} 80ms ease`;
          this._bridge.style.opacity = '0';
          this._bridge.style[ax.crossSize] = '0px';
          AnimationEngine.schedule(this._owner, () => this._removeBridge(), 100, TIMER_PROP);
        }

        const childPush = ax.sign * 1.2;
        const childDur = this._resolveDuration(SPR.RECOIL.durationMs(childPush, 0));
        this._animator.play(child, SPR.RECOIL.translateKFs(childPush, 0, ax.translateAxis), {
          duration: childDur,
          fill: 'none',
        });

        AnimationEngine.schedule(this._owner, () => {
          this._aborted ? reject(new Error('division-aborted')) : resolve();
        }, childDur, TIMER_PROP);
      };

      if (tremorAnim) {
        tremorAnim.finished
          .then(fireSnap)
          .catch(() => reject(new Error('division-aborted')));
        return;
      }

      AnimationEngine.schedule(this._owner, fireSnap, 16, TIMER_PROP);
    });
  }

  _phaseSplit() {
    this._guard();

    return new Promise((resolve, reject) => {
      this._setPhase('split');

      const ax = this._ax;
      const child = this._child;

      if (!this._target) {
        resolve();
        return;
      }

      const first = child.getBoundingClientRect();

      const targetTop = this._target.top ??
        ((window.innerHeight - (this._target.height ?? first.height)) / 2);
      const targetLeft = this._target.left ??
        ((window.innerWidth - (this._target.width ?? first.width)) / 2);
      const splitDur = this._resolveDuration(
        SPR.TRAVEL.durationMs(1, 0) * 1.1,
        this._splitDuration,
      );

      child.style.transition = 'none';
      child.style.top = `${targetTop}px`;
      child.style.left = `${targetLeft}px`;
      child.style[ax.mainSize] = `${this._target[ax.mainSize]}px`;
      child.style.transition = `
        ${ax.crossSize} ${splitDur}ms ${EASE.standard},
        border-radius ${Math.round(splitDur * 0.8)}ms ${EASE.snappy}
      `;
      child.style[ax.crossSize] = `${this._target[ax.crossSize]}px`;

      const last = child.getBoundingClientRect();
      const deltaX = first.left - last.left;
      const deltaY = first.top - last.top;
      const clipPct = this._computeClipPercent(first, this._target);
      const travelValues = SPR.TRAVEL.simulate(1, 0);

      const flipKeyframes = travelValues.map((value, index) => {
        const clip = Math.max(0, clipPct * value);
        const radius = 16 + (1 - Math.max(0, Math.min(1, value))) * 4;

        return {
          offset: index / (travelValues.length - 1),
          transform: `translate(${(deltaX * value).toFixed(3)}px, ${(deltaY * value).toFixed(3)}px)`,
          clipPath: this._buildClipPath(clip, radius),
        };
      });

      this._animator.play(child, flipKeyframes, {
        duration: splitDur,
        fill: 'none',
      });

      // Restore shell earlier in split so origin does not appear empty.
      AnimationEngine.schedule(this._owner, () => this._shellExit(), Math.round(splitDur * 0.12), TIMER_PROP);
      AnimationEngine.schedule(this._owner, () => {
        this._aborted ? reject(new Error('division-aborted')) : resolve();
      }, splitDur + 24, TIMER_PROP);
    });
  }

  _phaseSettle() {
    this._setPhase('settled');

    const child = this._child;
    if (!child) return;

    this._animator.releaseAll(child);

    child.style.clipPath = '';
    child.style.transform = '';
    child.style.transition = 'none';
    child.style.overflow = 'visible';
    child.style.pointerEvents = 'auto';

    AnimationEngine.afterFrames(() => {
      if (!child.parentNode) return;

      this._animator.play(child, SPR.ENTRY.translateAndScaleKFs({
        fromSx: 1.012,
        toSx: 1,
        fromSy: 1.012,
        toSy: 1,
      }), {
        duration: this._resolveDuration(SPR.ENTRY.durationMs(1.012, 1)),
        fill: 'none',
      });
    }, 1);

    this._removeBridge();
    this._removeMembrane();
    this._shellExit();

    if (this._onSettled) {
      this._onSettled({ parent: this._parent, child: this._child });
    }
  }

  _phaseShrink() {
    this._guard();

    return new Promise((resolve, reject) => {
      this._setPhase('shrink');

      const ax = this._ax;
      const child = this._child;
      const parentRect = this._parent.getBoundingClientRect();
      const shrinkDur = this._resolveDuration(
        SPR.STANDARD.durationMs(0, 1) * 1.05,
        this._splitDuration,
      );

      this._shellEnter();

      if (this._useMembrane) {
        this._membrane = AnimationEngine.createDivisionMembrane({
          ...this._membraneOpts,
          ...this._membraneElements(child),
          axis: ax.membraneAxis,
        });
        this._membrane.setSplit();
      }

      child.style.overflow = 'hidden';
      child.style.pointerEvents = 'none';

      const shrinkMainPos = ax.sign > 0
        ? ax.parentEdge(parentRect) + this._pinchGap
        : ax.parentEdge(parentRect) - this._pinchGap - this._budSize;

      child.getBoundingClientRect();

      AnimationEngine.afterFrames(() => {
        if (this._aborted) {
          reject(new Error('division-aborted'));
          return;
        }

        child.style.transition = `
          width ${shrinkDur}ms ${EASE.standard},
          height ${shrinkDur}ms ${EASE.standard},
          top ${shrinkDur}ms ${EASE.standard},
          left ${shrinkDur}ms ${EASE.standard},
          border-radius ${Math.round(shrinkDur * 0.8)}ms ${EASE.snappy}
        `;
        child.style[ax.crossSize] = `${ax.parentCrossSize(parentRect)}px`;
        child.style[ax.mainSize] = `${this._budSize}px`;
        child.style[ax.mainPos] = `${shrinkMainPos}px`;
        child.style[ax.crossPos] = `${ax.parentCross(parentRect)}px`;
        child.style.transform = 'none';
        child.style.borderRadius = 'var(--radius-dynamic-island)';
      });

      AnimationEngine.afterTransitionOrTimeout(this._owner, child, {
        propertyName: ax.mainSize,
        timeoutMs: shrinkDur + 120,
        timerProperty: TIMER_PROP,
        callback: () => this._aborted ? reject(new Error('division-aborted')) : resolve(),
      });
    });
  }

  _phaseAbsorb() {
    this._guard();

    return new Promise((resolve, reject) => {
      this._setPhase('absorb');

      const ax = this._ax;
      const child = this._child;
      const parentRect = this._parent.getBoundingClientRect();
      const absorbDur = this._resolveDuration(
        SPR.ABSORB.durationMs(this._budSize, 0),
        this._budDuration,
      );

      if (this._membrane) {
        this._membrane.setConnected({
          ...this._membraneElements(child),
          neckWidthProvider: ({ topRect, bottomRect }) => Math.min(
            ax.membraneAxis === 'vertical' ? topRect.width : topRect.height,
            ax.membraneAxis === 'vertical' ? bottomRect.width : bottomRect.height,
          ),
        });
      }

      const absorbPos = ax.sign > 0
        ? ax.parentEdge(parentRect) - this._budOverlap
        : ax.parentEdge(parentRect) + this._budOverlap;
      const borderSide = this._borderSideFacingParent();

      child.style.transition = `
        ${ax.mainSize} ${absorbDur}ms ${EASE.standard},
        ${ax.mainPos} ${absorbDur}ms ${EASE.standard},
        border-radius 200ms ease,
        ${borderSide} 80ms ease,
        opacity ${Math.round(absorbDur * 0.45)}ms ease ${Math.round(absorbDur * 0.38)}ms
      `;
      child.style[ax.mainPos] = `${absorbPos}px`;
      child.style[ax.mainSize] = '0px';
      child.style.borderRadius = this._absorbBorderRadius();
      child.style[borderSide] = 'none';
      child.style.opacity = '0';

      AnimationEngine.afterTransitionOrTimeout(this._owner, child, {
        propertyName: ax.mainSize,
        timeoutMs: absorbDur + 120,
        timerProperty: TIMER_PROP,
        callback: () => this._aborted ? reject(new Error('division-aborted')) : resolve(),
      });
    });
  }

  _phaseRemove() {
    this._setPhase('removed');

    if (this._membrane) {
      this._membrane.fadeOut(80);
      this._membrane = null;
    }

    this._removeBridge();

    if (this._child?.parentNode) this._child.remove();

    this._shellExit();

    if (this._onRemoved) {
      this._onRemoved({ parent: this._parent });
    }

    this._phase = 'idle';
  }

  _createBridge(parentRect) {
    this._removeBridge();

    const ax = this._ax;
    const isVertical = ax.membraneAxis === 'vertical';
    this._bridge = document.createElement('div');

    const crossSize = isVertical ? parentRect.width : parentRect.height;
    const crossPos = isVertical ? parentRect.left : parentRect.top;
    const mainPos = ax.parentEdge(parentRect) - 1;

    this._bridge.style.cssText = `
      position: fixed;
      ${ax.mainPos}: ${mainPos}px;
      ${ax.crossPos}: ${crossPos}px;
      ${ax.mainSize}: 2px;
      ${ax.crossSize}: ${crossSize}px;
      background: transparent;
      z-index: ${this._childZIndex};
      border-radius: 0;
      pointer-events: none;
      opacity: 0;
    `;

    document.body.appendChild(this._bridge);
  }

  _removeBridge() {
    if (this._bridge?.parentNode) this._bridge.remove();
    this._bridge = null;
  }

  _removeMembrane() {
    if (this._membrane) {
      this._membrane.remove();
      this._membrane = null;
    }
  }

  _shellEnter() {
    if (this._shellAttr && this._shellTarget?.setAttribute) {
      this._shellTarget.setAttribute(this._shellAttr, 'true');
    }
  }

  _shellExit() {
    if (this._shellAttr && this._shellTarget?.removeAttribute) {
      this._shellTarget.removeAttribute(this._shellAttr);
    }
  }

  _membraneElements(child) {
    const normal = this._ax.membraneNormal;

    return (normal === 'topBottom' || normal === 'leftRight')
      ? { topElement: this._parent, bottomElement: child }
      : { topElement: child, bottomElement: this._parent };
  }

  _computeClipPercent(firstRect, target) {
    const ax = this._ax;
    const firstMain = ax.mainSize === 'height' ? firstRect.height : firstRect.width;
    const targetMain = ax.mainSize === 'height' ? target.height : target.width;
    return Math.max(0, ((targetMain - firstMain) / targetMain) * 100);
  }

  _buildClipPath(pct, radius) {
    const side = this._ax.clipSide;
    const top = side === 'top' ? pct : 0;
    const right = side === 'right' ? pct : 0;
    const bottom = side === 'bottom' ? pct : 0;
    const left = side === 'left' ? pct : 0;
    return `inset(${top.toFixed(2)}% ${right.toFixed(2)}% ${bottom.toFixed(2)}% ${left.toFixed(2)}% round ${radius.toFixed(1)}px)`;
  }

  _borderSideFacingParent() {
    return {
      down: 'border-top',
      up: 'border-bottom',
      right: 'border-left',
      left: 'border-right',
    }[this._direction] ?? 'border-top';
  }

  _absorbBorderRadius() {
    const radius = 'var(--radius-dynamic-island)';
    return {
      down: `0 0 ${radius} ${radius}`,
      up: `${radius} ${radius} 0 0`,
      right: `0 ${radius} ${radius} 0`,
      left: `${radius} 0 0 ${radius}`,
    }[this._direction] ?? `0 0 ${radius} ${radius}`;
  }
}

export default DivisionAnimator;

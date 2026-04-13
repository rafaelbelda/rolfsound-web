// static/js/DivisionAnimator.js
//
// Modular cell-division animation primitive.
//
// Animates a parent → child split with an organic
//   bud → pinch → split → settle
// lifecycle, and reverses it via absorb():
//   shrink → absorb → remove
//
// Supports four directions via the `direction` option:
//   'down' (default) — child buds from parent's bottom edge
//   'up'             — child buds from parent's top edge
//   'right'          — child buds from parent's right edge
//   'left'           — child buds from parent's left edge
//
// The parent element stays CSS-only (layout transitions). The SVG
// membrane (via AnimationEngine.createDivisionMembrane) draws a
// continuous outline around both during bud/pinch, creating the
// illusion that the parent is deforming.
//
// Usage:
//   const div = new DivisionAnimator({
//     parent: islandBar,
//     child:  playerContainer,   // created by caller, NOT in DOM yet
//     target: { top, width, height },
//     direction: 'down',         // or 'up', 'left', 'right'
//     owner:  this,
//   });
//   await div.divide();   // bud → pinch → split → settle
//   await div.absorb();   // shrink → absorb → remove

import { Animator } from '/static/js/Animator.js';
import { AnimationEngine } from '/static/js/AnimationEngine.js';

// ── Easing literals (WAAPI can't read CSS vars) ──
const EASE = {
  standard:  'cubic-bezier(0.32, 0.72, 0, 1)',   // --ease-standard
  spring:    'cubic-bezier(0.34, 1.28, 0.64, 1)', // --ease-spring
  exit:      'cubic-bezier(0.3, 0, 1, 1)',         // --ease-exit
};

const TIMER_PROP = '_divisionTimers';

// ── Axis geometry map ──────────────────────────────────────────
//
// Each direction defines which CSS properties and rect edges to
// use.  Every phase reads from `this._ax` — no direction-specific
// branches in the animation code.
//
//   mainPos   – CSS position along the main axis  ('top' | 'left')
//   crossPos  – CSS position along the cross axis ('left' | 'top')
//   mainSize  – CSS dimension along the main axis ('height' | 'width')
//   crossSize – CSS dimension on the cross axis   ('width' | 'height')
//   parentEdge(rect)  – px coordinate where the bud emerges
//   parentCross(rect) – px coordinate for the cross-axis alignment
//   parentCrossSize(rect) – cross-axis extent of the parent
//   sign              – +1 (child grows in positive direction) or -1
//   clipSide          – which inset() field clips during FLIP
//                       'bottom' | 'top' | 'right' | 'left'
//   viewport          – viewport extent along the main axis
//   viewportCross     – viewport extent along the cross axis
//   membraneAxis      – 'vertical' | 'horizontal' (membrane winding)
//   membraneNormal    – 'topBottom' | 'bottomTop' | 'leftRight' | 'rightLeft'
//                       which element is the "first" in path winding

const AXIS_MAP = {
  down: {
    mainPos: 'top',    crossPos: 'left',
    mainSize: 'height', crossSize: 'width',
    parentEdge: r => r.bottom,
    parentCross: r => r.left,
    parentCrossSize: r => r.width,
    sign: 1,
    clipSide: 'bottom',
    viewport: () => window.innerHeight,
    viewportCross: () => window.innerWidth,
    membraneAxis: 'vertical',
    membraneNormal: 'topBottom',
  },
  up: {
    mainPos: 'top',    crossPos: 'left',
    mainSize: 'height', crossSize: 'width',
    parentEdge: r => r.top,
    parentCross: r => r.left,
    parentCrossSize: r => r.width,
    sign: -1,
    clipSide: 'top',
    viewport: () => window.innerHeight,
    viewportCross: () => window.innerWidth,
    membraneAxis: 'vertical',
    membraneNormal: 'bottomTop',
  },
  right: {
    mainPos: 'left',   crossPos: 'top',
    mainSize: 'width',  crossSize: 'height',
    parentEdge: r => r.right,
    parentCross: r => r.top,
    parentCrossSize: r => r.height,
    sign: 1,
    clipSide: 'right',
    viewport: () => window.innerWidth,
    viewportCross: () => window.innerHeight,
    membraneAxis: 'horizontal',
    membraneNormal: 'leftRight',
  },
  left: {
    mainPos: 'left',   crossPos: 'top',
    mainSize: 'width',  crossSize: 'height',
    parentEdge: r => r.left,
    parentCross: r => r.top,
    parentCrossSize: r => r.height,
    sign: -1,
    clipSide: 'left',
    viewport: () => window.innerWidth,
    viewportCross: () => window.innerHeight,
    membraneAxis: 'horizontal',
    membraneNormal: 'rightLeft',
  },
};

export class DivisionAnimator {

  /**
   * @param {Object} opts
   * @param {HTMLElement} opts.parent        - Parent container (e.g. island #bar-container)
   * @param {HTMLElement} opts.child         - Child element (caller creates, NOT yet in DOM)
   * @param {Object}      [opts.target]      - Final geometry { top, left?, width, height }
   * @param {'down'|'up'|'left'|'right'} [opts.direction='down'] - Bud direction
   * @param {HTMLElement} [opts.shellTarget] - Element to set shell attribute on (defaults to parent)
   * @param {string}      [opts.shellAttribute='division-shell']
   * @param {number}      [opts.budSize=52]
   * @param {number}      [opts.budOverlap=6]
   * @param {number}      [opts.budDuration=280]
   * @param {number}      [opts.pinchGap=14]
   * @param {number}      [opts.pinchWidth=14]
   * @param {number}      [opts.pinchDuration=320]
   * @param {number}      [opts.splitDuration=500]
   * @param {boolean}     [opts.membrane=true]
   * @param {number}      [opts.childZIndex=996]
   * @param {Function}    [opts.onPhase]     - (phase, { parent, child, bridge, membrane })
   * @param {Function}    [opts.onSettled]   - ({ parent, child })
   * @param {Function}    [opts.onRemoved]   - ({ parent })
   * @param {Object}      [opts.owner]       - Timer owner for AnimationEngine.schedule
   * @param {Object}      [opts.membraneOptions] - Forwarded to AnimationEngine.createDivisionMembrane
   */
  constructor(opts = {}) {
    this._parent        = opts.parent;
    this._child         = opts.child;
    this._target        = opts.target  || null;
    this._direction     = opts.direction || 'down';
    this._ax            = AXIS_MAP[this._direction] || AXIS_MAP.down;
    this._shellTarget   = opts.shellTarget || opts.parent;
    this._shellAttr     = opts.shellAttribute || 'division-shell';
    this._membraneOpts  = opts.membraneOptions || {};

    this._budSize       = opts.budSize       ?? 52;
    this._budOverlap    = opts.budOverlap    ?? 6;
    this._budDuration   = opts.budDuration   ?? 280;
    this._pinchGap      = opts.pinchGap      ?? 14;
    this._pinchWidth    = opts.pinchWidth    ?? 14;
    this._pinchDuration = opts.pinchDuration ?? 320;
    this._splitDuration = opts.splitDuration ?? 500;
    this._useMembrane   = opts.membrane !== false;
    this._childZIndex   = opts.childZIndex   ?? 996;

    this._onPhase       = opts.onPhase   || null;
    this._onSettled     = opts.onSettled  || null;
    this._onRemoved     = opts.onRemoved || null;
    this._owner         = opts.owner     || this;

    this._phase    = 'idle';
    this._membrane = null;
    this._bridge   = null;
    this._animator = new Animator();
    this._aborted  = false;
  }

  // ── Getters ──────────────────────────────────────────────────

  get phase()    { return this._phase; }
  get isActive() { return !this._aborted && this._child != null; }

  // ── Public API ───────────────────────────────────────────────

  /**
   * Run the cell division: bud → pinch → split → settle.
   * Resolves when the child is settled at target geometry.
   */
  async divide() {
    if (this._phase !== 'idle') return;
    try {
      await this._phaseBud();
      if (!this.isActive) return;
      await this._phasePinch();
      if (!this.isActive) return;
      await this._phaseSplit();
      if (!this.isActive) return;
      this._phaseSettle();
    } catch (e) {
      if (e?.message !== 'division-aborted') throw e;
    }
  }

  /**
   * Reverse the division: shrink → absorb → remove.
   * Resolves when the child has been removed from the DOM.
   */
  async absorb() {
    if (this._phase !== 'settled') return;
    try {
      await this._phaseShrink();
      if (!this.isActive) return;
      await this._phaseAbsorb();
      if (!this.isActive) return;
      this._phaseRemove();
    } catch (e) {
      if (e?.message !== 'division-aborted') throw e;
    }
  }

  /** Cancel all in-flight animations and clean up immediately. */
  abort() {
    if (this._aborted) return;
    this._aborted = true;
    this._animator.cancelAll();
    AnimationEngine.clearScheduled(this._owner, TIMER_PROP);
    this._removeMembrane();
    this._removeBridge();
  }

  /** Full teardown — abort + null references. */
  destroy() {
    this.abort();
    this._parent      = null;
    this._child       = null;
    this._shellTarget = null;
  }

  // ── Phase management ─────────────────────────────────────────

  _setPhase(name) {
    this._phase = name;
    if (this._onPhase) {
      this._onPhase(name, {
        parent:   this._parent,
        child:    this._child,
        bridge:   this._bridge,
        membrane: this._membrane,
      });
    }
  }

  _guard() {
    if (this._aborted) throw new Error('division-aborted');
  }

  // ── DIVIDE: Phase 1 — Bud ───────────────────────────────────
  //
  // Child emerges from parent's edge along the main axis.
  // CSS transition on mainSize — membrane reads real layout rects.

  _phaseBud() {
    this._guard();
    return new Promise((resolve, reject) => {
      this._setPhase('bud');

      const ax         = this._ax;
      const parentRect = this._parent.getBoundingClientRect();
      const child      = this._child;

      // ── Shell parent (transparent bg so membrane looks unified) ──
      this._shellEnter();

      // ── Position child at parent's edge (zero mainSize) ──
      // For positive directions (down/right): mainPos = parentEdge - overlap
      //   (child grows away from parent in positive direction)
      // For negative directions (up/left): mainPos = parentEdge + overlap
      //   (child's far edge is at parentEdge + overlap; as mainSize grows,
      //    mainPos decreases so the child expands toward the negative direction)
      const budMainPos = ax.sign > 0
        ? ax.parentEdge(parentRect) - this._budOverlap
        : ax.parentEdge(parentRect) + this._budOverlap;

      child.style.position      = 'fixed';
      child.style[ax.mainPos]   = `${budMainPos}px`;
      child.style[ax.crossPos]  = `${ax.parentCross(parentRect)}px`;
      child.style[ax.crossSize] = `${ax.parentCrossSize(parentRect)}px`;
      child.style[ax.mainSize]  = '0px';
      child.style.zIndex        = String(this._childZIndex);
      child.style.overflow      = 'hidden';
      child.style.pointerEvents = 'none';
      child.style.opacity       = '1';
      child.style.transition    = 'none';

      // ── Create bridge (thin invisible junction for membrane) ──
      this._createBridge(parentRect);

      // ── Append child to DOM ──
      if (!child.parentNode) document.body.appendChild(child);

      // ── Start membrane (connected — draws parent+child as one blob) ──
      if (this._useMembrane) {
        const memEls = this._membraneElements(child);
        this._membrane = AnimationEngine.createDivisionMembrane({
          ...this._membraneOpts,
          ...memEls,
          bridgeElement: this._bridge,
          axis: this._ax.membraneAxis,
        });
      }

      // ── Force layout commit ──
      child.getBoundingClientRect();

      // ── Animate bud growth ──
      const budTrans = `${ax.mainSize} ${this._budDuration}ms var(--ease-spring)`;
      // For negative directions (up/left), also transition mainPos
      // so that the child grows "toward" the negative direction
      child.style.transition = ax.sign < 0
        ? `${budTrans}, ${ax.mainPos} ${this._budDuration}ms var(--ease-spring)`
        : budTrans;

      requestAnimationFrame(() => {
        if (this._aborted) return reject(new Error('division-aborted'));
        const budMain = this._budSize + this._budOverlap;
        child.style[ax.mainSize] = `${budMain}px`;
        if (ax.sign < 0) {
          // Move mainPos so the child grows in the negative direction
          child.style[ax.mainPos] = `${budMainPos - budMain}px`;
        }
      });

      AnimationEngine.afterTransitionOrTimeout(this._owner, child, {
        propertyName:  ax.mainSize,
        timeoutMs:     this._budDuration + 80,
        timerProperty: TIMER_PROP,
        callback: () => this._aborted ? reject(new Error('division-aborted')) : resolve(),
      });
    });
  }

  // ── DIVIDE: Phase 2 — Pinch ─────────────────────────────────
  //
  // Child separates, gap appears, bridge narrows → hourglass.
  // CSS transitions on mainPos/mainSize/crossSize — membrane reads rects.

  _phasePinch() {
    this._guard();
    return new Promise((resolve, reject) => {
      this._setPhase('pinch');

      const ax         = this._ax;
      const parentRect = this._parent.getBoundingClientRect();
      const child      = this._child;
      const bridge     = this._bridge;

      // ── Child: separate + reshape ──
      const pinchMainPos = ax.sign > 0
        ? (ax.parentEdge(parentRect) + this._pinchGap)
        : (ax.parentEdge(parentRect) - this._pinchGap - this._budSize);

      child.style.transition = `
        ${ax.mainPos}  ${this._pinchDuration}ms var(--ease-standard),
        ${ax.mainSize} ${this._pinchDuration}ms var(--ease-standard),
        ${ax.crossSize} ${this._pinchDuration}ms var(--ease-standard),
        border-radius ${Math.round(this._pinchDuration * 0.85)}ms var(--ease-snappy),
        border-top    100ms ease,
        box-shadow    300ms ease
      `;
      child.style[ax.mainPos]  = `${pinchMainPos}px`;
      child.style[ax.mainSize] = `${this._budSize}px`;
      child.style.borderRadius = 'var(--radius-dynamic-island)';

      // ── Bridge: expand to fill gap, narrow to pinch width ──
      if (bridge) {
        const bd = Math.round(this._pinchDuration * 0.8);
        // Bridge's main-size spans the gap; cross-size narrows to pinchWidth
        bridge.style.transition = `
          ${ax.mainSize} ${bd}ms var(--ease-standard),
          ${ax.crossSize} ${bd}ms var(--ease-standard),
          border-radius ${Math.round(bd * 0.88)}ms ease,
          opacity       60ms ease
        `;
        bridge.style[ax.mainSize]  = `${this._pinchGap + 2}px`;
        bridge.style[ax.crossSize] = `${this._pinchWidth}px`;
        bridge.style.borderRadius  = `${Math.round(this._pinchWidth / 2)}px`;
        bridge.style.opacity       = '1';
      }

      AnimationEngine.afterTransitionOrTimeout(this._owner, child, {
        propertyName:  ax.mainPos,
        timeoutMs:     this._pinchDuration + 80,
        timerProperty: TIMER_PROP,
        callback: () => this._aborted ? reject(new Error('division-aborted')) : resolve(),
      });
    });
  }

  // ── DIVIDE: Phase 3 — Split ─────────────────────────────────
  //
  // Bridge fades, membrane fades, child FLIP-animates to target.
  // WAAPI transform+clipPath — pure GPU compositor.

  _phaseSplit() {
    this._guard();
    return new Promise((resolve, reject) => {
      this._setPhase('split');

      const ax    = this._ax;
      const child = this._child;

      // ── Fade bridge ──
      if (this._bridge) {
        this._bridge.style.transition = `opacity 120ms ease, ${ax.crossSize} 120ms ease`;
        this._bridge.style.opacity         = '0';
        this._bridge.style[ax.crossSize]   = '0px';
        AnimationEngine.schedule(this._owner, () => this._removeBridge(), 150, TIMER_PROP);
      }

      // ── Fade membrane ──
      if (this._membrane) {
        this._membrane.setSplit();
        AnimationEngine.schedule(this._owner, () => {
          if (this._membrane) {
            this._membrane.fadeOut(120);
            this._membrane = null;
          }
        }, 80, TIMER_PROP);
      }

      // ── No target → stay in place ──
      if (!this._target) { resolve(); return; }

      // ── FLIP: capture → set final layout → animate diff ──
      const first = child.getBoundingClientRect();
      const firstCrossSize = ax.crossSize === 'width' ? first.width : first.height;

      // Resolve target position — default to centering on the cross axis
      const targetTop  = this._target.top  ?? (ax.mainPos === 'top'
        ? first.top
        : (window.innerHeight - this._target.height) / 2);
      const targetLeft = this._target.left ?? (ax.mainPos === 'left'
        ? first.left
        : (window.innerWidth - this._target.width) / 2);

      // Set final geometry for main axis + position instantly (single reflow)
      child.style.transition = 'none';
      child.style.top    = `${targetTop}px`;
      child.style.left   = `${targetLeft}px`;
      child.style[ax.mainSize] = `${this._target[ax.mainSize]}px`;
      child.style[ax.crossSize] = `${firstCrossSize}px`;

      // Cross-size + border-radius via CSS transition (content needs reflow)
      child.style.transition = `
        ${ax.crossSize} ${this._splitDuration}ms var(--ease-standard),
        border-radius   ${Math.round(this._splitDuration * 0.8)}ms var(--ease-snappy)
      `;
      child.style[ax.crossSize] = `${this._target[ax.crossSize]}px`;

      // Force layout so browser registers new geometry
      const last = child.getBoundingClientRect();

      // Compute FLIP deltas
      const deltaX = first.left + first.width / 2 - (last.left + last.width / 2);
      const deltaY = first.top - last.top;

      // Clip reveal along main axis
      const clipPct = this._computeClipPercent(first, this._target);
      const clipFrom = this._buildClipPath(clipPct, 16);
      const clipTo   = this._buildClipPath(0, 24);

      // WAAPI: translate + clipPath reveal (GPU compositor only)
      const anim = this._animator.play(child, [
        { transform: `translate(${deltaX}px, ${deltaY}px)`, clipPath: clipFrom },
        { transform: 'translate(0, 0)',                     clipPath: clipTo   },
      ], {
        duration: this._splitDuration,
        easing:   EASE.standard,
      });

      if (anim) {
        anim.finished
          .then(() => this._aborted ? reject(new Error('division-aborted')) : resolve())
          .catch(() => reject(new Error('division-aborted')));
      } else {
        resolve();
      }
    });
  }

  // ── DIVIDE: Phase 4 — Settle ────────────────────────────────
  //
  // Commit explicit styles, enable interaction, clean up.

  _phaseSettle() {
    this._setPhase('settled');

    const child = this._child;
    if (!child) return;

    // Release WAAPI fill:forwards overrides
    this._animator.releaseAll(child);

    // Commit explicit styles
    child.style.clipPath      = '';
    child.style.transform     = '';
    child.style.transition    = 'none';
    child.style.overflow      = 'visible';
    child.style.pointerEvents = 'auto';

    // Remnants
    this._removeBridge();
    this._removeMembrane();
    this._shellExit();

    if (this._onSettled) {
      this._onSettled({ parent: this._parent, child: this._child });
    }
  }

  // ── ABSORB: Phase 1 — Shrink ────────────────────────────────
  //
  // Child animates back toward parent (near-parent geometry).
  // CSS transitions on layout properties — membrane in split mode
  // reads real rects.

  _phaseShrink() {
    this._guard();
    return new Promise((resolve, reject) => {
      this._setPhase('shrink');

      const ax         = this._ax;
      const child      = this._child;
      const parentRect = this._parent.getBoundingClientRect();

      // ── Shell parent ──
      this._shellEnter();

      // ── Membrane in split mode ──
      if (this._useMembrane) {
        const memEls = this._membraneElements(child);
        this._membrane = AnimationEngine.createDivisionMembrane({
          ...this._membraneOpts,
          ...memEls,
          axis: this._ax.membraneAxis,
        });
        this._membrane.setSplit();
      }

      // ── Prepare child ──
      child.style.overflow      = 'hidden';
      child.style.pointerEvents = 'none';

      // Force layout commit
      child.getBoundingClientRect();

      // ── CSS transition to near-parent ──
      const shrinkMainPos = ax.sign > 0
        ? (ax.parentEdge(parentRect) + this._pinchGap)
        : (ax.parentEdge(parentRect) - this._pinchGap - this._budSize);

      AnimationEngine.afterFrames(() => {
        if (this._aborted) return reject(new Error('division-aborted'));

        child.style.transition = `
          width         ${this._splitDuration}ms var(--ease-standard),
          height        ${this._splitDuration}ms var(--ease-standard),
          top           ${this._splitDuration}ms var(--ease-standard),
          left          ${this._splitDuration}ms var(--ease-standard),
          border-radius ${Math.round(this._splitDuration * 0.8)}ms var(--ease-snappy)
        `;
        child.style[ax.crossSize] = `${ax.parentCrossSize(parentRect)}px`;
        child.style[ax.mainSize]  = `${this._budSize}px`;
        child.style[ax.mainPos]   = `${shrinkMainPos}px`;
        child.style[ax.crossPos]  = `${ax.parentCross(parentRect)}px`;
        child.style.transform     = 'none';
        child.style.borderRadius  = 'var(--radius-dynamic-island)';
      });

      AnimationEngine.afterTransitionOrTimeout(this._owner, child, {
        propertyName:  ax.mainSize,
        timeoutMs:     this._splitDuration + 100,
        timerProperty: TIMER_PROP,
        callback: () => this._aborted ? reject(new Error('division-aborted')) : resolve(),
      });
    });
  }

  // ── ABSORB: Phase 2 — Absorb ────────────────────────────────
  //
  // Membrane reconnects, child mainSize → 0, merges into parent.

  _phaseAbsorb() {
    this._guard();
    return new Promise((resolve, reject) => {
      this._setPhase('absorb');

      const ax         = this._ax;
      const child      = this._child;
      const parentRect = this._parent.getBoundingClientRect();

      // ── Membrane → connected (full cross-size, no bridge/pinch) ──
      if (this._membrane) {
        const memEls = this._membraneElements(child);
        this._membrane.setConnected({
          ...memEls,
          neckWidthProvider: ({ topRect, bottomRect }) =>
            Math.min(
              ax.membraneAxis === 'vertical' ? topRect.width  : topRect.height,
              ax.membraneAxis === 'vertical' ? bottomRect.width : bottomRect.height,
            ),
        });
      }

      // ── Animate child: merge into parent edge ──
      const dur         = this._budDuration;
      const absorbPos   = ax.parentEdge(parentRect) - this._budOverlap * ax.sign;
      // For negative directions the child's mainPos needs to track the shrinking edge
      const absorbMainPos = ax.sign > 0 ? absorbPos : absorbPos;

      // Border side that faces the parent (to collapse during merge)
      const borderSide = this._borderSideFacingParent();

      child.style.transition = `
        ${ax.mainSize}  ${dur}ms var(--ease-standard),
        ${ax.mainPos}   ${dur}ms var(--ease-standard),
        border-radius   200ms ease,
        ${borderSide}   80ms ease,
        opacity         160ms ease ${Math.round(dur * 0.4)}ms
      `;
      child.style[ax.mainPos]  = `${absorbMainPos}px`;
      child.style[ax.mainSize] = '0px';
      child.style.borderRadius = this._absorbBorderRadius();
      child.style[borderSide]  = 'none';
      child.style.opacity      = '0';

      AnimationEngine.afterTransitionOrTimeout(this._owner, child, {
        propertyName:  ax.mainSize,
        timeoutMs:     dur + 100,
        timerProperty: TIMER_PROP,
        callback: () => this._aborted ? reject(new Error('division-aborted')) : resolve(),
      });
    });
  }

  // ── ABSORB: Phase 3 — Remove ────────────────────────────────
  //
  // Child removed, parent restored, membrane cleaned.

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

  // ── Helpers ──────────────────────────────────────────────────

  /** Create the bridge element along the parent's budding edge */
  _createBridge(parentRect) {
    this._removeBridge();
    const ax       = this._ax;
    const isVert   = ax.membraneAxis === 'vertical';
    this._bridge   = document.createElement('div');

    // Bridge spans the gap between parent and child.
    // Vertical: full-width strip at parent bottom/top.
    // Horizontal: full-height strip at parent right/left.
    const bridgeMain  = isVert ? 2 : 2;
    const bridgeCross = isVert ? parentRect.width : parentRect.height;
    const bridgeMainPos = ax.sign > 0
      ? (ax.parentEdge(parentRect) - 1)
      : (ax.parentEdge(parentRect) - 1);
    const bridgeCrossPos = isVert ? parentRect.left : parentRect.top;

    this._bridge.style.cssText = `
      position: fixed;
      ${ax.mainPos}: ${bridgeMainPos}px;
      ${ax.crossPos}: ${bridgeCrossPos}px;
      ${ax.mainSize}: ${bridgeMain}px;
      ${ax.crossSize}: ${bridgeCross}px;
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

  /**
   * Returns { topElement, bottomElement } for the membrane controller,
   * respecting the direction.  The membrane always winds top→bottom or
   * left→right — for reversed directions we swap caller/parent roles.
   */
  _membraneElements(child) {
    const norm = this._ax.membraneNormal;
    if (norm === 'topBottom' || norm === 'leftRight') {
      return { topElement: this._parent, bottomElement: child };
    }
    // 'bottomTop' or 'rightLeft' — child is above/left of parent
    return { topElement: child, bottomElement: this._parent };
  }

  /**
   * Compute the clipPath percentage that hides the unrevealed
   * portion of the child along the main axis during the FLIP split.
   */
  _computeClipPercent(firstRect, target) {
    const ax = this._ax;
    const firstMain  = ax.mainSize === 'height' ? firstRect.height : firstRect.width;
    const targetMain = ax.mainSize === 'height' ? target.height    : target.width;
    return Math.max(0, ((targetMain - firstMain) / targetMain) * 100);
  }

  /**
   * Build an `inset()` CSS clip-path string that clips along
   * the appropriate side for the current direction.
   *
   *   inset(top right bottom left round radius)
   */
  _buildClipPath(pct, radius) {
    const side = this._ax.clipSide;
    const t = side === 'top'    ? pct : 0;
    const r = side === 'right'  ? pct : 0;
    const b = side === 'bottom' ? pct : 0;
    const l = side === 'left'   ? pct : 0;
    return `inset(${t}% ${r}% ${b}% ${l}% round ${radius}px)`;
  }

  /**
   * Returns the CSS border property that faces the parent
   * (e.g. 'border-top' for direction='down').
   */
  _borderSideFacingParent() {
    switch (this._direction) {
      case 'down':  return 'border-top';
      case 'up':    return 'border-bottom';
      case 'right': return 'border-left';
      case 'left':  return 'border-right';
      default:      return 'border-top';
    }
  }

  /**
   * Returns the border-radius value for the absorb phase — the side
   * touching the parent collapses to 0, opposite side keeps rounding.
   */
  _absorbBorderRadius() {
    const r = 'var(--radius-dynamic-island)';
    switch (this._direction) {
      case 'down':  return `0 0 ${r} ${r}`;
      case 'up':    return `${r} ${r} 0 0`;
      case 'right': return `0 ${r} ${r} 0`;
      case 'left':  return `${r} 0 0 ${r}`;
      default:      return `0 0 ${r} ${r}`;
    }
  }
}

export default DivisionAnimator;

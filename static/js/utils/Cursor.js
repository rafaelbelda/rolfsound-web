// static/js/utils/Cursor.js
import AnimationEngine from '/static/js/features/animations/AnimationEngine.js';

const INTERACTIVE_SELECTOR = [
  '.hover-target',
  '[data-cursor]:not([data-cursor="ignore"])',
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  'label[for]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="option"]',
  '[role="slider"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
  '[onclick]',
  '[data-action]',
  '[data-tab]',
  '[data-filter]',
  '[data-mode]',
  '[data-remove-idx]',
  '#webgl-container',
  '.btn',
  '.btn-action',
  '.dl-filter-btn',
  '.folder-close-btn',
  '.folder-sort-select',
  '.folder-track-remove',
  '.playlist-card',
  '.playlist-folder-track',
  '.playlist-picker-item',
  '.q-action-btn',
  '.q-item',
  '.q-remove',
  '.tab',
  '.track-action-btn',
  '.track-card'
].join(',');

const TEXT_SELECTOR = [
  'textarea',
  '[contenteditable="true"]',
  'input:not([type])',
  'input[type="email"]',
  'input[type="number"]',
  'input[type="password"]',
  'input[type="search"]',
  'input[type="tel"]',
  'input[type="text"]',
  'input[type="url"]'
].join(',');

const RANGE_SELECTOR = [
  'input[type="range"]',
  '[role="slider"]'
].join(',');

const CARD_SELECTOR = [
  '.playlist-card',
  '.playlist-folder-track',
  '.q-item',
  '.track-card',
  '[role="option"]'
].join(',');

const DANGER_SELECTOR = [
  '.btn-danger',
  '.q-action-danger',
  '.rs-context-item--danger',
  '[aria-label*="delete" i]',
  '[aria-label*="remove" i]',
  '[data-action*="delete" i]',
  '[title*="delete" i]',
  '[title*="remove" i]'
].join(',');

const TOGGLE_SELECTOR = [
  'input[type="checkbox"]',
  'input[type="radio"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '.toggle'
].join(',');

const MODE_CLASSES = [
  'cursor-card',
  'cursor-danger',
  'cursor-drag',
  'cursor-hidden',
  'cursor-pressing',
  'cursor-range',
  'cursor-select',
  'cursor-text',
  'cursor-toggle'
];

// Elements larger than these thresholds get pointer-follow instead of magnetic snap.
// Prevents large card rows from pulling the cursor away from where the user is pointing.
const SNAP_MAX_W = 200;
const SNAP_MAX_H = 72;
const LIVE_TRACK_MS = 720;
const LIVE_TRACK_EXTEND_MS = 180;
const TARGET_EXIT_PAD = 10;
const MIN_INTERACTIVE_OPACITY = 0.08;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function isElement(node) {
  return node?.nodeType === Node.ELEMENT_NODE;
}

export default class Cursor {
  constructor() {
    this.dot = document.getElementById('cursor-dot');
    this.mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    this.pos = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

    this.speedFree = 0.75;
    this.speedMagnetic = 0.2;
    this.speedFollow = 0.68;

    this.isHovering = false;
    this.isPressing = false;
    this.isContextRing = false;
    this.isContextMorphing = false;
    this.currentTarget = null;
    this.targetRect = null;
    this.targetRadius = '999px';
    this.cursorMode = 'default';
    this.contextMorphTimer = null;
    this.prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.isCoarsePointer = window.matchMedia?.('(pointer: coarse)').matches ?? false;

    this._renderBound = this.render.bind(this);
    this._onPointerMove = (e) => this.handlePointerMove(e);
    this._onPointerDown = (e) => this.handlePointerDown(e);
    this._onPointerUp = () => this.releasePress();
    this._onMouseLeave = () => {
      this.releasePress();
      this.resetHover();
      this.dot?.classList.add('cursor-hidden');
    };
    this._onScroll = () => {
      if (this.isHovering) this._geometryDirty = true;
    };
    this._onResize = () => {
      if (this.isHovering) this._geometryDirty = true;
    };
    this._onContextOpen = (e) => { this.startContextMorph(e.detail?.x, e.detail?.y); };
    this._onContextClose = () => this.stopContextMorph();
    this._rafId = null;
    this._geometryDirty = false;
    this._dotGeometry = { width: 0, height: 0, radius: '' };
    this._trackGeometryUntil = 0;
    this._lastRectKey = '';

    this.init();
  }

  init() {
    if (!this.dot) return;
    if (this.isCoarsePointer) {
      this.dot.classList.add('cursor-hidden');
      return;
    }

    window.addEventListener('pointermove', this._onPointerMove, { passive: true });
    window.addEventListener('pointerdown', this._onPointerDown, { passive: true });
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
    window.addEventListener('blur', this._onPointerUp);
    document.addEventListener('mouseleave', this._onMouseLeave);
    window.addEventListener('scroll', this._onScroll, { capture: true, passive: true });
    window.addEventListener('resize', this._onResize, { passive: true });
    window.addEventListener('rolfsound-context-open', this._onContextOpen);
    window.addEventListener('rolfsound-context-close', this._onContextClose);

    this._rafId = requestAnimationFrame(this._renderBound);
  }

  destroy() {
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    window.removeEventListener('blur', this._onPointerUp);
    document.removeEventListener('mouseleave', this._onMouseLeave);
    window.removeEventListener('scroll', this._onScroll, { capture: true });
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('rolfsound-context-open', this._onContextOpen);
    window.removeEventListener('rolfsound-context-close', this._onContextClose);
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    AnimationEngine.clearScheduled(this, 'contextMorphTimer');
  }

  handlePointerMove(e) {
    if (e.pointerType === 'touch') {
      this.dot?.classList.add('cursor-hidden');
      return;
    }

    this.dot?.classList.remove('cursor-hidden');
    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
    this.checkHoverState(e);
  }

  handlePointerDown(e) {
    if (e.pointerType === 'touch') return;

    this.mouse.x = e.clientX;
    this.mouse.y = e.clientY;
    this.isPressing = true;
    this.dot?.classList.add('cursor-pressing');
    this.checkHoverState(e);

    if (this.cursorMode === 'range' || this.cursorMode === 'drag') {
      this.dot?.classList.add('cursor-drag');
      this._geometryDirty = true;
    }
  }

  releasePress() {
    this.isPressing = false;
    this.dot?.classList.remove('cursor-pressing', 'cursor-drag');
    if (this.cursorMode === 'drag') this._geometryDirty = true;
  }

  resetHover() {
    if (!this.dot) return;

    this.isHovering = false;
    this.currentTarget = null;
    this.targetRect = null;
    this._geometryDirty = false;
    this._trackGeometryUntil = 0;
    this._lastRectKey = '';
    this.setCursorMode('default');
    this.dot.classList.remove('hovering');

    this.dot.style.width = '';
    this.dot.style.height = '';
    this.dot.style.borderRadius = '';
    this.dot.style.border = '';
    this.dot.style.background = '';
    this.dot.style.backgroundColor = '';

    this.dot.style.setProperty('--dx', '0px');
    this.dot.style.setProperty('--dy', '0px');
    this._dotGeometry = { width: 0, height: 0, radius: '' };
  }

  setCursorMode(mode) {
    if (!this.dot) return;

    const normalized = mode || 'default';
    if (this.cursorMode === normalized) return;

    this.dot.classList.remove(...MODE_CLASSES.filter((className) => className !== 'cursor-hidden' && className !== 'cursor-pressing'));
    this.cursorMode = normalized;

    if (normalized !== 'default') {
      this.dot.classList.add(`cursor-${normalized}`);
    }
  }

  setContextRing() {
    if (this.isContextRing) return;
    this.isContextRing = true;
    this.dot.classList.remove('hovering');
    this.setCursorMode('default');
    this.dot.classList.add('context-ring');
    this.dot.style.setProperty('--dx', '0px');
    this.dot.style.setProperty('--dy', '0px');
  }

  clearContextRing() {
    if (!this.isContextRing) return;
    this.isContextRing = false;
    this.dot.classList.remove('context-ring');
    this.dot.style.border = '';
    this.dot.style.background = '';
    this.dot.style.backgroundColor = '';
  }

  checkHoverState(e) {
    if (this.isContextMorphing) return;

    if (this.currentTarget && !this.isValidTarget(this.currentTarget)) {
      this.resetHover();
    }

    const path = e.composedPath?.() || [];
    const target = this.findCursorTarget(path);
    const insideContextMenu = path.some((el) => isElement(el) && el.classList.contains('rs-context-menu'));

    if (target) {
      this.clearContextRing();
      this.setHoverTarget(target);
    } else if (insideContextMenu) {
      if (this.isHovering) this.resetHover();
      this.setContextRing();
    } else if (this.isHovering) {
      this.clearContextRing();
      this.resetHover();
    } else {
      this.clearContextRing();
    }
  }

  findCursorTarget(path) {
    for (const node of path) {
      if (!isElement(node) || node === this.dot || node.id === 'cursor-dot') continue;
      if (node.closest?.('[data-cursor="ignore"]')) return null;
      if (this.isValidTarget(node) && this.matchesInteractiveTarget(node)) return node;
    }
    return null;
  }

  matchesInteractiveTarget(el) {
    if (el.matches?.(INTERACTIVE_SELECTOR)) return true;
    return false;
  }

  isValidTarget(el) {
    if (!isElement(el) || !el.isConnected) return false;
    if (el.matches?.('[data-cursor="ignore"], :disabled, [disabled], [aria-disabled="true"]')) return false;
    if (el.closest?.('[inert], [aria-hidden="true"]')) return false;
    if (this.isVisuallyUnavailable(el)) return false;
    return true;
  }

  isVisuallyUnavailable(el) {
    let node = el;
    while (node && isElement(node)) {
      const style = window.getComputedStyle(node);
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.pointerEvents === 'none' ||
        Number(style.opacity) <= MIN_INTERACTIVE_OPACITY
      ) {
        return true;
      }

      const root = node.getRootNode?.();
      node = root instanceof ShadowRoot ? root.host : node.parentElement;
    }

    return false;
  }

  setHoverTarget(target) {
    const mode = this.getCursorModeForTarget(target);

    if (this.currentTarget !== target || this.cursorMode !== mode) {
      this.currentTarget = target;
      this.isHovering = true;
      this.dot.classList.add('hovering');
      this.setCursorMode(mode);
      this.startLiveGeometryTracking(LIVE_TRACK_MS);
      if (!this.syncTargetGeometry()) this.resetHover();
    } else if (!this.targetRect) {
      this._geometryDirty = true;
      this.startLiveGeometryTracking(LIVE_TRACK_EXTEND_MS);
    }
  }

  getCursorModeForTarget(target) {
    const explicit = target.getAttribute?.('data-cursor');
    if (explicit && explicit !== 'target') return explicit;
    if (target.id === 'webgl-container' || target.matches?.('[draggable="true"], .draggable, .grab, .grabbable')) return 'drag';
    if (target.matches?.(TEXT_SELECTOR)) return 'text';
    if (target.matches?.(RANGE_SELECTOR)) return 'range';
    if (target.matches?.('select')) return 'select';
    if (target.matches?.(DANGER_SELECTOR)) return 'danger';
    if (target.matches?.(TOGGLE_SELECTOR)) return 'toggle';
    if (target.matches?.(CARD_SELECTOR)) return 'card';
    return 'interactive';
  }

  syncTargetGeometry() {
    if (!this.dot || !this.currentTarget || !this.isValidTarget(this.currentTarget)) return false;

    const rect = this.currentTarget.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;

    const style = window.getComputedStyle(this.currentTarget);
    let width = rect.width;
    let height = rect.height;
    let radius = style.borderRadius || '999px';

    if (this.cursorMode === 'text') {
      width = 3;
      height = clamp(rect.height * 0.7, 18, 30);
      radius = '3px';
    } else if (this.cursorMode === 'range') {
      const horizontal = rect.width >= rect.height;
      width = horizontal ? 34 : 16;
      height = horizontal ? 16 : 34;
      radius = '999px';
    } else if (this.cursorMode === 'drag') {
      width = this.isPressing ? 24 : 18;
      height = this.isPressing ? 24 : 18;
      radius = '999px';
    } else if (this.cursorMode === 'select') {
      width = Math.min(rect.width, 120);
      height = rect.height;
    } else if (this.cursorMode === 'card') {
      const isLarge = rect.width > SNAP_MAX_W || rect.height > SNAP_MAX_H;
      if (isLarge) {
        // Large card rows: keep cursor as a small dot — it follows the pointer,
        // so expanding it to card dimensions would create a huge distracting pill.
        width = 8;
        height = 8;
        radius = '999px';
      } else {
        width = Math.min(rect.width + 4, 160);
        height = Math.min(rect.height + 2, 52);
      }
    }

    this.targetRect = rect;
    this.targetRadius = radius;
    this._geometryDirty = false;
    this.updateLiveGeometryWindow(rect);

    if (
      width !== this._dotGeometry.width ||
      height !== this._dotGeometry.height ||
      radius !== this._dotGeometry.radius
    ) {
      this.dot.style.width = `${width}px`;
      this.dot.style.height = `${height}px`;
      this.dot.style.borderRadius = radius;
      this._dotGeometry = { width, height, radius };
    }
    return true;
  }

  startLiveGeometryTracking(durationMs = LIVE_TRACK_EXTEND_MS) {
    this._trackGeometryUntil = Math.max(
      this._trackGeometryUntil,
      performance.now() + durationMs
    );
  }

  shouldTrackGeometryLive() {
    if (!this.isHovering || !this.currentTarget) return false;
    if (performance.now() < this._trackGeometryUntil) return true;

    const animations = this.currentTarget.getAnimations?.({ subtree: false }) || [];
    return animations.some(animation => (
      animation.playState === 'running' ||
      animation.playState === 'pending'
    ));
  }

  updateLiveGeometryWindow(rect) {
    const nextKey = [
      rect.left.toFixed(1),
      rect.top.toFixed(1),
      rect.width.toFixed(1),
      rect.height.toFixed(1)
    ].join(',');

    if (this._lastRectKey && this._lastRectKey !== nextKey) {
      this.startLiveGeometryTracking(LIVE_TRACK_EXTEND_MS);
    }

    this._lastRectKey = nextKey;
  }

  pointerInsideRect(rect, pad = 0) {
    if (!rect) return false;
    return (
      this.mouse.x >= rect.left - pad &&
      this.mouse.x <= rect.right + pad &&
      this.mouse.y >= rect.top - pad &&
      this.mouse.y <= rect.bottom + pad
    );
  }

  targetFollowsPointer() {
    if (['drag', 'range', 'text'].includes(this.cursorMode)) return true;
    // Large containers (card rows, wide lists) follow the pointer instead of snapping
    // to their center — avoids the cursor jumping far from the actual mouse position.
    if (this.cursorMode === 'card' && this.targetRect) {
      return this.targetRect.width > SNAP_MAX_W || this.targetRect.height > SNAP_MAX_H;
    }
    return false;
  }

  startContextMorph(x, y) {
    if (!this.dot) return;

    if (Number.isFinite(x) && Number.isFinite(y)) {
      this.mouse.x = x;
      this.mouse.y = y;
      this.pos.x = x;
      this.pos.y = y;
    }

    if (this.contextMorphTimer) {
      AnimationEngine.clearScheduled(this, 'contextMorphTimer');
      this.contextMorphTimer = null;
    }

    this.clearContextRing();
    this.resetHover();

    this.isContextMorphing = true;
    this.dot.classList.add('context-morphing');

    AnimationEngine.schedule(this, () => {
      this.dot.classList.remove('context-morphing');
      this.isContextMorphing = false;
      this.contextMorphTimer = null;
    }, 220, 'contextMorphTimer');
  }

  stopContextMorph() {
    if (!this.dot) return;

    AnimationEngine.clearScheduled(this, 'contextMorphTimer');
    this.contextMorphTimer = null;

    this.isContextMorphing = false;
    this.dot.classList.remove('context-morphing');
  }

  render() {
    let targetX;
    let targetY;
    let currentSpeed;

    if (this.isContextMorphing) {
      targetX = this.pos.x;
      targetY = this.pos.y;
      currentSpeed = 1;
    } else if (this.isHovering && this.currentTarget) {
      if (!this.isValidTarget(this.currentTarget)) {
        this.resetHover();
        targetX = this.mouse.x;
        targetY = this.mouse.y;
        currentSpeed = this.speedFree;
      } else {
        if ((this._geometryDirty || this.shouldTrackGeometryLive()) && !this.syncTargetGeometry()) {
          this.resetHover();
          targetX = this.mouse.x;
          targetY = this.mouse.y;
          currentSpeed = this.speedFree;
        } else if (!this.isPressing && !this.pointerInsideRect(this.targetRect, TARGET_EXIT_PAD)) {
          this.resetHover();
          targetX = this.mouse.x;
          targetY = this.mouse.y;
          currentSpeed = this.speedFree;
        } else {
          if (this.targetFollowsPointer()) {
            targetX = this.mouse.x;
            targetY = this.mouse.y;
            currentSpeed = this.speedFollow;
          } else {
            targetX = this.targetRect.left + this.targetRect.width / 2;
            targetY = this.targetRect.top + this.targetRect.height / 2;
            currentSpeed = this.speedMagnetic;
          }

          const dx = (this.mouse.x - targetX) * 0.4;
          const dy = (this.mouse.y - targetY) * 0.4;
          this.dot.style.setProperty('--dx', `${dx}px`);
          this.dot.style.setProperty('--dy', `${dy}px`);
        }
      }
    } else {
      targetX = this.mouse.x;
      targetY = this.mouse.y;
      currentSpeed = this.speedFree;
    }

    if (this.prefersReducedMotion) {
      this.pos.x = targetX;
      this.pos.y = targetY;
    } else {
      this.pos.x += (targetX - this.pos.x) * currentSpeed;
      this.pos.y += (targetY - this.pos.y) * currentSpeed;
    }

    this.dot.style.transform = `translate3d(calc(${this.pos.x}px - 50%), calc(${this.pos.y}px - 50%), 0) scale(var(--cursor-scale, 1))`;

    this._rafId = requestAnimationFrame(this._renderBound);
  }
}

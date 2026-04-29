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
    this.cursorMode = 'default';
    this.contextMorphTimer = null;
    this.prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

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
      if (this.isHovering && this.isValidTarget(this.currentTarget)) {
        this.targetRect = this.currentTarget.getBoundingClientRect();
      }
    };
    this._onContextOpen = (e) => { this.startContextMorph(e.detail?.x, e.detail?.y); };
    this._onContextClose = () => this.stopContextMorph();
    this._rafId = null;

    this.init();
  }

  init() {
    if (!this.dot) return;

    window.addEventListener('pointermove', this._onPointerMove, { passive: true });
    window.addEventListener('pointerdown', this._onPointerDown, { passive: true });
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
    window.addEventListener('blur', this._onPointerUp);
    document.addEventListener('mouseleave', this._onMouseLeave);
    window.addEventListener('scroll', this._onScroll, { capture: true, passive: true });
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
    }
  }

  releasePress() {
    this.isPressing = false;
    this.dot?.classList.remove('cursor-pressing', 'cursor-drag');
  }

  resetHover() {
    if (!this.dot) return;

    this.isHovering = false;
    this.currentTarget = null;
    this.targetRect = null;
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

    const cursor = window.getComputedStyle(el).cursor;
    return cursor && !['auto', 'default', 'none'].includes(cursor);
  }

  isValidTarget(el) {
    if (!isElement(el) || !el.isConnected) return false;
    if (el.matches?.('[data-cursor="ignore"], :disabled, [disabled], [aria-disabled="true"]')) return false;
    if (el.closest?.('[inert], [aria-hidden="true"]')) return false;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;

    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

  setHoverTarget(target) {
    const mode = this.getCursorModeForTarget(target);

    if (this.currentTarget !== target || this.cursorMode !== mode) {
      this.currentTarget = target;
      this.isHovering = true;
      this.dot.classList.add('hovering');
      this.setCursorMode(mode);
      this.syncTargetGeometry();
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
    if (!this.dot || !this.currentTarget) return;

    const rect = this.currentTarget.getBoundingClientRect();
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
    this.dot.style.width = `${width}px`;
    this.dot.style.height = `${height}px`;
    this.dot.style.borderRadius = radius;
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
      if (!this.isValidTarget(this.currentTarget) || !this.matchesInteractiveTarget(this.currentTarget)) {
        this.resetHover();
        targetX = this.mouse.x;
        targetY = this.mouse.y;
        currentSpeed = this.speedFree;
      } else {
        this.syncTargetGeometry();

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

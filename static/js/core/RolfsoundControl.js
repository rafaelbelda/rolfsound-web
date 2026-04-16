// static/js/core/RolfsoundControl.js
//
// Abstract base class for Rolfsound UI controls. Enforces the component
// contract:
//   - Each control has its own Shadow DOM (style encapsulation)
//   - Each control talks to the core ONLY through window.rolfsoundChannel
//   - Each control tears down its subscriptions on disconnect (RPi memory hygiene)
//
// Subclasses override render() and subscribe(). Inside subscribe(), use
// this.on(type, fn) — the base class records the returned unsubscribe handle
// and invokes it in disconnectedCallback.

export default class RolfsoundControl extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._unsubs = [];
  }

  connectedCallback() {
    if (!this._rendered) {
      this.render();
      this._rendered = true;
    }
    this.subscribe();
  }

  disconnectedCallback() {
    for (const fn of this._unsubs) {
      try { fn(); } catch (e) { console.error('[RolfsoundControl] unsubscribe error:', e); }
    }
    this._unsubs.length = 0;
  }

  render() { /* override */ }
  subscribe() { /* override */ }

  on(type, fn) {
    const ch = window.rolfsoundChannel;
    if (!ch) {
      console.warn(`[RolfsoundControl] window.rolfsoundChannel unavailable; cannot subscribe to "${type}"`);
      return;
    }
    this._unsubs.push(ch.on(type, fn));
  }

  send(type, payload) {
    const ch = window.rolfsoundChannel;
    if (!ch) {
      console.warn(`[RolfsoundControl] window.rolfsoundChannel unavailable; cannot send "${type}"`);
      return Promise.resolve({ ok: false, error: 'no_channel' });
    }
    return ch.send(type, payload);
  }
}

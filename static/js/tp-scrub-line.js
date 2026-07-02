/* ============================================================
   ROLFSOUND V2 — Mini-player minimal line scrub (behaviour)
   Drives .transport .tp-scrub (the flush hairline seek strip).
   Hover shows a floating timecode + reveals the bar; drag commits
   the position through the same Player/.tp-fill/.tp-time contract
   the rest of the app already uses, so playback sync (prototype.js,
   prototype-motion.js, remixer-engine.js) keeps working untouched.
   The fullscreen visualizer's waveform seekbar is unrelated to this
   file — it still runs on seekbar.js.
   ============================================================ */
(function () {
  'use strict';

  var Player = window.RolfPlayer = window.RolfPlayer || {};

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function mmss(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function commit(frac) {
    frac = clamp01(frac);
    Player.pos = frac;
    var dur = Player.dur || 228;
    document.querySelectorAll('.tp-fill').forEach(function (f) { f.style.width = (frac * 100).toFixed(2) + '%'; });
    var t0 = document.querySelector('.transport .tp-time');
    if (t0) t0.textContent = mmss(frac * dur);
    var ve = document.querySelector('[data-viz-elapsed]');
    if (ve) ve.textContent = mmss(frac * dur);
    if (window.RolfRemixer && window.RolfRemixer.playing && window.RolfRemixer.seek) {
      try { window.RolfRemixer.seek(frac); } catch (e) {}
    }
  }

  function init(root) {
    var bubble = root.querySelector('.tp-bar-bubble');
    var dragging = false;

    function fracFromEvent(e) {
      var r = root.getBoundingClientRect();
      return clamp01((e.clientX - r.left) / r.width);
    }
    function placeBubble(frac) {
      bubble.style.left = (frac * 100).toFixed(2) + '%';
      bubble.textContent = mmss(frac * (Player.dur || 228));
    }

    root.addEventListener('pointermove', function (e) {
      var f = fracFromEvent(e);
      placeBubble(f);
      if (dragging) commit(f);
    });
    root.addEventListener('pointerdown', function (e) {
      dragging = true;
      root.classList.add('is-drag');
      root.setPointerCapture(e.pointerId);
      var f = fracFromEvent(e);
      commit(f);
      placeBubble(f);
      e.preventDefault();
    });
    function end(e) {
      if (!dragging) return;
      dragging = false;
      root.classList.remove('is-drag');
      try { root.releasePointerCapture(e.pointerId); } catch (_) {}
    }
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);

    // keyboard: focusable, arrows nudge ±5s, Home/End jump
    root.tabIndex = 0;
    root.setAttribute('role', 'slider');
    root.setAttribute('aria-label', 'Posição da faixa');
    root.addEventListener('keydown', function (e) {
      var d = Player.dur || 228, p = Player.pos || 0;
      if (e.key === 'ArrowRight') commit(p + 5 / d);
      else if (e.key === 'ArrowLeft') commit(p - 5 / d);
      else if (e.key === 'Home') commit(0);
      else if (e.key === 'End') commit(0.999);
      else return;
      e.preventDefault();
    });
  }

  function boot() {
    document.querySelectorAll('.transport [data-tp-scrub]').forEach(function (el) {
      if (el._lineInit) return;
      el._lineInit = true;
      init(el);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

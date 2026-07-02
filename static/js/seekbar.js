/* ============================================================
   ROLFSOUND V2 — Waveform seek scrubber (behaviour)
   Each [data-seekbar] renders a deterministic bar-waveform onto a
   canvas, floods the played portion with the accent, and supports:
     · click / drag to seek (pointer-captured)
     · hover → "jump-to" preview region + timecode bubble + ghost line
     · live playhead synced to window.RolfPlayer.pos every frame
   Seeking routes through the remixer audio engine when it's live,
   otherwise straight to the shared Player position.
   ============================================================ */
(function () {
  'use strict';

  var Player = window.RolfPlayer = window.RolfPlayer || {};
  if (typeof Player.dur !== 'number') Player.dur = 228;
  if (typeof Player.pos !== 'number') Player.pos = 0.32;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function mmss(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }
  function hash(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function accent() {
    var c = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    return c || '#c8693c';
  }
  function reduce() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
      || document.body.classList.contains('reduce-motion');
  }

  // current track signature → re-seed the waveform shape on track change
  function trackSig() {
    var t = document.querySelector('.transport .tp-title');
    return (t && t.textContent.trim()) || 'rolfsound';
  }

  // route a seek to wherever playback actually lives
  function doSeek(frac) {
    frac = clamp01(frac);
    Player.pos = frac;
    if (window.RolfRemixer && window.RolfRemixer.playing && window.RolfRemixer.seek) {
      try { window.RolfRemixer.seek(frac); } catch (e) {}
    }
    // keep the elapsed read-outs in step immediately
    var t0 = document.querySelector('.transport .tp-time');
    if (t0) t0.textContent = mmss(frac * Player.dur);
    var ve = document.querySelector('[data-viz-elapsed]');
    if (ve) ve.textContent = mmss(frac * Player.dur);
  }

  function Scrubber(root) {
    var canvas = root.querySelector('.seekbar-wave');
    var head = root.querySelector('.seekbar-head');
    var ghost = root.querySelector('.seekbar-ghost');
    var bubble = root.querySelector('.seekbar-bubble');
    var ctx = canvas.getContext('2d');

    var W = 0, H = 0, dpr = 1;
    var seed = hash(trackSig());
    var lastSig = trackSig();
    var hoverFrac = -1;          // -1 = not hovering
    var scrubbing = false;
    var lastDrawnPos = -1, lastDrawnHover = -2;

    var BAR = 2, GAP = 2;        // bar + gap in CSS px
    var SIGMA = 0.075;          // width of the crest (cascade falloff)

    function playing() { return !document.body.classList.contains('paused'); }

    // TIDE envelope: zenith at the current play position, cascading
    // down on both sides. `t` (seconds) adds a living swell while playing.
    function tide(f, pos, t) {
      var d = Math.abs(f - pos);
      var crest = Math.exp(-(d * d) / (2 * SIGMA * SIGMA));   // 1 at the playhead
      var base = 0.17;                                        // low-water line
      var h = base + (1 - base) * crest;
      if (t != null) h *= 1 + 0.055 * Math.sin(f * 30 + t * 2.2) * (0.25 + 0.75 * crest);
      return Math.max(0.05, Math.min(1, h));
    }

    function resize() {
      var r = canvas.getBoundingClientRect();
      W = Math.max(1, r.width); H = Math.max(1, r.height);
      dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      head.style.left = (clamp01(Player.pos) * 100).toFixed(2) + '%';
      lastDrawnPos = -1;           // force redraw
      draw(true);
    }

    function hexRgb(hex) {
      hex = (hex || '').replace('#', '');
      if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
      var n = parseInt(hex || 'c8693c', 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function draw(force) {
      var pos = clamp01(Player.pos);
      if (!force && Math.abs(pos - lastDrawnPos) < 0.0006 && hoverFrac === lastDrawnHover) return;
      lastDrawnPos = pos; lastDrawnHover = hoverFrac;

      var rgb = hexRgb(accent());
      var ar = rgb[0], ag = rgb[1], ab = rgb[2];
      var step = BAR + GAP;
      var n = Math.max(1, Math.floor(W / step));
      var mid = H / 2;
      var t = (playing() && !reduce()) ? performance.now() / 1000 : null;
      ctx.clearRect(0, 0, W, H);

      // hover preview spans between the current position and the cursor
      var prevLo = -1, prevHi = -1;
      if (hoverFrac >= 0 && !scrubbing) {
        prevLo = Math.min(pos, hoverFrac);
        prevHi = Math.max(pos, hoverFrac);
      }

      for (var i = 0; i < n; i++) {
        var f = (i + 0.5) / n;
        var bh = tide(f, pos, t) * (H * 0.58);
        var x = i * step;
        var played = f <= pos;
        var inPrev = f > prevLo && f <= prevHi;
        if (played) {
          ctx.fillStyle = 'rgba(' + ar + ',' + ag + ',' + ab + ',0.95)';
        } else if (inPrev) {
          ctx.fillStyle = 'rgba(' + ar + ',' + ag + ',' + ab + ',0.34)';
        } else {
          ctx.fillStyle = 'rgba(232,233,238,0.20)';
        }
        var r = Math.min(BAR / 2, 1.2);
        roundRect(ctx, x, H - bh, BAR, bh, r);
        ctx.fill();
      }
    }

    function roundRect(c, x, y, w, h, r) {
      c.beginPath();
      c.moveTo(x + r, y);
      c.arcTo(x + w, y, x + w, y + h, r);
      c.arcTo(x + w, y + h, x, y + h, r);
      c.arcTo(x, y + h, x, y, r);
      c.arcTo(x, y, x + w, y, r);
      c.closePath();
    }

    function fracFromEvent(e) {
      var r = root.getBoundingClientRect();
      return clamp01((e.clientX - r.left) / r.width);
    }
    function placeBubble(frac) {
      var pct = (frac * 100).toFixed(2) + '%';
      bubble.style.left = pct;
      ghost.style.left = pct;
      bubble.textContent = mmss(frac * Player.dur);
    }

    // ---- pointer interaction ----
    root.addEventListener('pointerenter', function () { /* hover handled on move */ });
    root.addEventListener('pointermove', function (e) {
      hoverFrac = fracFromEvent(e);
      if (!scrubbing) placeBubble(hoverFrac);
    });
    root.addEventListener('pointerleave', function () {
      if (!scrubbing) { hoverFrac = -1; draw(true); }
    });
    root.addEventListener('pointerdown', function (e) {
      scrubbing = true;
      root.classList.add('is-scrubbing');
      root.setPointerCapture(e.pointerId);
      var f = fracFromEvent(e);
      hoverFrac = f;
      head.style.left = (f * 100).toFixed(2) + '%';
      placeBubble(f);
      doSeek(f);
      draw(true);
      e.preventDefault();
    });
    root.addEventListener('pointermove', function (e) {
      if (!scrubbing) return;
      var f = fracFromEvent(e);
      hoverFrac = f;
      head.style.left = (f * 100).toFixed(2) + '%';
      placeBubble(f);
      doSeek(f);
      draw(true);
    });
    function endScrub(e) {
      if (!scrubbing) return;
      scrubbing = false;
      root.classList.remove('is-scrubbing');
      try { root.releasePointerCapture(e.pointerId); } catch (_) {}
      hoverFrac = fracFromEvent(e);
      placeBubble(hoverFrac);
      draw(true);
    }
    root.addEventListener('pointerup', endScrub);
    root.addEventListener('pointercancel', endScrub);

    // keyboard: focusable, arrows nudge ±5s, Home/End jump
    root.tabIndex = 0;
    root.setAttribute('role', 'slider');
    root.setAttribute('aria-label', 'Posição da faixa');
    root.addEventListener('keydown', function (e) {
      var d = Player.dur || 228, p = Player.pos;
      if (e.key === 'ArrowRight') { doSeek(p + 5 / d); }
      else if (e.key === 'ArrowLeft') { doSeek(p - 5 / d); }
      else if (e.key === 'Home') { doSeek(0); }
      else if (e.key === 'End') { doSeek(0.999); }
      else return;
      e.preventDefault();
      draw(true);
    });

    // ---- per-frame sync to playback ----
    function tick() {
      var sig = trackSig();
      if (sig !== lastSig) { lastSig = sig; seed = hash(sig); lastDrawnPos = -1; }
      var pos = clamp01(Player.pos);
      head.style.left = (pos * 100).toFixed(2) + '%';
      draw(playing());      // force a redraw while playing so the tide flows
      requestAnimationFrame(tick);
    }

    if (window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
    window.addEventListener('resize', resize);
    resize();
    requestAnimationFrame(tick);
  }

  function init() {
    document.querySelectorAll('[data-seekbar]').forEach(function (el) {
      if (el._seek) return;
      el._seek = true;
      new Scrubber(el);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

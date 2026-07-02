/* ============================================================
   ROLFSOUND V2 — UI auto-scale
   The dashboard is a px-based, full-viewport surface. On a common
   full-HD laptop its chrome reads a touch large, so we scale the
   whole .appshell proportionally to the viewport via CSS `zoom`
   (reflows, no letterboxing — keeps position:fixed filling).

   scale = clamp(MIN, min(w/REF_W, h/REF_H), MAX) * density
     · REF_*  = the "100% comfortable" target (a roomy desktop)
     · cap at MAX so it never inflates past the native design
     · floor at MIN so tiny windows stay legible
   Only .appshell is zoomed; the fullscreen visualizer (.viz) and
   the body-level context menu already use viewport-relative units.
   ============================================================ */
(function () {
  'use strict';

  // Tight band: trim a little on full-HD, but never shrink small
  // laptops into oblivion. Below ~1820px wide it rests at the floor.
  var REF_W = 2180, REF_H = 1230;   // 1920×1080 → ~0.88; smaller → floor
  var MIN = 0.84, MAX = 1.0;

  function density() {
    var v = parseFloat(localStorage.getItem('rolf_ui_density'));
    return (v >= 0.7 && v <= 1.3) ? v : 1;
  }

  function compute() {
    var s = Math.min(window.innerWidth / REF_W, window.innerHeight / REF_H);
    s = Math.max(MIN, Math.min(MAX, s)) * density();
    return Math.max(0.72, Math.min(1.2, s));
  }

  var rafPaint = null;
  function apply() {
    var s = compute().toFixed(4);
    document.querySelectorAll('.appshell').forEach(function (el) { el.style.zoom = s; });
    document.documentElement.style.setProperty('--ui-scale', s);
    if (rafPaint) cancelAnimationFrame(rafPaint);
    rafPaint = requestAnimationFrame(function () {
      if (window.RolfPaint) window.RolfPaint();
    });
  }

  // public hook: density 0.7 (compact) … 1.0 (default) … 1.3 (roomy)
  window.RolfScale = {
    apply: apply,
    get: function () { return density(); },
    set: function (mult) {
      if (mult == null || mult === 1) localStorage.removeItem('rolf_ui_density');
      else localStorage.setItem('rolf_ui_density', String(mult));
      apply();
    }
  };

  // run as early as possible (script sits before the painters in <body>,
  // so .appshell already exists → no unscaled flash)
  apply();
  window.addEventListener('resize', apply);
  window.addEventListener('load', apply);
})();

/* ============================================================
   ROLFSOUND V2 — SCRUB CLIENT (TP-7 / pickup de DJ)
   Cliente reutilizável do WebSocket de scrub do core (scrub_ws_service):
   qualquer superfície de seek (linha do transporte, waveform do
   visualizer, um futuro jog wheel) fala com o MESMO objeto:

     RolfScrub.beginFrac(f) -> bool   entra no gesto (false = use o
                                      seek clássico como fallback)
     RolfScrub.targetFrac(f)          alvo do playhead (até ~60 Hz)
     RolfScrub.rate(r) -> bool        rate fixo (reverse = -1)
     RolfScrub.end()                  solta o gesto (o CORE faz o seek real)

   Descoberta: o bloco `scrub` do /api/status (porta, disponibilidade,
   progresso do cache) chega via 'rolf:status'. O WS conecta cedo
   (assim o pointerdown não paga handshake) e fica vivo entre gestos.

   Eco de posição: o core manda a posição REAL a ~30 Hz durante o
   gesto; repassamos ao bridge via RolfPlayback.noteExternalSeek()
   (âncora congelada) — todas as barras seguem o playhead de verdade,
   incluindo o arrasto varispeed. Também emite 'rolf:scrub' p/ quem
   quiser reagir (ex.: efeitos visuais).

   Config: switch "Scrub de fita" (scrub_tape_mode, default ligado) —
   desligado, beginFrac() devolve false e tudo cai no seek clássico.

   Bônus TP-7: segurar R = reverse contínuo; soltar retoma.
   ============================================================ */
(function () {
  'use strict';

  var enabled = true;          // scrub_tape_mode (api/settings)
  var info = null;             // bloco `scrub` do último /api/status
  var srcDur = 0;              // duração em tempo de FONTE (s)
  var ws = null;
  var wsOpen = false;
  var gesture = false;         // gesto local ativo (pointer ou reverse)
  var settling = false;        // pós-release: o spinback ainda soa e ecoa
  var settleTimer = null;      // rede de segurança se o 'ended' não vier
  var lastTargetSec = null;    // fallback: seek clássico se o WS morrer

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function dur() {
    return (info && info.duration_s > 0) ? info.duration_s : srcDur;
  }

  function usable() {
    return enabled && info && info.available && info.port;
  }

  /* ---------------- WebSocket ---------------- */
  function wsUrl() {
    return 'ws://' + location.hostname + ':' + info.port;
  }

  function connect() {
    if (ws || !usable()) return;
    try { ws = new WebSocket(wsUrl()); } catch (e) { ws = null; return; }
    ws.onopen = function () { wsOpen = true; };
    ws.onclose = function () {
      wsOpen = false; ws = null;
      endSettling();
      // Gesto órfão: garante que o seek aconteça mesmo com o WS morto.
      if (gesture) { gesture = false; fallbackSeek(); emit('end', null); }
    };
    ws.onerror = function () { try { ws && ws.close(); } catch (e) {} };
    ws.onmessage = function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (!d || typeof d !== 'object') return;
      if (d.type === 'pos' && (gesture || settling)) {
        // durante o gesto E o spinback pós-release: a barra segue o
        // playhead REAL (âncora congelada — quem anda é o eco)
        report(d.pos, false);
        emit('pos', d);
      } else if (d.type === 'ended') {
        endSettling();
        report(d.pos, true);
        emit('end', d);
      } else if (d.type === 'begun' && d.ok === false && gesture) {
        // O core recusou (cache ainda não pronto etc.) — vira seek clássico.
        gesture = false;
        fallbackSeek();
      }
    };
  }

  function send(obj) {
    if (ws && wsOpen) {
      try { ws.send(JSON.stringify(obj)); return true; } catch (e) {}
    }
    return false;
  }

  /* ---------------- ponte com o bridge ---------------- */
  // anchored=false congela o dead-reckoning: a barra segue só o eco real.
  function report(pos, anchored) {
    if (typeof pos !== 'number') return;
    var PB = window.RolfPlayback;
    if (PB && PB.noteExternalSeek) PB.noteExternalSeek(pos, { anchor: anchored });
  }

  function fallbackSeek() {
    if (lastTargetSec != null && window.RolfPlayback) {
      try { window.RolfPlayback.seekSec(lastTargetSec); } catch (e) {}
    }
    lastTargetSec = null;
  }

  function emit(type, data) {
    document.dispatchEvent(new CustomEvent('rolf:scrub', {
      detail: { type: type, data: data || null, active: gesture },
    }));
  }

  function endSettling() {
    settling = false;
    if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
  }
  function beginSettling() {
    settling = true;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(endSettling, 9000);   // 'ended' nunca veio
  }

  /* ---------------- API pública ---------------- */
  var RolfScrub = {
    get available() { return !!usable(); },
    get active() { return gesture; },

    beginSec: function (sec) {
      if (!usable()) return false;
      connect();
      endSettling();               // re-grab cancela o assentamento anterior
      gesture = true;
      lastTargetSec = clamp(sec || 0, 0, dur() || Infinity);
      if (!send({ type: 'begin', pos: lastTargetSec })) {
        // WS ainda abrindo: o gesto segue; o alvo é reenviado no move e o
        // end() cai no fallback se nunca abrir. (Conectamos cedo, então
        // isso é raro — primeira interação da sessão, no máximo.)
        var self = this;
        if (ws) ws.addEventListener('open', function () {
          if (gesture) send({ type: 'begin', pos: lastTargetSec });
        }, { once: true });
      }
      emit('begin', { pos: lastTargetSec });
      return true;
    },
    beginFrac: function (frac) {
      var d = dur();
      return d > 0 ? this.beginSec(clamp(frac, 0, 1) * d) : false;
    },

    targetSec: function (sec) {
      if (!gesture) return;
      lastTargetSec = clamp(sec || 0, 0, dur() || Infinity);
      send({ type: 'target', pos: lastTargetSec });
    },
    targetFrac: function (frac) {
      var d = dur();
      if (d > 0) this.targetSec(clamp(frac, 0, 1) * d);
    },

    // Rate fixo estilo TP-7 (reverse = -1, meia velocidade = 0.5).
    rate: function (r) {
      if (!usable()) return false;
      connect();
      endSettling();               // re-grab cancela o assentamento anterior
      gesture = true;
      lastTargetSec = null;
      if (!send({ type: 'rate', rate: +r || 0 })) {
        if (ws) ws.addEventListener('open', function () {
          if (gesture) send({ type: 'rate', rate: +r || 0 });
        }, { once: true });
      }
      emit('begin', { rate: +r });
      return true;
    },

    end: function () {
      if (!gesture) return;
      gesture = false;
      if (send({ type: 'end' })) {
        // o spinback ainda soa: a barra segue os ecos até o 'ended' real
        beginSettling();
      } else {
        fallbackSeek();
      }
    },
  };
  window.RolfScrub = RolfScrub;

  /* ---------------- descoberta via status ---------------- */
  document.addEventListener('rolf:status', function (e) {
    var s = e.detail || {};
    if (typeof s.duration === 'number' && s.duration > 0) srcDur = s.duration;
    var prev = info;
    info = s.scrub || null;
    // conecta cedo para o pointerdown não pagar o handshake
    if (usable() && !ws) connect();
    if ((!prev || !prev.available) && info && info.available) emit('ready', info);
  });

  /* ---------------- config (scrub_tape_mode) ---------------- */
  fetch('api/settings')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) { if (cfg) enabled = cfg.scrub_tape_mode !== false; })
    .catch(function () {});
  // reflete o switch do Config na hora, sem exigir reload
  document.addEventListener('click', function (e) {
    var sw = e.target.closest && e.target.closest('[data-cfg-key="scrub_tape_mode"]');
    if (sw) enabled = sw.classList.contains('on');
  });

  /* ---------------- reverse segurado (botão ⏪ e tecla R) ----------------
     Como rewind de tape deck: segurar acelera por estágios (◀1× →
     ◀◀2× → ◀◀◀4×); soltar faz o spinback do momentum. A ilha de
     status (RolfIsland) mostra a velocidade ao vivo enquanto dura. */
  var REV_SPEEDS = [1, 2, 4];
  var REV_STEP_MS = 900;
  var rev = { held: false, step: 0, timer: null, btn: null };

  function revNotify() {
    if (!window.RolfIsland) return;
    var tris = '';
    for (var i = 0; i <= rev.step; i++) tris += '◀';
    // só desenhos e números: ◀◀ 2
    window.RolfIsland.notify({
      id: 'reverse', sticky: true,
      segs: [
        { text: tris, tone: 'accent' },
        { text: String(REV_SPEEDS[rev.step]), tone: 'ink' },
      ],
    });
  }

  function revStart(btn) {
    if (rev.held || !usable()) return false;
    if (!RolfScrub.rate(-REV_SPEEDS[0])) return false;
    rev.held = true;
    rev.step = 0;
    rev.btn = btn || null;
    if (rev.btn) rev.btn.classList.add('on');
    revNotify();
    rev.timer = setInterval(function () {
      if (!rev.held || rev.step >= REV_SPEEDS.length - 1) return;
      rev.step++;
      RolfScrub.rate(-REV_SPEEDS[rev.step]);
      revNotify();
    }, REV_STEP_MS);
    return true;
  }

  function revStop() {
    if (!rev.held) return;
    rev.held = false;
    if (rev.timer) { clearInterval(rev.timer); rev.timer = null; }
    if (rev.btn) { rev.btn.classList.remove('on'); rev.btn = null; }
    if (window.RolfIsland) window.RolfIsland.clear('reverse');
    RolfScrub.end();       // solta com momentum: spinback de volta a 1×
  }

  function bindReverseButtons() {
    document.querySelectorAll('[data-tp-reverse]').forEach(function (btn) {
      if (btn._revInit) return;
      btn._revInit = true;
      btn.addEventListener('pointerdown', function (e) {
        if (revStart(btn)) {
          try { btn.setPointerCapture(e.pointerId); } catch (_) {}
          e.preventDefault();
        }
      });
      btn.addEventListener('pointerup', revStop);
      btn.addEventListener('pointercancel', revStop);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindReverseButtons);
  else bindReverseButtons();

  function typing(el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'r' && e.key !== 'R') return;
    if (e.repeat || rev.held || typing(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    revStart(null);
  });
  document.addEventListener('keyup', function (e) {
    if (e.key === 'r' || e.key === 'R') revStop();
  });
})();

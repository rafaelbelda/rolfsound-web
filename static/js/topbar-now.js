/* ============================================================
   ROLFSOUND V2 — Ilha de status (dot-matrix, canto superior esquerdo)
   O display de BPM·tom virou um minidisplay inteligente: em repouso
   mostra a faixa atual (BPM em tinta, tom no acento — o two-tone do
   wordmark, SEM moldura, como sempre); quando algo importante
   acontece, a cápsula se materializa em volta dos pontos e o aviso é
   digitado NO MESMO alfabeto 5×7 — remix (pitch/tempo), velocidade
   do reverse, o que vier.

   API pública (qualquer módulo pode avisar):
     RolfIsland.notify({ id, segs:[{text, tone:'ink'|'faint'|'accent'}],
                         ttl:2200,        // ms; some sozinho
                         sticky:false })  // fica até clear(id)
     RolfIsland.clear(id)

   Prioridade: sticky (ex.: reverse segurado) ganha de flash (ttl).
   Sem aviso ativo, volta ao BPM·tom. Já vem ligado ao rolf:remix
   (flash de PITCH/TEMPO no gesto do knob do Remixer).
   ============================================================ */
(function () {
  'use strict';

  const cv = document.querySelector('.tb-nowmatrix-cv');
  if (!cv) return;
  const island = cv.closest('.tb-island');

  /* fonte 5×7 — dígitos, A–Z, minúsculas de notação (m, b),
     sustenido e símbolos de aviso (+ . : % ◀ −) */
  const GLYPHS = {
    '0': ['.111.', '1...1', '1..11', '1.1.1', '11..1', '1...1', '.111.'],
    '1': ['..1..', '.11..', '..1..', '..1..', '..1..', '..1..', '.111.'],
    '2': ['.111.', '1...1', '....1', '...1.', '..1..', '.1...', '11111'],
    '3': ['11111', '...1.', '..1..', '...1.', '....1', '1...1', '.111.'],
    '4': ['...1.', '..11.', '.1.1.', '1..1.', '11111', '...1.', '...1.'],
    '5': ['11111', '1....', '1111.', '....1', '....1', '1...1', '.111.'],
    '6': ['..11.', '.1...', '1....', '1111.', '1...1', '1...1', '.111.'],
    '7': ['11111', '....1', '...1.', '..1..', '..1..', '..1..', '..1..'],
    '8': ['.111.', '1...1', '1...1', '.111.', '1...1', '1...1', '.111.'],
    '9': ['.111.', '1...1', '1...1', '.1111', '....1', '...1.', '.11..'],
    'A': ['.111.', '1...1', '1...1', '11111', '1...1', '1...1', '1...1'],
    'B': ['1111.', '1...1', '1...1', '1111.', '1...1', '1...1', '1111.'],
    'C': ['.111.', '1...1', '1....', '1....', '1....', '1...1', '.111.'],
    'D': ['1111.', '1...1', '1...1', '1...1', '1...1', '1...1', '1111.'],
    'E': ['11111', '1....', '1....', '1111.', '1....', '1....', '11111'],
    'F': ['11111', '1....', '1....', '1111.', '1....', '1....', '1....'],
    'G': ['.111.', '1...1', '1....', '1.111', '1...1', '1...1', '.1111'],
    'H': ['1...1', '1...1', '1...1', '11111', '1...1', '1...1', '1...1'],
    'I': ['.111.', '..1..', '..1..', '..1..', '..1..', '..1..', '.111.'],
    'J': ['..111', '...1.', '...1.', '...1.', '...1.', '1..1.', '.11..'],
    'K': ['1...1', '1..1.', '1.1..', '11...', '1.1..', '1..1.', '1...1'],
    'L': ['1....', '1....', '1....', '1....', '1....', '1....', '11111'],
    'M': ['1...1', '11.11', '1.1.1', '1.1.1', '1...1', '1...1', '1...1'],
    'N': ['1...1', '11..1', '1.1.1', '1..11', '1...1', '1...1', '1...1'],
    'O': ['.111.', '1...1', '1...1', '1...1', '1...1', '1...1', '.111.'],
    'P': ['1111.', '1...1', '1...1', '1111.', '1....', '1....', '1....'],
    'Q': ['.111.', '1...1', '1...1', '1...1', '1.1.1', '1..1.', '.11.1'],
    'R': ['1111.', '1...1', '1...1', '1111.', '1.1..', '1..1.', '1...1'],
    'S': ['.1111', '1....', '1....', '.111.', '....1', '....1', '1111.'],
    'T': ['11111', '..1..', '..1..', '..1..', '..1..', '..1..', '..1..'],
    'U': ['1...1', '1...1', '1...1', '1...1', '1...1', '1...1', '.111.'],
    'V': ['1...1', '1...1', '1...1', '1...1', '1...1', '.1.1.', '..1..'],
    'W': ['1...1', '1...1', '1...1', '1.1.1', '1.1.1', '11.11', '1...1'],
    'X': ['1...1', '1...1', '.1.1.', '..1..', '.1.1.', '1...1', '1...1'],
    'Y': ['1...1', '1...1', '.1.1.', '..1..', '..1..', '..1..', '..1..'],
    'Z': ['11111', '....1', '...1.', '..1..', '.1...', '1....', '11111'],
    'm': ['.....', '.....', '11.1.', '1.1.1', '1.1.1', '1.1.1', '1.1.1'],
    '#': ['.1.1.', '.1.1.', '11111', '.1.1.', '11111', '.1.1.', '.1.1.'],
    'b': ['1....', '1....', '1.11.', '11..1', '1...1', '11..1', '1.11.'],
    '-': ['.....', '.....', '.....', '.111.', '.....', '.....', '.....'],
    '+': ['.....', '..1..', '..1..', '11111', '..1..', '..1..', '.....'],
    '.': ['.....', '.....', '.....', '.....', '.....', '.11..', '.11..'],
    ':': ['.....', '..1..', '..1..', '.....', '..1..', '..1..', '.....'],
    '%': ['11..1', '11..1', '...1.', '..1..', '.1...', '1..11', '1..11'],
    '◀': ['....1', '..111', '.1111', '11111', '.1111', '..111', '....1'],
    /* símbolos de aviso — a ilha fala por desenhos, não por palavras:
       ♪ = pitch (nota), ⏱ = tempo (metrônomo com pêndulo) */
    '♪': ['...1.', '...11', '...1.', '...1.', '...1.', '.111.', '.111.'],
    '⏱': ['..1..', '.1.1.', '.1.1.', '1.1.1', '1.1.1', '1...1', '11111'],
    ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  };
  const ROWS = 7;
  const CHAR_SP = 1;
  const GROUP_SP = 3;

  const INK   = 'rgba(232,233,238,0.92)';
  const FAINT = 'rgba(232,233,238,0.38)';

  function accentOf(el) {
    return getComputedStyle(el).getPropertyValue('--accent').trim() || '#c8693c';
  }
  function toneColor(tone) {
    if (tone === 'accent') return accentOf(cv);
    if (tone === 'faint') return FAINT;
    return INK;
  }

  /* ---------------- matriz ---------------- */

  function layout(segments) {
    const cells = [];
    segments.forEach((seg, si) => {
      if (si > 0 && cells.length) for (let i = 0; i < GROUP_SP; i++) cells.push(null);
      [...seg.text].forEach((ch, ci) => {
        const g = GLYPHS[ch] || GLYPHS[String(ch).toUpperCase()];
        if (!g) return;
        if (ci > 0) for (let i = 0; i < CHAR_SP; i++) cells.push(null);
        for (let c = 0; c < g[0].length; c++) {
          const col = [];
          for (let r = 0; r < ROWS; r++) col.push(g[r][c] === '1');
          cells.push({ col, color: seg.color });
        }
      });
    });
    return cells;
  }

  function paintSegments(segments) {
    const gap = parseFloat(cv.dataset.gap || 4);
    const r = parseFloat(cv.dataset.r || 1.1);
    const cells = layout(segments);

    const w = Math.max(1, cells.length * gap), h = ROWS * gap;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    cells.forEach((cell, c) => {
      if (!cell) return;
      ctx.fillStyle = cell.color;
      cell.col.forEach((on, row) => {
        if (!on) return;
        ctx.beginPath();
        ctx.arc((c + 0.5) * gap, (row + 0.5) * gap, r, 0, Math.PI * 2);
        ctx.fill();
      });
    });
  }

  /* ---------------- estado padrão: BPM · tom ---------------- */

  let baseBpm = 0, baseKey = null;
  let ratio = 1, semis = 0;

  const NOTE_PC = {
    'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'F': 5,
    'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11,
  };
  const PC_NOTE = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

  function parseKey(key) {
    const m = String(key || '').trim().match(/^([A-G][#b]?)\s*(maj|min)?/i);
    if (!m) return null;
    const note = m[1][0].toUpperCase() + (m[1][1] || '').toLowerCase();
    const pc = NOTE_PC[note];
    if (pc == null) return null;
    return { pc, minor: (m[2] || '').toLowerCase() === 'min' };
  }

  function defaultSegments() {
    const bpm = Math.round(baseBpm * (ratio > 0 ? ratio : 1));
    const segs = [];
    if (bpm > 0) segs.push({ text: String(bpm), color: INK });
    if (baseKey) {
      const pc = (baseKey.pc + Math.round(semis) % 12 + 120) % 12;
      segs.push({ text: PC_NOTE[pc] + (baseKey.minor ? 'm' : ''), color: accentOf(cv) });
    }
    if (!segs.length) {
      const faint = 'rgba(232,233,238,0.22)';
      segs.push({ text: '-', color: faint }, { text: '-', color: faint });
    }
    return segs;
  }

  /* ---------------- avisos (a "ilha" acorda) ----------------
     Um slot sticky (dura até clear) e um slot flash (ttl). O sticky
     ganha: segurando reverse, um flash de remix não rouba o display. */

  let sticky = null;    // { id, segs }
  let flash = null;     // { id, segs }
  let flashTimer = null;

  function activeNotice() { return sticky || flash; }

  function plainText(segs) {
    return segs.map((s) => s.text).join(' ');
  }

  function repaint(swap) {
    const notice = activeNotice();
    if (island) {
      island.classList.toggle('is-live', !!notice);
      if (swap && !document.body.classList.contains('reduce-motion')) {
        island.classList.remove('is-swap');
        void island.offsetWidth;              // reinicia a animação
        island.classList.add('is-swap');
      }
      island.title = notice
        ? plainText(notice.segs)
        : 'BPM · Tom da faixa atual';
    }
    if (notice) {
      paintSegments(notice.segs.map((s) => ({ text: s.text, color: toneColor(s.tone) })));
    } else {
      paintSegments(defaultSegments());
    }
  }

  const RolfIsland = {
    notify(opts) {
      if (!opts || !Array.isArray(opts.segs) || !opts.segs.length) return;
      const notice = { id: opts.id || 'anon', segs: opts.segs };
      if (opts.sticky) {
        sticky = notice;
      } else {
        flash = notice;
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(() => {
          flashTimer = null;
          flash = null;
          repaint(true);
        }, Math.max(600, +opts.ttl || 2200));
      }
      repaint(true);
    },
    clear(id) {
      let changed = false;
      if (sticky && (!id || sticky.id === id)) { sticky = null; changed = true; }
      if (flash && (!id || flash.id === id)) {
        flash = null; changed = true;
        if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
      }
      if (changed) repaint(true);
    },
  };
  window.RolfIsland = RolfIsland;

  /* ---------------- fontes de dados ---------------- */

  document.addEventListener('rolf:track', (e) => {
    const d = e.detail || {};
    baseBpm = Math.round(+d.bpm) || 0;
    baseKey = parseKey(d.key);
    repaint(false);
  });

  // Remixer ao vivo: o BPM/tom do repouso morfam SEMPRE; além disso, a
  // mudança vira um flash explícito ("PITCH +2" / "TEMPO 1.12X") — mas
  // não no sync inicial do boot, que só reflete o estado salvo do core.
  const bootAt = Date.now();
  document.addEventListener('rolf:remix', (e) => {
    const d = e.detail || {};
    const r = +d.ratio > 0 ? +d.ratio : 1;
    const s = Math.round(+d.semis || 0);
    if (r === ratio && s === semis) return;
    const pitchChanged = s !== semis;
    const tempoChanged = Math.abs(r - ratio) > 0.001;
    ratio = r; semis = s;

    if (Date.now() - bootAt > 3000) {
      // só desenhos e números: ♪ +2 · ⏱ 1.12
      const segs = [];
      if (pitchChanged) {
        segs.push({ text: '♪', tone: 'faint' });
        segs.push({ text: (s > 0 ? '+' : '') + s, tone: 'accent' });
      }
      if (tempoChanged) {
        segs.push({ text: '⏱', tone: 'faint' });
        segs.push({ text: r.toFixed(2), tone: 'accent' });
      }
      if (segs.length) RolfIsland.notify({ id: 'remix', segs, ttl: 2200 });
    }
    repaint(false);
  });

  window.addEventListener('resize', () => repaint(false));
  repaint(false);
})();

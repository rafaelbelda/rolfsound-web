/* ============================================================
   ROLFSOUND V2 — Topbar now-playing matrix
   No canto superior esquerdo (onde vivia a logo), o BPM e o tom
   da faixa atual em fonte dot-matrix 5×7 — só os pontos acesos,
   sem moldura: BPM em tinta, tom na cor de acento (o mesmo
   two-tone do wordmark). Reage ao rolf:track de prototype.js —
   cobre clique, fila e a reconciliação do core via playback.js.
   ============================================================ */
(function () {
  'use strict';

  const cv = document.querySelector('.tb-nowmatrix-cv');
  if (!cv) return;

  /* fonte 5×7 — só o que BPM + tom precisam: dígitos, A–G,
     sustenido, bemol (b minúsculo), m de menor e travessão */
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
    'm': ['.....', '.....', '11.1.', '1.1.1', '1.1.1', '1.1.1', '1.1.1'],
    '#': ['.1.1.', '.1.1.', '11111', '.1.1.', '11111', '.1.1.', '.1.1.'],
    'b': ['1....', '1....', '1.11.', '11..1', '1...1', '11..1', '1.11.'],
    '-': ['.....', '.....', '.....', '.111.', '.....', '.....', '.....'],
  };
  const ROWS = 7;       // altura da fonte, em pontos
  const CHAR_SP = 1;    // coluna vazia entre caracteres
  const GROUP_SP = 3;   // respiro entre o BPM e o tom

  // faixa base (rolf:track) + remix ao vivo (rolf:remix, do Remixer)
  let baseBpm = 0, baseKey = null;
  let ratio = 1, semis = 0;
  let bpmText = '', keyText = '';

  // pitch-class p/ transpor o tom junto com o knob Pitch; nomes de
  // exibição iguais aos do banco (keys.py: Eb/Ab/Bb, C#/F#)
  const NOTE_PC = {
    'C': 0, 'C#': 1, 'Db': 1, 'D': 2, 'D#': 3, 'Eb': 3, 'E': 4, 'F': 5,
    'F#': 6, 'Gb': 6, 'G': 7, 'G#': 8, 'Ab': 8, 'A': 9, 'A#': 10, 'Bb': 10, 'B': 11,
  };
  const PC_NOTE = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

  // "A min" -> { pc, minor } · aceita "C# maj", "Eb min"…
  function parseKey(key) {
    const m = String(key || '').trim().match(/^([A-G][#b]?)\s*(maj|min)?/i);
    if (!m) return null;
    const note = m[1][0].toUpperCase() + (m[1][1] || '').toLowerCase();
    const pc = NOTE_PC[note];
    if (pc == null) return null;
    return { pc, minor: (m[2] || '').toLowerCase() === 'min' };
  }

  function accentOf(el) {
    return getComputedStyle(el).getPropertyValue('--accent').trim() || '#c8693c';
  }

  // [{ text, color }] -> colunas da matriz; null = coluna de respiro
  function layout(segments) {
    const cells = [];
    segments.forEach((seg, si) => {
      if (si > 0 && cells.length) for (let i = 0; i < GROUP_SP; i++) cells.push(null);
      [...seg.text].forEach((ch, ci) => {
        const g = GLYPHS[ch];
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

  function paint() {
    const gap = parseFloat(cv.dataset.gap || 4);
    const r = parseFloat(cv.dataset.r || 1.1);

    // two-tone do wordmark: BPM em tinta, tom no acento da capa;
    // sem faixa, um "- -" quase apagado segura o lugar
    let segments;
    if (bpmText || keyText) {
      segments = [];
      if (bpmText) segments.push({ text: bpmText, color: 'rgba(232,233,238,0.92)' });
      if (keyText) segments.push({ text: keyText, color: accentOf(cv) });
    } else {
      const faint = 'rgba(232,233,238,0.22)';
      segments = [{ text: '-', color: faint }, { text: '-', color: faint }];
    }
    const cells = layout(segments);

    const w = cells.length * gap, h = ROWS * gap;
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

  // aplica ratio/semitons do Remixer sobre a faixa base e repinta
  function render() {
    const bpm = Math.round(baseBpm * (ratio > 0 ? ratio : 1));
    bpmText = bpm > 0 ? String(bpm) : '';
    if (baseKey) {
      const pc = (baseKey.pc + Math.round(semis) % 12 + 120) % 12;
      keyText = PC_NOTE[pc] + (baseKey.minor ? 'm' : '');
    } else {
      keyText = '';
    }
    paint();
  }

  // showTrack (prototype.js) dispara em todo caminho de troca de faixa,
  // já com o --accent da capa aplicado — só ler e repintar
  document.addEventListener('rolf:track', (e) => {
    const d = e.detail || {};
    baseBpm = Math.round(+d.bpm) || 0;
    baseKey = parseKey(d.key);
    render();
  });

  // Remixer ao vivo (remixer-live.js emite no gesto do knob e no sync
  // do core) — tempo muda o BPM exibido, pitch transpõe o tom
  document.addEventListener('rolf:remix', (e) => {
    const d = e.detail || {};
    const r = +d.ratio > 0 ? +d.ratio : 1;
    const s = Math.round(+d.semis || 0);
    if (r === ratio && s === semis) return;
    ratio = r; semis = s;
    render();
  });

  window.addEventListener('resize', paint);
  paint();
})();

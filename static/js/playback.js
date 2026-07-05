/* ============================================================
   ROLFSOUND V2 — PLAYBACK BRIDGE (o único dono do playback)
   O áudio toca NO CORE (rolfsound-core, hardware) — o navegador
   nunca decodifica nem reproduz nada. Este módulo:

     · envia ações → /api/play /pause /skip /seek /volume /queue/*
     · sonda /api/status (adaptativo: 1.5s tocando / 3s parado)
     · dead-reckoning: interpola a posição entre polls usando
       position + position_updated_at (compensa o lag de rede)
     · atualizações otimistas com "guard window": a UI responde
       no clique e o poll seguinte só corrige se o servidor divergir

   Contratos consumidos (expostos por prototype.js / render.js):
     window.RolfShowTrack(d)      — aplica visuais da faixa
     window.RolfSetPlaying(bool)  — ícones play/pause + body.paused
     window.RolfSetDuration(sec)  — readouts de duração
     window.RolfSetVol(frac)      — visual do volume
     window.RolfTrackData(row)    — extrai dados de uma .row
     window.RolfQueueRowHtml(...) — markup de uma linha da fila

   Expõe window.RolfPlayback (ações) e emite 'rolf:status'.
   ============================================================ */
(function () {
  'use strict';

  const Player = window.RolfPlayer = window.RolfPlayer || {};
  // O bridge é dono da posição: prototype-motion.js não avança o
  // playhead fake quando engineDriven está ligado.
  Player.engineDriven = true;

  const S = {
    playState: 'idle',          // 'idle' | 'playing' | 'paused'
    currentId: null,
    duration: 0,                // segundos (tempo da FONTE, sem remix)
    sliderPos: 0,               // segundos (âncora, tempo da fonte)
    sliderAnchorMs: 0,          // 0 = congelado
    guardUntilMs: 0,            // janela pós-ação: poll não sobrescreve
    tempoRatio: 1,              // remix: 1 = tempo original
    queue: [],                  // fila completa do core
    currentQueueIdx: -1,
    shuffle: false,
    repeat: 'off',
    volume: null,
  };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const mmss = (sec) => {
    sec = Math.max(0, Math.floor(sec || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };

  /* ---------------- HTTP ---------------- */
  async function api(path, body) {
    const res = await fetch(path, body !== undefined ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    } : { method: 'POST' });
    if (!res.ok) throw new Error(path + ' -> HTTP ' + res.status);
    return res.json().catch(() => ({}));
  }

  /* ---------------- dead reckoning ----------------
     Posição interna sempre em TEMPO DA FONTE. Com remix ativo o áudio
     percorre a fonte a tempoRatio segundos por segundo de relógio. */
  function deadReckon() {
    if (!S.sliderAnchorMs || !S.duration) return S.sliderPos;
    return Math.min(S.sliderPos + (Date.now() - S.sliderAnchorMs) / 1000 * S.tempoRatio, S.duration);
  }

  // Troca o ratio re-ancorando primeiro: o tempo já decorrido foi
  // percorrido no ratio ANTIGO — sem isso o playhead saltaria.
  function setTempoRatio(r) {
    r = Math.max(0.5, Math.min(2, +r || 1));
    if (Math.abs(r - S.tempoRatio) < 0.001) return;
    S.sliderPos = deadReckon();
    if (S.sliderAnchorMs) S.sliderAnchorMs = Date.now();
    S.tempoRatio = r;
    lastSecond = -1;                     // força re-render do decorrido
    // total exibido "morfa" junto (a faixa ficou mais longa/curta)
    if (S.duration > 0 && window.RolfSetDuration) window.RolfSetDuration(S.duration / r);
  }

  /* ---------------- polling ---------------- */
  let pollId = null;
  let pollInterval = 3000;
  let fastPollId = null;

  function startPolling() {
    stopPolling();
    pollId = setInterval(pollStatus, pollInterval);
  }
  function stopPolling() {
    if (pollId) { clearInterval(pollId); pollId = null; }
  }
  // poll extra logo após uma ação — o estado real chega rápido sem
  // esperar o intervalo cheio (percepção de zero delay)
  function schedulePoll(ms) {
    if (fastPollId) clearTimeout(fastPollId);
    fastPollId = setTimeout(() => { fastPollId = null; pollStatus(); }, ms);
  }

  async function pollStatus() {
    if (document.hidden) return;
    let status;
    try {
      const res = await fetch('/api/status');
      if (!res.ok) return;             // core offline → mantém último estado
      status = await res.json();
    } catch (_) { return; }

    applyServerStatus(status);

    const ideal = (status.state === 'playing') ? 1500 : 3000;
    if (ideal !== pollInterval) { pollInterval = ideal; startPolling(); }
  }

  /* ---------------- aplicar estado do servidor ---------------- */
  let lastTrackKey = null;
  let lastQueueSig = null;
  let lastVolActionMs = 0;
  let lastRemixActionMs = 0;

  function applyServerStatus(status) {
    const guarded = Date.now() < S.guardUntilMs;

    // remix do servidor (ignora por 2s após gesto local no knob)
    const serverRatio = (status.remix && +status.remix.tempo_ratio) || 1;
    if (Date.now() - lastRemixActionMs > 2000) setTempoRatio(serverRatio);

    const newState = status.state || 'idle';
    const prevState = S.playState;
    const prevId = S.currentId;
    const nextId = status.track_id || null;
    const trackChanged = nextId !== prevId;

    if (!guarded) {
      const wasPlaying = prevState === 'playing';
      const nowPlaying = newState === 'playing';

      // Compensa o lag entre a medição no core e a chegada aqui.
      // O lag é relógio de parede; a posição anda em tempo da fonte,
      // então escala pelo ratio vigente no servidor.
      const measuredAt = status.position_updated_at || 0;
      const lag = (measuredAt > 0 && nowPlaying)
        ? Math.max(0, Date.now() / 1000 - measuredAt) * serverRatio : 0;
      const serverPos = Math.min((status.position || 0) + lag, status.duration || Infinity);

      if (prevState === 'idle' && !wasPlaying && !nowPlaying) {
        S.sliderPos = status.position || 0;
        S.sliderAnchorMs = 0;
      } else if (!wasPlaying && nowPlaying) {
        S.sliderPos = serverPos;
        S.sliderAnchorMs = Date.now();
      } else if (wasPlaying && !nowPlaying) {
        S.sliderPos = deadReckon();
        S.sliderAnchorMs = 0;
      } else if (wasPlaying && nowPlaying && trackChanged) {
        S.sliderPos = serverPos;
        S.sliderAnchorMs = Date.now();
      } else if (wasPlaying && nowPlaying) {
        // mesma faixa tocando: re-ancora suavemente se derivou > 1.5s
        if (Math.abs(deadReckon() - serverPos) > 1.5) {
          S.sliderPos = serverPos;
          S.sliderAnchorMs = Date.now();
        }
      }

      S.playState = newState;
      S.currentId = nextId;
      if (status.duration > 0) S.duration = status.duration;
      else if (newState === 'idle') S.duration = 0;

      if (window.RolfSetPlaying) window.RolfSetPlaying(newState === 'playing');
    }

    S.queue = status.queue || [];
    S.currentQueueIdx = status.queue_current_index ?? -1;

    if (typeof status.shuffle !== 'undefined') S.shuffle = !!status.shuffle;
    if (typeof status.repeat_mode !== 'undefined') S.repeat = status.repeat_mode || 'off';

    // metadados: só aceita do servidor fora do guard OU quando ele já
    // convergiu para a mesma faixa (evita flash da faixa anterior)
    const serverMatches = !guarded || nextId === S.currentId;
    if (serverMatches && S.currentId) {
      const key = S.currentId + '|' + (status.title || '');
      if (key !== lastTrackKey) {
        lastTrackKey = key;
        const d = trackView(status);
        if (window.RolfShowTrack) window.RolfShowTrack(d);
      }
      if (status.duration > 0 && window.RolfSetDuration) window.RolfSetDuration(status.duration / S.tempoRatio);
    } else if (!S.currentId && !guarded && lastTrackKey !== null) {
      lastTrackKey = null;        // voltou a idle sem faixa
    }

    renderQueue();
    paintModes();

    // volume do servidor (ignora por 2s após ajuste local)
    if (typeof status.volume === 'number' && Date.now() - lastVolActionMs > 2000) {
      if (S.volume === null || Math.abs(status.volume - S.volume) > 0.02) {
        S.volume = status.volume;
        if (window.RolfSetVol) window.RolfSetVol(status.volume);
      }
    }

    document.dispatchEvent(new CustomEvent('rolf:status', { detail: status }));
  }

  // faixa do RolfsoundData pelo id — fallback p/ quem não tem row no
  // Acervo (a variação Stem Ready vive só na gaveta de versões)
  function dataTrack(id) {
    return id ? ((window.RolfsoundData || {}).tracks || []).find((t) => t.id === id) : null;
  }

  // monta a visão de faixa p/ os visuais: prefere a row do Acervo
  // (tem capa/gradiente, BPM, tom, duração), depois RolfsoundData,
  // senão dados do status
  function trackView(status) {
    const id = status.track_id || '';
    const esc = window.CSS && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"');
    const row = id ? $(`.screen[data-screen="acervo"] .row[data-id="${esc}"]`) : null;
    if (row && window.RolfTrackData) {
      const d = window.RolfTrackData(row);
      if (!(+d.dur > 0) && status.duration > 0) d.dur = status.duration;
      return d;
    }
    const t = dataTrack(id);
    if (t) {
      return {
        id, title: t.title || 'Faixa', artist: t.artist || '', bg: t.cover || '',
        bpm: t.bpm || '', key: t.key || '',
        dur: (+t.dur > 0) ? t.dur : (status.duration || 0),
      };
    }
    return {
      id,
      title: status.title || 'Faixa',
      artist: status.artist || '',
      bg: status.thumbnail ? `url("${status.thumbnail}") center/cover no-repeat, #141416` : '',
      bpm: '', key: '',
      dur: status.duration || 0,
    };
  }

  function enrichQueueItem(t) {
    const id = t.track_id || '';
    const esc = window.CSS && CSS.escape ? CSS.escape(id) : id.replace(/"/g, '\\"');
    const row = id ? $(`.screen[data-screen="acervo"] .row[data-id="${esc}"]`) : null;
    if (row && window.RolfTrackData) {
      const d = window.RolfTrackData(row);
      return { id, cover: d.bg, title: d.title, artist: d.artist, bpm: d.bpm, key: d.key, dur: d.dur };
    }
    const dt = dataTrack(id);
    if (dt) {
      return { id, cover: dt.cover || '', title: dt.title || 'Faixa', artist: dt.artist || '', bpm: dt.bpm || '', key: dt.key || '', dur: dt.dur || 0 };
    }
    return {
      id,
      cover: t.thumbnail ? `url("${t.thumbnail}") center/cover no-repeat, #141416` : '',
      title: t.title || 'Faixa',
      artist: t.artist || '',
      bpm: '', key: '', dur: 0,
    };
  }

  /* ---------------- fila ("A seguir" = após o índice atual) ---------------- */
  function renderQueue() {
    const list = $('[data-queue-list]');
    if (!list || !window.RolfQueueRowHtml) return;
    // não re-renderizar no meio de um arraste (mataria o drag em curso)
    if (list.querySelector('.tpq-row.dragging')) return;

    const start = S.currentQueueIdx + 1;
    const upcoming = S.queue.slice(start);
    const sig = start + '|' + upcoming.map((t) => t.track_id).join(',');
    if (sig === lastQueueSig) return;
    lastQueueSig = sig;

    list.innerHTML = upcoming
      .map((t, i) => window.RolfQueueRowHtml(enrichQueueItem(t), i, start + i))
      .join('');
    const count = $('[data-queue-count]');
    if (count) count.textContent = upcoming.length;
  }

  function paintModes() {
    $$('.tp-btn[aria-label="Shuffle"]').forEach((b) => b.classList.toggle('on', S.shuffle));
    const dockSh = $('[data-queue-shuffle]');
    if (dockSh) dockSh.classList.toggle('is-on', S.shuffle);
    $$('.tp-btn[aria-label="Repeat"]').forEach((b) => {
      b.classList.toggle('on', S.repeat !== 'off');
      b.classList.toggle('repeat-one', S.repeat === 'one');
      b.title = S.repeat === 'off' ? 'Repetir' : (S.repeat === 'one' ? 'Repetir: faixa' : 'Repetir: fila');
    });
  }

  /* ---------------- RAF: posição → DOM ---------------- */
  let lastPct = -1;
  let lastSecond = -1;
  function tick() {
    if (S.duration > 0) {
      const pos = deadReckon();
      // A fração da barra vive em tempo da fonte (invariante ao remix);
      // os timecodes exibidos "morfam": ÷ tempoRatio = relógio de parede.
      const frac = clamp01(pos / S.duration);
      Player.pos = frac;
      Player.dur = S.duration / S.tempoRatio;

      const pct = Math.round(frac * 2000) / 20;    // passo 0.05%
      if (pct !== lastPct) {
        lastPct = pct;
        $$('.tp-fill').forEach((f) => { f.style.width = pct + '%'; });
      }
      const sec = Math.floor(pos / S.tempoRatio);
      if (sec !== lastSecond) {
        lastSecond = sec;
        const t0 = $('.transport .tp-time-l');
        if (t0) t0.textContent = mmss(sec);
        const ve = $('[data-viz-elapsed]');
        if (ve) ve.textContent = mmss(sec);
      }
    }
    requestAnimationFrame(tick);
  }

  /* ---------------- debounces ---------------- */
  let seekTimer = null;
  let volTimer = null;

  /* ---------------- ações (todas otimistas) ---------------- */
  const RolfPlayback = {
    get state() { return S; },
    position() { return deadReckon(); },

    // toca uma faixa do acervo pelo id (visuais já aplicados pelo chamador)
    async playTrack(id, durSec) {
      S.guardUntilMs = Date.now() + 3000;
      S.currentId = id;
      S.playState = 'playing';
      S.sliderPos = 0;
      S.sliderAnchorMs = Date.now();
      if (+durSec > 0) S.duration = +durSec;
      lastTrackKey = id + '|*optimistic*';
      if (window.RolfSetPlaying) window.RolfSetPlaying(true);
      try {
        const res = await api('/api/play', { track_id: id });
        // variação Stem Ready que caiu no master (<2 stems no disco)
        const t = dataTrack(id);
        if (t && t.stems_of && res && res.stems === false) {
          document.dispatchEvent(new CustomEvent('rolf:toast', {
            detail: { text: 'Stems indisponíveis — tocando o master', kicker: 'Stems' },
          }));
        }
        schedulePoll(300);
      } catch (e) { console.error('play failed:', e); schedulePoll(600); }
    },

    // toca uma posição absoluta da fila
    async playQueueIndex(absIdx) {
      const t = S.queue[absIdx];
      S.guardUntilMs = Date.now() + 3000;
      if (t) {
        const d = enrichQueueItem(t);
        S.currentId = t.track_id || null;
        lastTrackKey = (t.track_id || '') + '|*optimistic*';
        if (window.RolfShowTrack) window.RolfShowTrack({ id: d.id, title: d.title, artist: d.artist, bg: d.cover, bpm: d.bpm, key: d.key, dur: d.dur });
      }
      S.playState = 'playing';
      S.sliderPos = 0;
      S.sliderAnchorMs = Date.now();
      if (window.RolfSetPlaying) window.RolfSetPlaying(true);
      try {
        await api('/api/play', { index: absIdx });
        schedulePoll(300);
      } catch (e) { console.error('play index failed:', e); schedulePoll(600); }
    },

    async toggle() {
      S.guardUntilMs = Date.now() + 3000;
      if (S.playState === 'playing') {
        S.sliderPos = deadReckon();
        S.sliderAnchorMs = 0;
        S.playState = 'paused';
        if (window.RolfSetPlaying) window.RolfSetPlaying(false);
        try { await api('/api/pause'); }
        catch (e) { console.error('pause failed:', e); }
      } else if (S.playState === 'paused') {
        // /api/pause é toggle no core: retoma sem recomeçar a faixa.
        // NUNCA usar /api/play aqui — reiniciaria do zero.
        S.playState = 'playing';
        if (window.RolfSetPlaying) window.RolfSetPlaying(true);
        try {
          await api('/api/pause');
          S.sliderAnchorMs = Date.now();     // ancora só após confirmação
        } catch (e) {
          S.playState = 'paused';
          if (window.RolfSetPlaying) window.RolfSetPlaying(false);
          console.error('resume failed:', e);
        }
      } else {
        // idle: toca a fila atual; sem fila, retoca a última faixa
        // conhecida (play após fim natural = replay, convenção de player)
        const body = (!S.queue.length && S.currentId) ? { track_id: S.currentId } : {};
        S.playState = 'playing';
        S.sliderPos = 0;
        if (window.RolfSetPlaying) window.RolfSetPlaying(true);
        try {
          await api('/api/play', body);
          S.sliderAnchorMs = Date.now();
        } catch (e) {
          S.playState = 'idle';
          if (window.RolfSetPlaying) window.RolfSetPlaying(false);
        }
      }
      schedulePoll(600);
    },

    async next() {
      S.guardUntilMs = Date.now() + 3000;
      const nx = S.queue[S.currentQueueIdx + 1];
      if (nx) {                    // otimista: mostra a próxima já
        const d = enrichQueueItem(nx);
        S.currentId = nx.track_id || null;
        lastTrackKey = (nx.track_id || '') + '|*optimistic*';
        S.sliderPos = 0; S.sliderAnchorMs = Date.now();
        if (window.RolfShowTrack) window.RolfShowTrack({ id: d.id, title: d.title, artist: d.artist, bg: d.cover, bpm: d.bpm, key: d.key, dur: d.dur });
        if (window.RolfSetPlaying) window.RolfSetPlaying(true);
      }
      try { await api('/api/skip'); schedulePoll(250); }
      catch (e) { console.error('skip failed:', e); schedulePoll(600); }
    },

    async prev() {
      S.guardUntilMs = Date.now() + 3000;
      const prevIdx = S.currentQueueIdx - 1;
      // padrão de players: >3s reinicia a faixa; senão volta uma
      if (deadReckon() > 3 || prevIdx < 0) {
        S.sliderPos = 0;
        S.sliderAnchorMs = S.playState === 'playing' ? Date.now() : 0;
        try { await api('/api/seek', { position: 0 }); schedulePoll(250); }
        catch (e) { console.error('seek 0 failed:', e); }
      } else {
        const pv = S.queue[prevIdx];
        if (pv) {
          const d = enrichQueueItem(pv);
          S.currentId = pv.track_id || null;
          lastTrackKey = (pv.track_id || '') + '|*optimistic*';
          S.sliderPos = 0; S.sliderAnchorMs = Date.now();
          if (window.RolfShowTrack) window.RolfShowTrack({ id: d.id, title: d.title, artist: d.artist, bg: d.cover, bpm: d.bpm, key: d.key, dur: d.dur });
        }
        try { await api('/api/queue/previous'); schedulePoll(250); }
        catch (e) { console.error('previous failed:', e); }
      }
    },

    // seek por fração (0..1) — visual imediato, POST com debounce
    seekFrac(frac) {
      if (!S.duration) return;
      this.seekSec(clamp01(frac) * S.duration);
    },
    seekSec(position) {
      if (!S.duration) return;
      position = Math.max(0, Math.min(position, S.duration));
      S.sliderPos = position;
      S.sliderAnchorMs = S.playState === 'playing' ? Date.now() : 0;
      S.guardUntilMs = Date.now() + 1200;
      lastSecond = -1;                     // força re-render do tempo
      if (seekTimer) clearTimeout(seekTimer);
      seekTimer = setTimeout(async () => {
        seekTimer = null;
        try { await api('/api/seek', { position }); schedulePoll(400); }
        catch (e) { console.error('seek failed:', e); }
      }, 140);
    },

    setVolume(frac) {
      frac = clamp01(frac);
      S.volume = frac;
      lastVolActionMs = Date.now();
      if (volTimer) clearTimeout(volTimer);
      volTimer = setTimeout(async () => {
        volTimer = null;
        try { await api('/api/volume', { volume: frac }); }
        catch (e) { console.error('volume failed:', e); }
      }, 120);
    },

    async queueAdd(id, position) {
      const body = { track_id: id };
      if (position != null) body.position = position;
      try { await api('/api/queue/add', body); schedulePoll(300); }
      catch (e) { console.error('queue add failed:', e); }
    },
    async queueRemove(absIdx) {
      lastQueueSig = null;                 // força re-render no próximo poll
      try { await api('/api/queue/remove', { position: absIdx }); schedulePoll(300); }
      catch (e) { console.error('queue remove failed:', e); }
    },
    async queueClear() {
      lastQueueSig = null;
      try { await api('/api/queue/clear'); schedulePoll(300); }
      catch (e) { console.error('queue clear failed:', e); }
    },
    async queueMove(fromAbs, toAbs) {
      lastQueueSig = null;
      try { await api('/api/queue/move', { from_pos: fromAbs, to_pos: toAbs }); schedulePoll(300); }
      catch (e) { console.error('queue move failed:', e); }
    },
    // carrega uma lista inteira na fila do core e toca do início
    // (Tocar/Embaralhar de uma playlist). adds sequenciais preservam a ordem.
    async playList(ids) {
      ids = (ids || []).filter(Boolean);
      if (!ids.length) return;
      S.guardUntilMs = Date.now() + 3000;
      lastQueueSig = null;
      try {
        await api('/api/queue/clear');
        for (const id of ids) await api('/api/queue/add', { track_id: id });
        await api('/api/play', { index: 0 });
        schedulePoll(300);
      } catch (e) { console.error('play list failed:', e); schedulePoll(600); }
    },
    async toggleShuffle() {
      S.shuffle = !S.shuffle;
      paintModes();
      try { await api('/api/queue/shuffle', { enabled: S.shuffle }); schedulePoll(400); }
      catch (e) { S.shuffle = !S.shuffle; paintModes(); console.error('shuffle failed:', e); }
    },
    async cycleRepeat() {
      const order = { off: 'all', all: 'one', one: 'off' };
      S.repeat = order[S.repeat] || 'off';
      paintModes();
      try { await api('/api/queue/repeat', { mode: S.repeat }); schedulePoll(400); }
      catch (e) { console.error('repeat failed:', e); }
    },

    // remix roda no core — knobs do Remixer chamam isto.
    // O ratio local muda já (timecodes morfam no gesto); o poll só
    // corrige depois da janela de 2s se o servidor divergir.
    remixSet(params) {
      if (params && typeof params.tempo_ratio === 'number') {
        lastRemixActionMs = Date.now();
        setTempoRatio(params.tempo_ratio);
      }
      return api('/api/remix', params).catch((e) => console.error('remix failed:', e));
    },
    remixReset() {
      lastRemixActionMs = Date.now();
      setTempoRatio(1);
      return api('/api/remix/reset').catch((e) => console.error('remix reset failed:', e));
    },
    // mudo/solo/fader das lanes de stems → StemMixer do core (ao vivo)
    stemsMix(payload) {
      return api('/api/remix/stems', payload).catch((e) => console.error('stems mix failed:', e));
    },
  };

  window.RolfPlayback = RolfPlayback;

  /* ---------------- ligar botões do transporte ---------------- */
  function bind() {
    // play/pause (transporte, viz e quaisquer espelhos)
    $$('.tp-play, .st-play, .rl-play').forEach((b) => {
      const clone = b.cloneNode(true);      // derruba handlers locais antigos
      b.replaceWith(clone);
      clone.addEventListener('click', () => RolfPlayback.toggle());
    });
    $$('.tp-btn[aria-label="Próxima"]').forEach((b) => {
      const clone = b.cloneNode(true);
      b.replaceWith(clone);
      clone.addEventListener('click', () => RolfPlayback.next());
    });
    $$('.tp-btn[aria-label="Anterior"]').forEach((b) => {
      const clone = b.cloneNode(true);
      b.replaceWith(clone);
      clone.addEventListener('click', () => RolfPlayback.prev());
    });
    $$('.tp-btn[aria-label="Shuffle"]').forEach((b) => {
      const clone = b.cloneNode(true);
      b.replaceWith(clone);
      clone.addEventListener('click', () => RolfPlayback.toggleShuffle());
    });
    $$('.tp-btn[aria-label="Repeat"]').forEach((b) => {
      const clone = b.cloneNode(true);
      b.replaceWith(clone);
      clone.addEventListener('click', () => RolfPlayback.cycleRepeat());
    });
  }

  function init() {
    bind();
    requestAnimationFrame(tick);
    pollStatus();                          // sincroniza já no boot
    startPolling();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) pollStatus();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

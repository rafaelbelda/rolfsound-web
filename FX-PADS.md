# FX + PADS — Remixer etapa 5 (parte 2)

Plano executável dos dois repos (`rolfsound` = core, `rolfsound-web` = web).
Fecha o item "Filtro / EQ / Loop / Saída" do [TO-DO-LIST.md](TO-DO-LIST.md).
Como o STEMS.md, este arquivo morre quando tudo estiver entregue.

Decisões fechadas com o usuário (2026-07-06):

* O módulo **Loop vira um pad de samples** (6 slots): apertar um pad vazio
  abre a seleção de trecho na waveform (arrastar, com ajuste por compasso);
  apertar um pad gravado **substitui a faixa** pelo trecho em loop (toggle
  liga/desliga); ao desligar, a música volta **de onde ela estaria** (slip —
  a timeline continua correndo durante o pad).
* Pads **persistem por faixa** no `library.db` da web (in/out em segundos).
* "Ress" do Filtro fica fixo (Q agradável) nesta fase.

## Parte A — Filtro / EQ / Saída (efeito real no core)

### Core

1. **`services/fx_engine.py`** — novo, gêmeo do `RemixEngine` (grafo PyAV,
   params imutáveis + rebuild sob demanda, identity fast-path, passthrough
   em erro). Estágio SEPARADO do remix de propósito: arrastar o cutoff
   reconstrói só os biquads do FX sem derrubar o estado do `atempo`
   (rebuild do grafo do remix no meio da música = soluço audível).
   * Params: `filter_mode` ('lp'|'hp'), `filter_cutoff_hz` (20–20000, log),
     `eq_low_db` / `eq_mid_db` / `eq_high_db` (−12..+12).
   * Identidade: EQ tudo 0 **e** filtro neutro (lp ≥ 19500 Hz ou hp ≤ 25 Hz).
   * Grafo: filtro `lowpass`/`highpass` (Q fixo 0.707) → `bass` (shelf
     ~120 Hz) → `equalizer` (peaking 1 kHz, Q 1) → `treble` (shelf ~3 kHz).
2. **`playback_service.py`** — `self._fx = FxEngine(...)`; no `_pump_loop`,
   `chunk = self._fx.process(chunk)` logo após `self._remix.process(chunk)`.
   `set_fx(**partial)` / `reset_fx()` espelham `set_remix` (state +
   `Fx.CHANGED`). FX **não** reseta na troca de faixa (é "mesa", não
   transformação da faixa — igual volume).
   * **Mute**: flag própria (`set_mute(bool)`) aplicada no callback
     (`outdata[:] = 0` depois do read — posição continua andando). Não
     mexe no volume para não perder a posição do fader.
   * **Medidor**: no callback, pico L/R por bloco via scratch pré-alocado
     (`np.abs(outdata, out=...)` — zero alloc, sem lock, floats no self).
3. **`core/system_state.py`** — `FxState` + `update_fx`; `muted` no
   `PlaybackState`. **`core/events.py`** — `Fx.CHANGED = "fx_changed"`.
4. **`engine.py`** — comandos `set_fx` / `reset_fx` / `mute` (enqueue-only)
   + `output_levels()` lendo os floats do PlaybackService.
5. **`api_service.py`** — POST `/fx`, `/fx/reset`, `/mute` (parciais, como
   `/remix`); `fx` e `playback.muted` no `/status`; `Fx.CHANGED` no event
   log (SSE); GET `/levels` → `{l, r}` (barato, pro medidor).

### Web

6. **`utils/core_client.py`** — `fx_set(**partial)`, `fx_reset()`,
   `set_mute(enabled)`, `get_levels()`.
7. **`api/routes/playback.py`** — POST `/api/fx`, `/api/fx/reset`,
   `/api/mute`; GET `/api/levels`. `fx`/`muted` passam no `/api/status`
   de graça (o raw do core atravessa o `_enrich_status`).
8. **`static/js/playback.js`** — `RolfPlayback.fxSet/fxReset/setMute`.
9. **`static/js/remixer-live.js`** —
   * Filtro: knob emite `rolfknob` (prototype.js é o dono do drag);
     frac→cutoff em escala log; toggle do mod alterna LP/HP; readout kHz.
   * EQ: mesmo visual de hoje + POST debounced (60 ms) com os 3 dBs;
     "Flat" zera. Sync multi-cliente via `rolf:status` (janela de 2.5 s
     pós-gesto local, igual pitch/tempo). Reset do deck inclui FX.
   * Saída: "Mute" real (`setMute`), estado vem do status; medidor anima
     com GET `/api/levels` a ~120 ms **só** com a tela Remixer visível e
     tocando (decay no cliente).

## Parte B — Pads de loop (sample pad)

### Core

10. **`services/pad_sampler.py`** — 6 slots; cada slot guarda o trecho como
    PCM float32 em RAM (decodificado do arquivo da faixa com PyAV +
    resample pro formato do device — trecho ≤ 8 compassos = rápido, roda
    fora da thread de áudio). `set_pad(i, filepath, start_s, end_s)`,
    `clear_pad(i)`, `pad_on(i)` / `pad_off()`, `render(n)` devolve n
    frames do loop (com wrap e microfade de ~5 ms nas bordas do loop).
11. **`playback_service.py`** — no `_pump_loop`, com pad ativo o pump
    **continua consumindo** o RAW ring (posição/timeline seguem andando =
    slip) mas descarta o bloco e emite `pad.render(len(chunk))` no lugar,
    ANTES do remix — o pad passa por pitch/tempo/EQ/filtro como a faixa.
    Troca de faixa desativa e limpa os pads (a web recarrega os da nova).
12. **API/estado** — POST `/pads/set` `{index, start_s, end_s}` (usa o
    arquivo da faixa atual), `/pads/clear`, `/pads/on`, `/pads/off`;
    `PadsState {slices: 6×({start_s,end_s}|null), active: -1}`;
    `Pads.CHANGED`; tudo no `/status`.

### Web

13. **DB** — tabela `track_pads (track_id, pad_index 0–5, start_s, end_s)`
    direto no schema base — SEM migração (o `library.db` foi apagado para
    nascer fresh; a tabela é criada no bootstrap normal do banco).
14. **Rotas** — GET/PUT `/api/library/{id}/pads`; POST `/api/pads/on|off`
    proxy. Ao tocar uma faixa (`/api/play`), a web empurra os pads salvos
    pro core (mesmo padrão do resolve de stems).
15. **UI (remixer-live.js + index.html/CSS)** — o mod "Loop" vira "Pads":
    6 células (1–6; cheia = acesa, ativa = pulsando). Pad vazio → modo
    seleção: arrastar na waveform desenha a região (`.wave-loop`); o
    snap usa o BPM da faixa (início no beat, comprimento no grid ¼–8);
    In/Out refinam as bordas. Pad gravado → toggle on/off no core;
    clique longo/botão direito limpa. Persistência via PUT na gaveta.

## Ordem de entrega

A6→A9 dependem de A1→A5; B é independente de A no core (estágios
diferentes do pump) mas a UI de B reusa o sync de status de A.

1. Core FX (1–5) → web FX (6–9) → **testar com o core rodando**.
2. Core pads (10–12) → web pads (13–15) → testar slip + persistência.

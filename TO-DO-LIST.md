# TO-DO — Rolfsound V2

O que falta fazer, em ordem de valor. Arquitetura e como rodar: ver
[README.md](README.md).

## 1. Ações no backend

- [x] Mutações da fila persistidas no servidor — todas as ações da UI agora
      chegam ao core: arrastar para reordenar no dock (`/api/queue/move`),
      botão "Salvar" (fila → playlist via `/api/queue/save-as-playlist`) e
      Tocar/Embaralhar de playlist carrega a fila inteira
      (`RolfPlayback.playList`).
- [x] Playlists escritas de volta no banco — `playlists.js` abandonou o
      `localStorage`; criar/renomear/excluir/adicionar/remover vão para
      `/api/playlists/*` e reordenar/embaralhar/ordenar usam o novo
      `PUT /api/playlists/{id}/tracks`.

## 2. Migração de schema

- [x] `tags` e `fav` são colunas reais em `tracks` (tags: JSON array,
      editável nas duas gavetas "Editar informações"/ficha técnica; fav:
      persiste o "Favoritar" do menu de contexto, que antes só existia no
      DOM). ⚠ Requer apagar `db/library.db` (colunas novas).
- [x] Análise de BPM/tom ao importar — portado da branch `debug`
      (`tools/setup_essentia.py` + `api/services/audio_analysis/`, extrator
      Essentia real, não um placeholder). Roda dentro de `index_file`
      (mesmo funil do AcoustID/Discogs); toggle "Detecção de BPM e tom" no
      Config liga/desliga (`bpm_key_analysis_enabled`). **Requer rodar
      `python tools/setup_essentia.py` uma vez** para baixar o binário do
      extrator (por plataforma) — sem isso a análise é um no-op silencioso
      e bpm/key seguem só editáveis à mão.

## 3. Acervo ao vivo

- [x] Inserir a row no Acervo quando um download do Discovery completa —
      sem recarregar a página. Ao concluir, `discovery.js` busca a faixa no
      shape da UI (`GET /api/library/{id}/card`, mesmo mapeamento do bootstrap
      via `api/track_view.py`) e chama `RolfAcervo.addTrack` — a row nasce igual
      às do load (`RolfRowHtml`), entra no motor de filtro/ordenação e o evento
      `rolf:row-added` liga o clique de tocar (`prototype.js`). O download já
      cria um álbum "single" na conclusão, então a row ao vivo bate com a de um
      reload. Reload no meio de um download retoma o poll até concluir.

## 4. Capturar / Config reais

- [ ] Ligar as telas Capturar e Config em `monitor.py`/`recordings.py` e
      `settings.py` — hoje são mockups estáticos (hardware/conta).

## 5. Remixer — parâmetros que aguardam o core

- [x] **Stems fase 2** — reprodução multipista via faixa-variação "Stem
      Ready" (irmã no grupo de versões; tocá-la = sempre multipista no core,
      com mudo/solo/gain ao vivo). Implementado nos dois repos conforme
      [STEMS.md](STEMS.md): `StemMixer` + fontes de decode em lockstep no
      core, variação automática na 2ª camada na web, lanes ao vivo no
      Remixer, toggle "Manter mix de stems" na Config.
      ⚠ Requer apagar `db/library.db` (coluna nova `stem_source_id`).
- [x] **Filtro / EQ / Saída** — efeito real no core: `FxEngine` (grafo PyAV
      gêmeo do remix, estágio pós-remix do pump) com filtro LP/HP de cutoff
      log (20 Hz–20 kHz) e EQ de 3 bandas ±12 dB; `POST /api/fx` (parcial,
      como /remix), Mute real (`/api/mute`, flag própria — o fader não perde
      a posição) e medidor de saída ao vivo (`GET /api/levels`, picos L/R do
      callback; a UI só faz o poll com a tela Remixer visível).
- [x] **Pads de loop** — o módulo Loop virou um pad de samples com 6 slots
      (plano em [FX-PADS.md](FX-PADS.md)): pad vazio arma a seleção na
      waveform (arrastar, snap por compasso via BPM), pad gravado SUBSTITUI
      a faixa pelo trecho em loop no core (slip — a timeline segue andando;
      desligar volta onde a música estaria), botão direito limpa, In/Out
      refinam as bordas no playhead. Os trechos viram PCM em RAM no core
      (`PadSampler`, captura sample-accurate do arquivo, passa por
      pitch/tempo/FX como a faixa) e persistem por faixa em `track_pads`
      (schema base — sem migração); a web reempurra os pads salvos a cada
      play/avanço de fila, porque troca de faixa limpa os pads no core.

### 5.1 Refinamentos do Remixer (pós Filtro/EQ/Pads)

- [ ] **Beatgrid real** — o snap dos pads (e a régua da waveform) assume o
      grid começando em 0 s; detectar o downbeat (offset do primeiro tempo,
      dá pra extrair no mesmo funil do Essentia) ou permitir ajuste manual,
      pra seleção cair em compassos de verdade.
- [ ] **Marcadores dos 6 pads na waveform** — hoje o overlay mostra só o
      pad ativo/último tocado; chips numerados com as 6 regiões (clicar no
      chip = toggle do pad) fariam a tela ler como um sampler.
- [ ] **Performance nos pads** — atalhos de teclado 1–6 e modo momentâneo
      opcional (segurar = toca, soltar = volta), pro gesto de pad físico.
- [ ] **Pads da variação Stem Ready** — a captura decodifica o arquivo
      master; com a variação tocando, capturar o mix de stems ao vivo (com
      mudo/solo/gain aplicados) seria o esperado.
- [ ] **Ress do Filtro como controle real** — hoje é readout fixo (Q 0.707);
      virar arrastável mapeando no `w=` do biquad.
- [ ] **Medidor: clip/peak-hold** — segurar o pico por ~1 s e acender o
      segmento de clip perto de 0 dBFS; se o poll de 120 ms incomodar,
      migrar os níveis pro SSE que o core já expõe.

## 6. Superfície mobile

- [ ] Implementar `Rolfsound iPhone.html` do handoff de design
      (bundle `Rolfsound V2-handoff.zip`, projeto claude.ai/design
      "Rolfsound V2").

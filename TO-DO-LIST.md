# TO-DO — Rolfsound V2

O que falta fazer, em ordem de valor. Arquitetura e como rodar: ver
[README.md](README.md). Atualizado após uma varredura de mocks/inoperantes
(2026-07-07): tudo que ainda é estático, decorativo ou backend-sem-tela
está listado abaixo.

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

- [ ] **Capturar: ligar a tela ao backend que JÁ existe.** As rotas estão
      prontas em `api/routes/monitor.py` e `recordings.py` — `GET
      /api/monitor` (estado do recorder), SSE `/api/monitor/stream`
      (níveis ao vivo), `/api/monitor/record/start|stop`, threshold,
      auto-record, e CRUD de `/api/recordings` (listar/baixar/excluir/
      enfileirar). A tela é 100% mockup: espectrograma pintado por seed,
      medidores L/R congelados em CSS, chips "Pré-amp · Phono / 24-bit /
      Detectado" chumbados, "Gravando" e "Salvar 3 faixas no cofre" só
      disparam toast, faixas detectadas são HTML fixo ("Amber Sessions")
      e o botão "Monitorar" do cabeçalho não faz nada
      (`prototype.js:804-827`).
- [x] **Infra de Config genérica + Aparência persistente** —
      `static/js/config.js`: todo controle anotado com `data-cfg-key` é
      pintado no boot (um único `GET /api/settings`) e persistido no
      clique (`POST` parcial). Os dois toggles que já eram reais
      (stems/BPM) migraram pra ela — código duplicado removido de
      `stems.js`/`importer.js` — e a Aparência (densidade do visualizador,
      movimento reduzido) agora sobrevive ao reload (`ui_viz_density`,
      `ui_reduce_motion`), reaplicada no boot via `window.RolfAppearance`
      (prototype.js). A cor de acento deixou de ser configurável — é
      sempre derivada da capa tocando (decisão de produto; o seletor de
      swatches foi removido).
- [ ] **Config: linhas que seguem visuais** — saída de áudio, taxa de
      amostragem, key lock e normalização de volume não persistem nem
      chegam ao core (dependem de endpoints novos no core); formato de
      rip e auto-split é só anotar com `data-cfg-key` quando o Capturar
      for ligado. Cartões de identidade e dispositivo são fake (Rolf
      Nivelle, firmware v2.4.1, temperatura, 1.28 TB); botões mortos:
      Sincronizar, Editar perfil, Gerenciar plano, Exportar biblioteca,
      Sair (todos viram toast).
- [ ] **Barra de armazenamento da topbar** — a contagem de faixas é real
      (render.js/acervo.js atualizam), mas a barra de uso e o "— / —"
      nunca saem do estado inicial. Preencher com o tamanho real da pasta
      de música (soma dos arquivos, dá pra devolver no bootstrap).

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

### 5.1 Remixer — o que ainda é decorativo

- [ ] **"Salvar versão" é toast** — o botão de destaque do cabeçalho só
      mostra "Versão salva no cofre" (`prototype.js:785`). Salvar de
      verdade: render do estado atual (pitch/tempo/FX) como
      arquivo-variação no grupo de versões — a infra de grupos/variações
      já existe (fase Versions), falta o render no core.
- [ ] **A/B é toggle visual** — o par de botões só troca a classe
      `.active` (`prototype.js:695`); guardar dois snapshots da mesa
      (pitch/tempo/FX) e alternar aplicando via `/api/remix` + `/api/fx`.
- [ ] **Ferramentas da waveform mortas** — Beatgrid/Loop/Cue/Zoom são
      toggles sem função: Cue e Zoom não fazem nada, Beatgrid não
      liga/desliga régua nenhuma, Loop é anterior aos pads. Ligar cada uma
      ou remover os botões.
- [ ] **Key lock / Sync são CSS** — os `mod-toggle` de Pitch e Tempo só
      alternam `.on` (handler genérico). Key lock: o remix engine do core
      já é sempre pitch/tempo-independente — ou expor um key lock real
      (desligado = repitch estilo vinil), ou virar rótulo fixo. Sync não
      tem contra o que sincronizar (deck único) — remover ou definir alvo.
- [ ] **Gain do módulo Saída** — readout fixo em "0 dB"; virar trim real
      pós-FX no core (hoje só existe o volume do transporte).
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

## 6. Busca / Acervo — dataset e facetas

- [x] **Busca vê o cofre ao vivo** — `search-engine.js` relê as rows do
      Acervo (`refresh()`) no novo evento `rolf:screen` (disparado por
      `showScreen` em prototype.js ao abrir qualquer tela) e nos eventos
      `rolf:row-added`/`rolf:track-saved`, então importar arquivo, concluir
      download do Discovery ou salvar metadados/fav reflete sem reload. O
      refresh também regenera os chips de Tags/Tom e a contagem do crumb.
- [x] **Chips de Tags derivados do cofre** — o HTML só tem o container
      `[data-tag-chips]`; `buildTagChips()` monta os chips da união das
      tags reais das rows (mais usadas primeiro), some com a faceta quando
      não há tags e larga seleções cujo valor sumiu.
- [x] **Chips de Tom derivados do cofre** — `[data-key-chips]` +
      `buildKeyChips()`: só os tons presentes, ordenados pela roda de
      Camelot; a compatibilidade harmônica segue valendo entre os chips.
- [x] **Facetas "CD" e "Edit" removidas** — não há fonte de CD (Capturar é
      mockup) nem estado "edit" no schema (`track_view.py` só dá fmt
      vinil|digital e state master|rip), e "Salvar versão" ainda é toast
      (5.1). Os chips que filtravam para lista vazia foram removidos das
      duas telas (filtro rápido do Acervo e facetas da Busca). Quando o
      rip/CD e os edits renderizados existirem, os chips voltam com campo
      real por trás.

## 7. Visualizadores — FFT fake

- [x] **Campo de pontos real (mini-vis do transporte + viz fullscreen)** —
      o core calcula FFT sob demanda (`GET /api/levels?bands=N`: o callback
      copia a saída num anel de ~43 ms, e as N bandas log 30 Hz–16 kHz são
      calculadas no thread da API — o callback nunca paga FFT). Na web,
      `levels-feed.js` é o poller único de `/api/levels` (o medidor do
      Remixer migrou pra ele) e só roda com consumidor ativo + tocando.
      O motion dirige nível (swell com ataque/release), beat (detector de
      transiente sobre o nível real; core offline volta ao relógio de BPM)
      e `paintMatrix` desenha as bandas reais interpoladas nas colunas —
      sem core, tudo cai no envelope sintético de sempre.
- [ ] Espectrograma do Capturar segue sintético — é mockup junto com a
      tela toda; ligar no SSE `/api/monitor/stream` quando o item 4
      (Capturar real) for atacado.

## 8. Backend pronto, sem UI

- [ ] **Histórico de reprodução** — `GET /api/history` já grava e lista
      (`api/routes/history.py`), nenhuma tela consome. Ideia: seção
      "Tocadas recentemente" no Acervo ou no dock da fila.
- [ ] **Fila agendada** — `/api/queue/scheduled` completo no backend
      (`scheduled_queues.py`: criar de playlist ou lista avulsa, timestamp
      futuro, listar/cancelar), zero UI. Ideia: "Agendar" no menu de
      contexto da playlist.

## 9. Superfície mobile

- [ ] Implementar `Rolfsound iPhone.html` do handoff de design
      (bundle `Rolfsound V2-handoff.zip`, projeto claude.ai/design
      "Rolfsound V2").

## 10. Miúdos

- [ ] Rótulo do dock "Da fila · Acervo" é fixo — não muda quando a fila
      veio de playlist ou do Discovery.
- [ ] `<title>` da página ainda é "Rolfsound V2 — Protótipo".
- [ ] Código morto: `STUB_COPY` em `prototype.js:28` (o toast "Em breve"
      nunca dispara — todas as telas existem).

## 11. Onboarding — introdução no primeiro boot

- [x] **V1: boas-vindas + primeira faixa** — `static/js/onboarding.js`
      (+ `static/css/onboarding.css`) mostra um cartão de boas-vindas UMA
      vez no primeiro boot: apresenta o app (Acervo/Busca/Remixer) e leva à
      ação real — "Importar minha primeira faixa" dispara o mesmo
      `[data-import-open]` do cabeçalho do Acervo. Estado no SERVIDOR
      (`onboarding_done` via `api/settings`; default em
      [utils/config.py](utils/config.py)), não em localStorage: o importer dá
      `location.reload()` ao concluir e só o servidor sobrevive a isso.
      Dispensar (qualquer botão, X, Esc ou clique fora do cartão) grava
      `onboarding_done=true`. Reabrir: Config → **Introdução** → "Ver de
      novo" (`[data-onboard-replay]` → `RolfOnboarding.replay()`). O
      Discovery ficou de fora do tutorial de propósito — é só admin/dev.
- [x] **Empty-state do Acervo acionável** — com o cofre vazio o `.acv-empty`
      ([acervo.js](static/js/acervo.js)) agora traz um botão "Importar faixas"
      (mesmo ponto de entrada) e some quando é só filtro escondendo tudo.
      Serve de rede de segurança depois que as boas-vindas são dispensadas.
- [x] **Boot splash (todo boot)** — `static/js/boot-splash.js`
      (+ `static/css/boot-splash.css`) mostra um disco de vinil girando + a
      wordmark cobrindo o load real: some quando o app fica pronto
      (`window.load`), com mínimo de 1,1 s em tela, teto de 6 s no JS e uma
      rede de segurança em CSS aos 9 s. Injetado como 1º elemento do `<body>`
      pra pintar antes de tudo. Ao sair emite `rolf:splash-done` /
      `window.__rolfSplashDone` — as boas-vindas (V1) esperam esse sinal pra
      surgir só depois da revelação. Respeita "Movimento reduzido"; CSS puro,
      sem asset.
- [x] **V2: coach marks contextuais** — `static/js/coachmarks.js`
      (+ `static/css/coachmarks.css`) mostra uma dica na 1ª visita de cada
      tela (NÃO no boot). Gatilho: `MutationObserver` na classe `.active` das
      `.screen` (Remixer, Busca) — pega nav por clique, duplo-clique ou menu
      de contexto, já que `showScreen` não emite evento; a Fila dispara no 1º
      open do dock que já tiver itens. Spotlight recorta o elemento REAL via
      `box-shadow` gigante e desliza entre os passos. Anchors: união de
      `.rmx-deck .mod.primary` (pitch/tempo), `[data-coach="fx"]` (Filtro+EQ),
      `.pad-grid`, `[data-stems-btn]`; `.bsc-query`/`.bsc-filters`;
      `[data-queue-list]`/`[data-queue-save]`. Flag por tela em `api/settings`
      (`coach_remixer_seen`/`coach_busca_seen`/`coach_fila_seen`, defaults em
      [config.py](utils/config.py)); Esc e setas navegam. Nunca coincide com o
      splash (900) nem as boas-vindas (800). Reabrir: Config → Introdução →
      "Rever dicas" (`[data-coach-replay]` → `RolfCoach.reset()`).
- [ ] **V3: checklist "Primeiros passos"** — canto discreto que se marca
      sozinho (trouxe música ▸ tocou faixa ▸ abriu Remixer ▸ salvou versão);
      some ao completar ou dispensar, flag em `api/settings`.

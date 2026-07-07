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

- [ ] **Busca não vê o cofre ao vivo** — `search-engine.js` lê as rows do
      Acervo UMA vez no load (`buildDataset` só roda no init). Importar
      arquivo, concluir download do Discovery ou editar tags/fav/BPM não
      reflete na Busca até recarregar. Reconstruir no `rolf:row-added` e
      após edições (ou reler ao abrir a tela).
- [ ] **Chips de Tags chumbados** — Ambient/Techno/House/Downtempo estão
      fixos no HTML (`index.html:390-395`); derivar das tags reais do
      cofre (agora são coluna no banco).
- [ ] **Chips de Tom fixos em 8 tons** — gerar a partir dos tons presentes
      no cofre (o motor Camelot já cobre todos).
- [ ] **Facetas "CD" e "Edit" nunca casam** — `track_view.py` só deriva
      `fmt` vinil|digital (source == 'recording') e `state` master|rip
      (status == 'identified'); 'cd' e 'edit' não existem no schema. Os
      mesmos chips estão no filtro rápido do Acervo — hoje filtram para
      lista vazia sempre. Ou criar os campos reais (formato de origem /
      estado de edição), ou remover os chips.

## 7. Visualizadores — FFT fake

- [ ] O campo de pontos (mini-vis do transporte + viz fullscreen) e o
      espectrograma do Capturar são envelope sintético com seed —
      `dash.js` declara no topo: "the FFT is faked with a stable waveform
      envelope". O core já expõe picos L/R (`/api/levels`, com SSE
      disponível) — no mínimo dirigir o pulso/swell com nível real;
      espectro de verdade pede o core expor bandas de FFT.

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

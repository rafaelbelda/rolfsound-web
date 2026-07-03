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

- [ ] `ALTER TABLE tracks` com `tags` e `fav` (bpm/key/album já existem;
      tags hoje derivam só de `genre`, fav é sempre falso no bootstrap).
- [ ] Análise de BPM/tom ao importar (o Config já tem o toggle na UI).

## 3. Acervo ao vivo

- [ ] Inserir a row no Acervo quando um download do Discovery completa —
      hoje precisa recarregar a página.

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
- [ ] **Filtro / EQ / Loop / Saída** — hoje são controles visuais em
      `remixer-live.js`; ganham efeito quando o core expor esses parâmetros.

## 6. Superfície mobile

- [ ] Implementar `Rolfsound iPhone.html` do handoff de design
      (bundle `Rolfsound V2-handoff.zip`, projeto claude.ai/design
      "Rolfsound V2").

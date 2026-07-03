# TO-DO — Rolfsound V2

O que falta fazer, em ordem de valor. Arquitetura e como rodar: ver
[README.md](README.md).

## 1. Ações no backend

- [ ] Mutações da fila persistidas no servidor (hoje a fila vive no core e o
      estado é salvo/restaurado, mas as ações da UI ainda são parciais).
- [ ] Playlists escritas de volta no banco — hoje ficam só em `localStorage`
      (chave `rolf_playlists_v2`); o bootstrap já as lê do banco, falta o
      caminho de escrita (criar/renomear/adicionar/remover via API).

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

- [ ] **Stems fase 2** — reprodução multipista: mix de 4 stems no core
      (`rolfsound/services/remix_engine.py`, projeto irmão) com
      níveis/mudo/solo vindos da UI. Os controles nas lanes e o
      `GET /api/library/{id}/stems/{role}/download` já estão prontos.
- [ ] **Filtro / EQ / Loop / Saída** — hoje são controles visuais em
      `remixer-live.js`; ganham efeito quando o core expor esses parâmetros.

## 6. Superfície mobile

- [ ] Implementar `Rolfsound iPhone.html` do handoff de design
      (bundle `Rolfsound V2-handoff.zip`, projeto claude.ai/design
      "Rolfsound V2").

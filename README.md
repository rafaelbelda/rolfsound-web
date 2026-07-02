# Rolfsound V2

App web do Rolfsound: acervo de faixas (vinil · CD · digital), playlists, busca
avançada, Remixer ao vivo, captura/rip e — para contas admin — Discovery
(busca e download do YouTube via yt-dlp).

Frontend vanilla HTML/CSS/JS implementado a partir do protótipo do Claude Design
("Rolfsound V2" → `Rolfsound Prototype.html`), servido por um backend FastAPI.

## Como rodar

```powershell
# 1. venv + dependências (uma vez)
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

# 2. servidor
.\.venv\Scripts\python.exe main.py
# → http://localhost:8766  (porta em config.json: server_port)
```

Sem backend, o frontend também abre em qualquer servidor estático
(`python -m http.server`) — o `/api/bootstrap.js` dá 404 inofensivo e o app
fica com o cofre vazio. Precisa ser HTTP (não `file://`) por causa dos `fetch`.

O backend espera opcionalmente um processo `rolfsound-core` (o player físico,
`core_url` na config). Sem ele, os logs mostram `Core timeout` — inofensivo;
biblioteca, busca e Discovery funcionam normalmente.

## Arquitetura

### Fluxo de dados (o contrato central)

```
SQLite (db/library.db)
  └─ GET /api/bootstrap.js          api/routes/bootstrap.py
       └─ window.RolfsoundData      { tracks, queue, playlists, account }
            └─ static/js/render.js  constrói as rows do Acervo + fila
                 └─ demais módulos  leem tudo do DOM renderizado
```

- **`static/js/data.js`** define o objeto vazio e documenta o formato de faixa
  (id, title, artist, bpm, key, fmt, state, tags, dur, cover…). É a referência
  do contrato.
- **`static/js/render.js`** precisa rodar **antes** dos módulos de
  comportamento (ordem dos `<script>` no `index.html`) — eles ligam handlers
  nas rows no load.
- Faixas são identificadas por **`id`** (o id do banco). O sistema de
  coordenadas (C04·R08) do protótipo foi removido como metadado.

### Frontend (`index.html` + `static/`)

| Módulo | Responsabilidade |
|---|---|
| `dash.js` | canvases (mesh de fundo, visualizador de pontos, waveforms) |
| `prototype.js` | navegação entre telas, transporte, fila, acento reativo |
| `acervo.js` | filtros/ordenação/agrupamento do Acervo (opera nas rows do DOM) |
| `playlists.js` | playlists (persistem em `localStorage`, chave `rolf_playlists_v2`) |
| `search-engine.js` | Busca avançada — client-side sobre o acervo (Camelot, BPM, tags) |
| `track-panels.js` | gavetas de editor / álbum / artista no dock |
| `remixer-engine.js` | áudio real (Web Audio, pitch/tempo independentes); decodifica de `/api/library/{id}/download` ao carregar faixa |
| `discovery.js` | aba Discovery (só ativa com `account.admin`) |
| `seekbar.js`, `tp-scrub-line.js`, `prototype-motion.js`, `ui-scale.js` | seek do visualizer, scrub do transporte, animação, escala |

Telas Capturar e Config são mockups estáticos (hardware/conta) — ainda sem dados.

### Backend (FastAPI, `main.py` → `api/app.py`)

- Rotas antigas restauradas do commit `ad202d7`: library, playlists, queue,
  playback, history, settings, downloads, monitor, recordings, discogs.
- `api/routes/bootstrap.py` — monta o `RolfsoundData` do SQLite. Mapeamento do
  schema antigo: `source 'recording'`→vinil, `status 'identified'`→master;
  **bpm/key/tags/fav/album ainda não existem no schema** (aparecem como "—").
- `database.scan_and_reconcile` no startup importa arquivos soltos de `./music`.

## Discovery e o gate de admin

O produto **não pode ser comercializado com download do YouTube**. Por isso:

- `config.json` → `"account_type": "standard" | "admin"` (padrão **standard**).
- `api/deps.py::require_admin` — as rotas `/api/search` (busca YouTube via SSE)
  e `/api/downloads` (fila do yt-dlp) respondem **403** para não-admin. O gate
  real é este; a UI apenas esconde a aba (`discovery.js` + `account.admin` no
  bootstrap).
- Binário do yt-dlp: resolvido em `youtube/ytdlp.py::YTDLP_BIN` (ao lado do
  Python do venv, senão PATH).

## Próximos passos (em ordem de valor)

1. **Ações no backend** — tocar de verdade (`playback.py`/core), mutações da
   fila e playlists persistidas no servidor (hoje playlists ficam só em
   `localStorage`; o bootstrap já as lê do banco, falta escrever de volta).
2. **Migração de schema** — `ALTER TABLE tracks` com bpm, key, tags, fav,
   album; análise de BPM/tom ao importar (o Config já tem o toggle).
3. **Acervo ao vivo** — inserir a row quando um download do Discovery completa
   (hoje precisa recarregar a página).
4. **Capturar/Config reais** — ligar em `monitor.py`/`recordings.py` e
   `settings.py`.
5. **Superfície mobile** — o handoff do design tem `Rolfsound iPhone.html`
   (bundle: `Rolfsound V2-handoff.zip`, projeto claude.ai/design "Rolfsound V2").

## Referências

- Design de origem: projeto **Rolfsound V2** no claude.ai/design
  (`f0fbfe10-7262-4945-ae88-68fdaedc2877`); o zip de handoff tem o design
  system completo (tokens, guidelines, telas mobile).
- Backend antigo completo (dashboard velho incluído): commit `ad202d7`.

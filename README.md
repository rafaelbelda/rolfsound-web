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
| `remixer-live.js` | superfície de controle do core (pitch/tempo via `/api/remix`, seek na waveform, picker de faixa) |
| `stems.js` | versão multipista "Stem Ready": lanes coloridas sempre visíveis quando a variação está carregada no Remixer (vocals·drums·bass·other), mudo/solo/gain AO VIVO no core (`/api/remix/stems`, sync via `rolf:status`), gaveta de upload dos 4 slots (`/api/library/{id}/stems/*`) que cria/desfaz a variação na 2ª camada, toggle "manter mix" na Config |
| `discovery.js` | aba Discovery (só ativa com `account.admin`) |
| `seekbar.js`, `tp-scrub-line.js`, `prototype-motion.js`, `ui-scale.js` | seek do visualizer, scrub do transporte, animação, escala |

Telas Capturar e Config são mockups estáticos (hardware/conta) — ainda sem dados.

### Backend (FastAPI, `main.py` → `api/app.py`)

- Rotas antigas restauradas do commit `ad202d7`: library, playlists, queue,
  playback, history, settings, downloads, monitor, recordings, discogs.
- `api/routes/bootstrap.py` — monta o `RolfsoundData` do SQLite. Mapeamento do
  schema antigo: `source 'recording'`→vinil, `status 'identified'`→master;
  `tags` (JSON array) e `fav` são colunas próprias, editáveis nas gavetas de
  metadados e no "Favoritar" do menu de contexto.
- `api/services/audio_analysis/` — detecção de BPM/tom via extrator Essentia
  externo (`tools/setup_essentia.py` baixa o binário por plataforma). Chamado
  de dentro de `index_file` (mesmo funil do AcoustID/Discogs); sem o binário
  configurado é um no-op silencioso. Liga/desliga em Config
  (`bpm_key_analysis_enabled`).
- `api/routes/stems.py` — stems por faixa (4 papéis fixos): GET/POST/DELETE
  `/api/library/{id}/stems[/{role}]`. Arquivos viram sidecars
  `{id}.stem.{role}.ext` no diretório de música (ignorados pelo scan) e
  registram em `track_stems`. Com ≥2 camadas nasce a **faixa-variação
  "Stems"** (`id = {X.id}::stems`, `stem_source_id = X.id`) no grupo de
  versões da original; tocá-la envia os paths dos stems ao core, que
  decodifica em lockstep e mixa ao vivo. O bootstrap manda os papéis só na
  variação (`stems: [roles]`, `stems_of`) — a original fica limpa.
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

## Próximos passos

A lista viva do que falta fazer está em **[TO-DO-LIST.md](TO-DO-LIST.md)**,
em ordem de valor.

## Referências

- Design de origem: projeto **Rolfsound V2** no claude.ai/design
  (`f0fbfe10-7262-4945-ae88-68fdaedc2877`); o zip de handoff tem o design
  system completo (tokens, guidelines, telas mobile).
- Backend antigo completo (dashboard velho incluído): commit `ad202d7`.

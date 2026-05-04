# rolfsound-web

Local network web dashboard and media manager for the rolfsound audio hub.

## Architecture

```
rolfsound-core  (localhost:8765)  — hardware, recording, playback engine
rolfsound-web   (localhost:8766)  — FastAPI + dashboard + library management
```

rolfsound-web communicates with rolfsound-core via three channels:

| Channel | Transport | Used for |
|---|---|---|
| HTTP | `httpx` persistent client | Commands (play, pause, skip, queue) |
| SSE | `EventStreamClient` | Real-time events from core → web |
| IPC socket | TCP (Win) / Unix socket | Zero-latency seek and volume |

No Python imports from core. No shared state.

## Setup

### System dependencies

Audio fingerprinting uses **pyacoustid** (pure Python) + **libchromaprint** (system library).

| Platform | Install | Notes |
|---|---|---|
| Raspberry Pi / Debian | `apt install libchromaprint1` | Works out of the box |
| Windows (dev) | Drop `fpcalc.exe` in project root | `libchromaprint.dll` not pip-installable |
| macOS | `brew install chromaprint` | Sets up the shared library |

**Fingerprint fallback chain** (`api/services/indexer.py`):
1. **pyacoustid + PyAV** — decodes PCM in-process via PyAV, passes to libchromaprint
2. **fpcalc subprocess** — fallback when libchromaprint not found

Audio decoding is handled by **PyAV** (`pip install av`), which ships with ffmpeg compiled in.

### Python dependencies

```bash
pip install -r requirements.txt
python tools/setup_essentia.py
python main.py
```

Dashboard: **http://localhost:8766** or **http://raspberrypi.local:8766**

### Audio analysis extractor

`pip install -r requirements.txt` does not install Essentia itself. For local dev,
run:

```bash
python tools/setup_essentia.py
```

This downloads the official prebuilt `essentia_streaming_extractor_music`
binary into `./tools/essentia/` and updates local `config.json` so the app
finds it automatically.

Notes:

- Desktop dev is supported through the bootstrap script on Windows and common
  x86_64 platforms.
- Raspberry Pi production should use the official Rolfsound image with Essentia
  already provisioned, or a manually configured `essentia_extractor_path`.

## Project Structure

```
api/
  app.py                    — FastAPI app, lifespan, event handlers
  routes/
    search.py               — GET  /api/search
    library.py              — GET/DELETE /api/library, preferred-asset
    queue.py                — /api/queue/* (add, remove, move, clear, repeat, shuffle, save-as-playlist)
    playback.py             — /api/play, /api/pause, /api/skip, /api/seek
    playlists.py            — CRUD /api/playlists, track management, rename, sort
    scheduled_queues.py     — /api/queue/scheduled (create, list, cancel)
    history.py              — GET /api/history
    settings.py             — GET/POST /api/settings
    downloads.py            — /api/downloads
    monitor.py              — /api/monitor (SSE audio stream)
    recordings.py           — /api/recordings
    discogs.py              — /api/discogs (OAuth + collection)
  services/
    indexer.py              — Fingerprint → AcoustID → Shazam → Discogs identification pipeline
    pipeline.py             — Universal ingest: normalize, index, move file into library
    status_enricher.py      — Enriches core /status with DB metadata (title, artist, thumbnail)

core/
  database/
    database.py             — SQLite schema + all query helpers
  ingestors/
    download_manager.py     — Background download queue (one at a time)
    youtube/
      ytdlp.py              — yt-dlp wrapper (search + download)
      search.py             — YouTube search client
  library/
    cleanup.py              — Daily auto-cleanup of old low-play tracks
    scheduled_queue.py      — Daemon: fires scheduled queues at their target time

utils/
  bridge/
    core_facade.py          — Unified API over HTTP + IPC for all core operations
    http_client.py          — Persistent httpx.AsyncClient for core HTTP calls
    ipc_client.py           — TCP/Unix socket client for seek and volume commands
    event_stream_client.py  — SSE consumer for core → web event stream
  core.py                   — Singleton: instantiates and wires http_client + ipc_client + facade
  config.py                 — config.json loader/saver

dashboard/
  index.html                — App shell (SPA routing)
  views/
    digital-library.html    — Library, playlists, search UI
    vinyl-library.html      — Vinyl collection view
    settings.html           — Settings page

static/
  js/
    features/
      island/               — RolfsoundIsland, IslandImpactEngine, birth/morph animators
      player/               — PlaybackStateStore, Miniplayer, NowPlayingTheme, ReactiveBackdrop
      animations/           — AnimationEngine, Animator, DivisionAnimator, palette extractors
      library/              — PlaylistController, VinylRecord, UploadController
      search/               — SearchController, SearchLayoutCoordinator, ContextMenuController
    components/
      version-panel/        — version-panel.js + version-panel.css (multi-version asset panel)
      play-button/
      queue-button/
      seek-bar/
      ... (other Web Components)
    playback/               — MitosisStateMachine, PlayerShell, ThumbnailCrossfader
    channel/                — RolfsoundChannel, IntentQueue, ChannelReconnector
    core/                   — RolfsoundControl, adoptStyles
    utils/                  — thumbnails.js, Cursor.js
  css/
    global.css              — Design tokens (colors, typography, motion)

db/
  library.db                — SQLite database (auto-created on first run)
```

## MAM Data Model

The library uses a **Media Asset Manager** model: each logical track can have multiple physical assets.

```
tracks          — Logical entity: metadata, identity, play count
└── assets      — Physical files: one per format/version (FLAC, remix, live, demo…)
    └── tags    — Tag taxonomy shared across tracks and assets
```

`tracks.preferred_asset_id` points to the "Fast Play" asset — the one sent to core on play.

**Asset types:** `ORIGINAL_MIX`, `ALT_VERSION`, `REMIX`, `LIVE`, `RADIO_EDIT`, `DEMO`, `INSTRUMENTAL`, `RECORDING`, `FLAC`

## Database Schema

| Table | Purpose |
|---|---|
| `tracks` | Metadata, fingerprint, play count, preferred asset |
| `assets` | Physical files — one per format/version, FK → tracks |
| `tags` | Tag taxonomy (category + name) |
| `track_tags` | M:N tracks ↔ tags |
| `asset_tags` | M:N assets ↔ tags |
| `identity_candidates` | Pending ID results with confidence scores |
| `history` | Every play event with skip detection |
| `playlists` | User-created playlists |
| `playlist_tracks` | Playlist membership with position |
| `queue_state` | Persisted queue (restored on startup) |
| `scheduled_queues` | Queues scheduled to fire at a specific time |
| `downloads` | Download queue progress |
| `discogs_account` | OAuth tokens for connected Discogs account |
| `discogs_collection` | Mirrored Discogs vinyl collection |

## Core API Contract

| Method | Path | Description |
|---|---|---|
| GET | /status | Full playback state (repeat_mode, shuffle, current track) |
| GET | /queue | Current queue |
| GET | /events/stream | SSE event stream |
| POST | /play | Start playback |
| POST | /pause | Pause/resume |
| POST | /skip | Skip track |
| POST | /queue/add | Add to queue (supports `position` for "play next") |
| POST | /queue/remove | Remove from queue |
| POST | /queue/move | Reorder queue |
| POST | /queue/clear | Clear queue |
| POST | /queue/previous | Go to previous track |
| POST | /queue/repeat | Set repeat mode: `off` / `one` / `all` |
| POST | /queue/shuffle | Enable/disable shuffle |

IPC commands (seek, volume, remix) bypass HTTP and go directly via socket for zero-latency response.

## Ingest Pipeline

All sources funnel through a single `ingest_existing_file` function in `api/services/pipeline.py`:

```
Upload / YouTube download / Library scan
  └─ ingest_existing_file(filepath, source, source_ref, ...)
       ├─ normalize_audio (ffmpeg → target format)
       ├─ move to music/<track_id>/
       ├─ upsert track + asset rows
       └─ run indexer (fingerprint → AcoustID → Shazam → Discogs)
```

**Download flow:**
1. User selects YouTube result → `POST /api/downloads`
2. yt-dlp downloads to `cache/<id>.tmp.*`
3. `ingest_existing_file` normalizes, moves, and indexes
4. Track available in library immediately; identification runs in background

Only **one download runs at a time.** Temp files are cleaned on startup.

## Track Identification Pipeline

```
Chromaprint fingerprint (pyacoustid / fpcalc)
  └─ AcoustID  →  MusicBrainz recording ID
  └─ Shazam    →  artist + title (fallback)
  └─ YouTube title (fallback for downloaded tracks)
       └─ Discogs search  →  cover art, label, year, vinyl release info
```

The fingerprint is stored per-asset and used by `GET /api/library/duplicates`.

## Event Handlers

| Event | Action |
|---|---|
| `track_changed` | Increment `streams`, insert `history` row, detect skip (< 30% played) |
| `track_finished` | Auto-insert recordings into library |
| `state_refresh` | Full status refetch (triggered on SSE resync) |

## Queue Features

- **Persist across restarts** — saved to SQLite on shutdown, restored on startup
- **Repeat modes** — `off`, `one`, `all`
- **Shuffle** — randomized order, current track stays first
- **Play next** — insert at `current_index + 1`
- **Save as playlist** — snapshot current queue into a named playlist
- **Scheduled queue** — fire at a future Unix timestamp via daemon

## Configuration

Edit `config.json` or use the Settings page.

| Key | Default | Description |
|---|---|---|
| `core_url` | `http://localhost:8765` | rolfsound-core address |
| `server_port` | `8766` | Port for this service |
| `music_directory` | `./music` | Where audio files are stored |
| `database_path` | `./db/library.db` | SQLite database path |
| `cleanup_enabled` | `true` | Auto-remove old low-play tracks |
| `cleanup_min_streams` | `3` | Minimum plays to keep a track |
| `cleanup_days` | `30` | Age threshold for cleanup |
| `discogs_consumer_key` | `""` | App-level Discogs key (optional) |
| `discogs_consumer_secret` | `""` | App-level Discogs secret |

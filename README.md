# rolfsound-control

Local network web dashboard and media manager for the rolfsound audio hub.

## Architecture

```
rolfsound-core    (localhost:8765)  — hardware, recording, playback engine
rolfsound-control (localhost:8766)  — FastAPI + dashboard + library management
```

rolfsound-control communicates with rolfsound-core **exclusively via HTTP**.
No Python imports from core. No shared state.

## Setup

### System dependencies

Audio fingerprinting uses **pyacoustid** (pure Python) + **libchromaprint** (system library).
No `fpcalc` binary is required if `libchromaprint` is installed:

| Platform | Install | Notes |
|---|---|---|
| Raspberry Pi / Debian | `apt install libchromaprint1` | No binary needed — works out of the box |
| Windows (dev) | Download `fpcalc.exe` and drop it in the project root | `libchromaprint.dll` is not pip-installable; fpcalc is the practical option |
| macOS | `brew install chromaprint` | Sets up the shared library |

**How the fingerprinter works** — two-path fallback in `api/services/indexer.py`:
1. **pyacoustid + PyAV** (primary): decodes audio in-process via PyAV, passes PCM to `libchromaprint` through pyacoustid. Requires `libchromaprint` to be available.
2. **fpcalc subprocess** (fallback): used when `libchromaprint` is not found. Requires `fpcalc` / `fpcalc.exe` on `PATH` or in the project root.

Audio decoding (ffmpeg) is handled by **PyAV** (`pip install av`), which ships with ffmpeg compiled in — no external binary needed.

### Python dependencies

```bash
pip install -r requirements.txt
python main.py
```

Access dashboard at: **http://localhost:8766** or **http://raspberrypi.local:8766**

## Project Structure

```
api/
  app.py                  — FastAPI app, lifespan (startup/shutdown), event handlers
  routes/
    search.py             — GET  /api/search
    library.py            — GET/DELETE /api/library, GET /api/library/duplicates
    queue.py              — /api/queue/* (add, remove, move, clear, repeat, shuffle,
                            save-as-playlist)
    playback.py           — /api/play, /api/pause, /api/skip, /api/seek
    playlists.py          — CRUD /api/playlists, track management, rename, sort
    scheduled_queues.py   — /api/queue/scheduled (create, list, cancel)
    history.py            — GET /api/history
    settings.py           — GET/POST /api/settings
    downloads.py          — /api/downloads
    monitor.py            — /api/monitor (SSE audio stream)
    recordings.py         — /api/recordings
    discogs.py            — /api/discogs (OAuth + collection)
  services/
    indexer.py            — Audio fingerprint (fpcalc) → AcoustID → Shazam → Discogs

db/
  database.py             — SQLite schema + all query helpers

downloads/
  manager.py              — Background download queue (one at a time)

library/
  cleanup.py              — Daily auto-cleanup of old low-play tracks
  scheduled_queue.py      — Daemon: fires scheduled queues at their target time

youtube/
  ytdlp.py                — yt-dlp wrapper (search + download)

utils/
  config.py               — config.json loader/saver
  core_client.py          — Persistent async HTTP client for rolfsound-core
  event_poller.py         — Background event polling from core (2s interval)
  monitor_accumulator.py  — Polls core audio samples, fans out to SSE clients

dashboard/
  views/
    digital-library.html  — Library, playlists, search UI
  index.html              — App shell (SPA routing)

static/
  js/
    playback-mitosis.js       — Playback controls, queue panel, repeat/shuffle
    PlaylistController.js     — Playlist context menu actions
    ContextMenuController.js  — Generic context menu system
    RolfsoundIsland.js        — Dynamic Island widget (now playing, toasts)
  css/
    global.css                — Design tokens (colors, typography, motion)
```

## Database Schema

| Table | Purpose |
|---|---|
| `tracks` | Library: metadata, fingerprint, play count |
| `history` | Every play event with skip detection |
| `playlists` | User-created playlists |
| `playlist_tracks` | Playlist membership with position |
| `queue_state` | Persisted queue (restored on startup) |
| `scheduled_queues` | Queues scheduled to fire at a specific time |
| `downloads` | Download queue progress |
| `discogs_account` | OAuth tokens for the connected Discogs account |
| `discogs_collection` | Mirrored Discogs vinyl collection |

## Core API Contract

rolfsound-control forwards user actions to these rolfsound-core endpoints:

| Method | Path | Description |
|---|---|---|
| GET | /status | Full playback state (includes repeat_mode, shuffle) |
| GET | /queue | Current queue |
| GET | /events?since= | Event stream |
| POST | /play | Start playback |
| POST | /pause | Pause/resume |
| POST | /skip | Skip track |
| POST | /seek | Seek to position |
| POST | /queue/add | Add to queue (supports `position` for "play next") |
| POST | /queue/remove | Remove from queue |
| POST | /queue/move | Reorder queue |
| POST | /queue/clear | Clear queue |
| POST | /queue/previous | Go to previous track |
| POST | /queue/repeat | Set repeat mode: `off` / `one` / `all` |
| POST | /queue/shuffle | Enable/disable shuffle |

## Queue Features

- **Persist across restarts** — queue state saved to SQLite on shutdown, restored on startup
- **Repeat modes** — `off` (stop at end), `all` (wrap), `one` (loop current track)
- **Shuffle** — randomised playback order, current track stays first
- **Play next** — insert at `current_index + 1` via the position parameter
- **Save as playlist** — snapshot current queue into a named playlist
- **Scheduled queue** — set a future Unix timestamp; daemon fires the queue automatically

## Playlist Features

- Full CRUD with cascade delete
- **Rename** via `PATCH /api/playlists/{id}`
- **Sort** tracks by position, title, artist, duration, streams, added_at (`?sort=&order=`)
- **Track stats** per entry: play count, last played, skip rate
- Remove individual tracks from a playlist

## Track Identification Pipeline

Each track goes through a chain until a title is found:

```
fpcalc (Chromaprint fingerprint)
  └─ AcoustID  →  MusicBrainz recording ID
  └─ Shazam    →  artist + title (fallback when AcoustID has no recordings)
  └─ YouTube title (final fallback for downloaded tracks)
       └─ Discogs search  →  cover art, label, year, vinyl release info
            (OAuth if connected; consumer key/secret if configured;
             unauthenticated public API otherwise — 25 req/min)
```

The Chromaprint fingerprint is stored in the `tracks` table and used by
`GET /api/library/duplicates` to detect duplicate audio files.

## Event Handlers (app.py)

| Event | Action |
|---|---|
| `track_changed` | Increment `streams`, insert `history` row, detect skip (< 30% duration played) |
| `track_finished` | Auto-insert recordings into library |

## Download Pipeline

1. User selects YouTube result → `POST /api/downloads`
2. yt-dlp downloads to `cache/<id>.tmp.*`
3. ffmpeg converts to mp3
4. Atomic rename to `music/<id>.mp3`
5. Metadata saved to SQLite
6. Indexer runs: fingerprint → AcoustID → Shazam → Discogs
7. Track available in library

Only **one download runs at a time**.
Temp files are cleaned on startup to handle crashes.

## Configuration

Edit `config.json` or use the Settings page in the dashboard.

| Key | Default | Description |
|---|---|---|
| `core_url` | `http://localhost:8765` | rolfsound-core address |
| `server_port` | `8766` | Port for this service |
| `music_directory` | `./music` | Where audio files are stored |
| `database_path` | `./db/library.db` | SQLite database path |
| `cleanup_enabled` | `true` | Auto-remove old low-play tracks |
| `cleanup_min_streams` | `3` | Minimum plays to keep a track |
| `cleanup_days` | `30` | Age threshold for cleanup |
| `discogs_consumer_key` | `""` | App-level Discogs key (optional, improves rate limits) |
| `discogs_consumer_secret` | `""` | App-level Discogs secret |

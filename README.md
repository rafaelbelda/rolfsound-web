# rolfsound-control

Local network web dashboard and media manager for the rolfsound audio hub.

## Architecture

```
rolfsound-core  (localhost:8765)  — hardware, recording, playback engine
rolfsound-control (localhost:8766) — FastAPI + dashboard + library management
```

rolfsound-control communicates with rolfsound-core **exclusively via HTTP**.
No Python imports from core. No shared state.

## Setup

```bash
pip install -r requirements.txt
python main.py
```

Access dashboard at: **http://localhost:8766** or **http://raspberrypi.local:8766**

## Structure

```
api/
  app.py              — FastAPI app + lifespan
  routes/
    search.py         — GET /api/search
    library.py        — GET/DELETE /api/library
    queue.py          — /api/queue/*
    playback.py       — /api/play, /api/pause, /api/skip, /api/seek
    history.py        — GET /api/history
    settings.py       — GET/POST /api/settings
    downloads.py      — /api/downloads

db/
  database.py         — SQLite schema + helpers

downloads/
  manager.py          — Background download queue (one at a time)

library/
  cleanup.py          — Auto-cleanup old low-play tracks

youtube/
  ytdlp.py            — yt-dlp wrapper (search + download)

utils/
  config.py           — config.json loader
  core_client.py      — HTTP client for rolfsound-core
  event_poller.py     — Background event polling from core

dashboard/
  index.html          — Single-page dashboard (vanilla JS, dark mode)
```

## Core API Contract

rolfsound-control forwards user actions to these rolfsound-core endpoints:

|Method|Path          |Description      |
|------|--------------|-----------------|
|GET   |/status       |Playback state   |
|GET   |/queue        |Current queue    |
|GET   |/events?since=|Event stream     |
|POST  |/play         |Start playback   |
|POST  |/pause        |Pause/resume     |
|POST  |/skip         |Skip track       |
|POST  |/seek         |Seek to position |
|POST  |/queue/add    |Add to queue     |
|POST  |/queue/remove |Remove from queue|
|POST  |/queue/move   |Reorder queue    |
|POST  |/queue/clear  |Clear queue      |

## Event Types

Events polled from `GET /events?since={last_id}`:

- `playback_started` / `playback_paused` / `playback_resumed` / `playback_stopped`
- `track_changed` → increments stream counter + records history
- `track_finished`
- `queue_add` / `queue_remove` / `queue_move` / `queue_clear`

## Download Pipeline

1. User selects YouTube result → POST /api/downloads
1. yt-dlp downloads to `cache/<id>.tmp.*`
1. ffmpeg converts to mp3
1. Atomic rename to `music/<id>.mp3`
1. Metadata saved to SQLite
1. Track available in library for queueing

Only **one download runs at a time**.
Temp files are cleaned on startup to handle crashes.

## Configuration

Edit `config.json` or use the Settings page in the dashboard.

Key settings:

- `core_url` — rolfsound-core address
- `server_port` — port for this service
- `music_directory` — where mp3 files are stored
- `cleanup_enabled` / `cleanup_min_streams` / `cleanup_days` — auto-cleanup policy
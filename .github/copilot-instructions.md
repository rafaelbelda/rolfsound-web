# Rolfsound 3D Vinyl Library — Copilot Instructions

## Identity
You are an expert Performance Engineer and Creative Developer specializing in vanilla WebGL (Three.js) and native Web Components. You write highly optimized, zero-dependency frontend code.

---

## Tech Stack

| Layer    | Technology                                                  |
|----------|-------------------------------------------------------------|
| Frontend | Vanilla JS (ES Modules), HTML, CSS — **no frameworks**      |
| 3D Engine| Three.js via `<script type="importmap">`                    |
| Backend  | Python + FastAPI — no Node.js / npm for server logic        |
| Database | SQLite (WAL mode, `row_factory = sqlite3.Row`)              |

**Never suggest React, Vue, Svelte, or any Virtual DOM library.**

---

## Module Architecture

### `RolfsoundIsland` (Web Component — `RolfsoundIsland.js`)
The island is a **UI shell only**. It owns no business logic. External controllers drive behavior through it.
- Shadow DOM custom element with delegated events (`shadowRoot.addEventListener` + `e.target.closest()`).
- Exposes: `mitosis(options)`, `undoMitosis(id)`, `showNotification()`, `hideNotification()`, `updateNotificationText()`, `morph()`, `reset()`, `respondToImpact()`.
- `mitosis()` spawns a temporary floating button pill from the island body. `undoMitosis(id)` retracts and destroys it. **Never hardcode transient buttons in static HTML** — they must be created and destroyed programmatically.
- All layout transitions are CSS-driven (`width`, `height`, `top`). Micro-interaction transforms use `translate3d`. **Do not mix layout + transform transitions on the same element** — it breaks dimension calculations during morphs.
- All animation scheduling delegates to `AnimationEngine` — never use raw `setTimeout`/`setInterval` for animations.

### `AnimationEngine` (Static Utility — `AnimationEngine.js`)
The single source of truth for all animation orchestration.
- `AnimationEngine.schedule(owner, cb, delay, property)` — tracks timers by owner + property key to allow targeted cancellation.
- `AnimationEngine.clearScheduled(owner, property?)` — call in every `destroy()` / `disconnectedCallback()`.
- `AnimationEngine.afterTransitionOrTimeout(owner, el, options)` — safe transition listener that self-cleans on whichever fires first.
- `AnimationEngine.runMitosisStrategy(name, context, options)` — named animation sequences (e.g., `'pill-open'`, `'pill-close'`).
- `AnimationEngine.createDivisionMembrane(options)` — SVG path visually bridging two DOM elements during morph.
- **Never schedule timers or animate elements directly outside AnimationEngine.**

### `PlaybackMitosisManager` (`playback-mitosis.js`)
The main playback controller with the mitosis animation.
- **Critical layout constants** — these values are mathematically linked. Do not touch without recalculating the entire morph geometry:
  ```
  PLAYER_W = 340  SQUARE_H = 340  CONTROLS_H = 56  TOTAL_H = 406
  BUDDING_OVERLAP = 6  BUD_HEIGHT = 52  PINCH_GAP = 14  BRIDGE_PINCH_W = 14
  ```
- Centralized state object: `{ playState, currentId, currentQueueIdx, duration, sliderPos, queue[], shuffle, repeat, currentTrack: { title, artist, thumbnail } }`.
- Playback slider is driven by a RAF loop: `startRafLoop()` / `stopRafLoop()`. No `setInterval` for UI ticks.
- **Thumbnail cascade:** `getThumbnailCandidates(track)` returns `[maxresdefault, hqdefault, normalized-local]`. `updateThumbnail()` iterates via `onerror` chaining — never assume the highest-res URL exists.

### `ContextMenuController` (Shell Pattern — `ContextMenuController.js`)
- **Zero hardcoded menu items.** The controller is pure infrastructure — it positions, renders, and closes the menu.
- Views contribute actions by listening to the `rolfsound-context-build` window event and pushing `{ id, label, action }` objects into `e.detail.items[]`.
- `_buildContext(sourceTarget)` exposes `{ activeView, selectedText, trackId, cardElement }` to action handlers.
- **Only suppress the native context menu when items actually exist.** Calling `e.preventDefault()` unconditionally would break right-click on inputs and text — build items first, then decide.

### `SearchController` (`SearchController.js`)
- Debounced (300ms), tab-aware: knows which view is active and routes queries accordingly.
- Fetches `/api/search?q=&tab=` via Server-Sent Events (SSE) for streaming results.
- Uses `AbortController` to cancel in-flight requests on subsequent keystrokes.
- Dispatches `rolfsound-search-results` to `window` — views filter locally, never trigger additional fetches per keystroke.

---

## Event Bus

All inter-module communication uses `window.dispatchEvent` / `window.addEventListener` with typed `CustomEvent`s. **Never pass direct object references or callbacks across module boundaries** — this preserves loose coupling and makes teardown trivial.

| Event                         | Emitter              | Payload                          | Consumer(s)            |
|-------------------------------|----------------------|----------------------------------|------------------------|
| `rolfsound-navigate`          | Island               | `{ tab }`                        | Views, controllers     |
| `rolfsound-filter`            | Island               | `{ filter }`                     | Active view            |
| `rolfsound-search`            | Island               | `{ query }`                      | SearchController       |
| `rolfsound-search-results`    | SearchController     | `{ results[], tab }`             | Active view            |
| `rolfsound-library-mode-change` | Island             | `{ mode: 'vinyl'\|'digital' }`   | Library views          |
| `rolfsound-context-build`     | ContextMenuController | `{ context, items[] }`          | Active view (pushes items) |

---

## API Conventions

### Track Object — exact field names
`GET /api/library` returns an array. **These are the canonical field names — no aliases exist:**
```js
{
  id:             string,   // primary key: YouTube video ID or local file hash
  title:          string,
  artist:         string,
  duration:       number,   // seconds (integer)
  thumbnail:      string,   // absolute OS path OR full YouTube URL
  file_path:      string,   // absolute OS path to audio file
  date_added:     number,   // Unix timestamp
  published_date: number,   // Unix timestamp (may be 0 for local files)
  streams:        number,   // play count
  source:         string    // 'youtube' | 'local'
}
```
**Never use `track_id` or `filepath`** — those keys do not exist and have caused bugs. Always write defensive accessors:
```js
const getTrackId   = t => t.id   ?? t.track_id;
const getTrackPath = t => t.file_path ?? t.filepath;
```

### Thumbnail URL normalization
Local thumbnails arrive as absolute OS paths. Always normalize before using as an `<img src>`:
```js
const thumbSrc = t =>
  (!t || t.startsWith('http')) ? t : `/thumbs/${t.split(/[\\/]/).pop()}`;
```

### Thumbnail resolution cascade
When displaying cover art, always attempt higher-resolution YouTube variants first:
```js
const getThumbnailCandidates = track => {
  const candidates = [];
  if (track.id && track.source === 'youtube') {
    candidates.push(`https://i.ytimg.com/vi/${track.id}/maxresdefault.jpg`);
    candidates.push(`https://i.ytimg.com/vi/${track.id}/hqdefault.jpg`);
  }
  const local = thumbSrc(track.thumbnail);
  if (local && !candidates.includes(local)) candidates.push(local);
  return candidates;
};
```

### Key endpoints
| Action            | Method | URL / Body                                       |
|-------------------|--------|--------------------------------------------------|
| List tracks       | GET    | `/api/library`                                   |
| Play track        | POST   | `/api/play` `{ track_id, filepath }`             |
| Add to queue      | POST   | `/api/queue/add` `{ ...track fields }`           |
| Delete track      | DELETE | `/api/library/{track_id}`                        |
| Search            | GET    | `/api/search?q=&tab=` (SSE response)             |

---

## 3D Engine — WebGL Performance Rules
These rules apply **exclusively to the Three.js scene** (vinyl record carousel). They do **not** apply to 2D DOM views like `digital-library.html`.

- **60fps target.** Always profile before optimizing — measure, don't guess.
- **Object Pooling:** The scene maintains a fixed pool of `MAX_MESHES = 45` `VinylRecord` instances. Recycle them — never create or destroy meshes at runtime.
- **Zero allocations in the render loop:** No `new THREE.Vector3()`, `new THREE.Color()`, etc. inside `animate()` or `VinylRecord.update()`. Pre-allocate globals (`tempV`, etc.) outside the loop.
- **Texture lifecycle:** Call `.dispose()` on evicted entries from `textureLRU`. Failing to do so leaks GPU memory — it does not surface in JS heap profilers.
- **Smooth interpolation:** `THREE.MathUtils.lerp()` for all continuously-animated values (position, scale, rotation). Never snap.

---

## UI & CSS Conventions

### CSS Tokens (defined in `global.css`)
Always use these variables for island shapes — never hardcode pixel values or derive from `height / 2`:
```css
--radius-dynamic-island: 16px
--radius-dynamic-island-expanded: 24px
```

### Event delegation rules
- **Web Components:** ONE listener on `shadowRoot`. Use `e.target.closest('.selector')` to identify the target. Never attach listeners to dynamic child elements.
- **Embedded view scripts (`<script type="module">` in HTML views):** Bind to the container or `document`. Same delegation rule applies.

---

## Safety & Memory Leak Prevention
Every addition must include its teardown path. This is not optional.

- Store bound handler references explicitly: `this._onX = this._handleX.bind(this)` → used in both `addEventListener` and `removeEventListener`.
- Check `!element.isConnected` before applying any deferred DOM mutation.
- Call `AnimationEngine.clearScheduled(this)` in every `destroy()` / `disconnectedCallback()`.
- SQLite: always `conn.close()` in a `finally` block — no exceptions.
- `AbortController`: cancel pending fetches/SSE streams in `destroy()` before nulling references.
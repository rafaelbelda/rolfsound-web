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

**Why the island intentionally stays CSS-only (not WAAPI):** `#bar-container` is the dimensional anchor for the **origin phases** of the mitosis system. `getMitosisMetrics()` calls `getBoundingClientRect()` on `#bar-container` to compute the bud/pinch/absorb geometry (where the player emerges from and retracts to). If the island were animated via WAAPI `transform: scaleX/Y`, `getBoundingClientRect()` would return the visual (transformed) size instead of the layout size — silently breaking bud/pinch/absorb position math. The **grow phase** (`targetTop`) is viewport-centered — `(window.innerHeight - TOTAL_H) / 2` — and is fully island-independent. **Do not add an `Animator` instance to the island. Do not animate `#bar-container` with WAAPI transforms.**

### `AnimationEngine` (Static Utility — `AnimationEngine.js`)
The single source of truth for all animation orchestration.
- `AnimationEngine.schedule(owner, cb, delay, property)` — tracks timers by owner + property key to allow targeted cancellation.
- `AnimationEngine.clearScheduled(owner, property?)` — call in every `destroy()` / `disconnectedCallback()`.
- `AnimationEngine.afterTransitionOrTimeout(owner, el, options)` — safe transition listener that self-cleans on whichever fires first (real `transitionend` event or timeout fallback — whichever fires first wins).
- `AnimationEngine.runMitosisStrategy(name, context, options)` — named animation sequences (e.g., `'pill-open'`, `'pill-close'`).
- `AnimationEngine.createDivisionMembrane(options)` — SVG path visually bridging two DOM elements during morph. Returns a controller with `setConnected()`, `setSplit()`, `fadeOut()`, `remove()`.
- `AnimationEngine.destroyMitosis(container, options)` — removes a mitosis surface. Options: `{ onComplete, duration, waitForTransition, propertyName, owner }`. No CSS `animation` property is set — the element is simply removed (with optional transition wait).
- **Never schedule timers or animate elements directly outside AnimationEngine.**

### `Animator` (WAAPI Controller — `Animator.js`)
Wraps the Web Animations API with mid-flight interruption and `fill:forwards` cleanup. Each `PlaybackMitosisManager` owns one instance: `this._animator = new Animator()`.
- `play(el, keyframes, options)` — commits + cancels any previous animation on the element, then starts the new one (`fill: 'forwards'` always). Starting a new animation while one runs picks up from wherever the element visually is.
- `cancel(el)` — commits computed style then cancels the tracked animation for that element.
- `cancelAll()` — cancels all tracked animations, committing styles. **Call at both `morph()` and `unmorph()` entry points.**
- `releaseAll(el)` — cancels both in-progress (tracked) AND already-finished `fill:forwards` animations via `el.getAnimations()`. **Always call this before setting explicit inline styles** after an animation ends — otherwise the `fill:forwards` override silently wins and inline styles appear to have no effect.
- `static resolveEasing(varName, fallback)` — reads a CSS custom property to use as a WAAPI easing string. WAAPI `.animate()` calls cannot read CSS vars directly; use the literal `cubic-bezier(...)` value with a `// --ease-X` comment for traceability.

### `PlaybackMitosisManager` (`playback-mitosis.js`)
The main playback controller with the mitosis animation.
- **Critical layout constants** — these values are mathematically linked. Do not touch without recalculating the entire morph geometry:
  ```
  PLAYER_W = 340  SQUARE_H = 340  CONTROLS_H = 56  TOTAL_H = 406
  BUDDING_OVERLAP = 6  BUD_HEIGHT = 52  PINCH_GAP = 14  BRIDGE_PINCH_W = 14
  ```
- Centralized state object: `{ playState, currentId, currentQueueIdx, duration, sliderPos, queue[], shuffle, repeat, currentTrack: { title, artist, thumbnail } }`.
- Owns a `this._animator = new Animator()` instance for all WAAPI operations on the player container.
- Playback slider is driven by a RAF loop: `startRafLoop()` / `stopRafLoop()`. No `setInterval` for UI ticks.
- **Progress fill** uses `transform: scaleX(fraction)` + `transform-origin: left center` — never `width%`. This is zero-layout per RAF frame (pure compositor).
- **`morph()` grow phase** uses the FLIP technique: capture `getBoundingClientRect()` → instant layout change → compute `deltaY + clipBottom%` → WAAPI `transform + clipPath` animation. Zero layout recalculations during playback.
- **Queue panel** open/close both use WAAPI FLIP (transform-only). Layout is set once at final geometry; the animation plays a scale+translate inversion.
- **`will-change` on the player container**: `transform, clip-path, opacity` — never `width` or `height` (those are layout properties, not compositor).
- **`morph()` and `unmorph()` entry points** both call `this._animator.cancelAll()` before running any phase.
- **`_settlePlayer()`** calls `this._animator.releaseAll(container)` before setting explicit `clipPath`/`transform` inline styles — clears fill:forwards overrides.
- **`_onNavigate` handler** stored as `this._onNavigate` and removed in `destroy()`. Same pattern as `_onPopState`.
- **Membrane constraint:** `onShrink`, `onAbsorb`, `onPinch`, `onBud` callbacks intentionally use CSS transitions on layout properties (`top`, `height`, `width`). The SVG division membrane reads `getBoundingClientRect()` every RAF to draw its outline — it requires real computed dimensions, making FLIP impossible for these phases.
- **Thumbnail cascade:** `getThumbnailCandidates(track)` returns `[maxresdefault, hqdefault, normalized-local]`. `updateThumbnail()` iterates via `onerror` chaining — never assume the highest-res URL exists.
- **`_lastThemeKey`** — deduplication field (`'playState|trackId'` string). `_dispatchThemeEvent()` writes it before firing; `applyServerStatus()` reads it to skip redundant dispatches. Never reset it manually.

### `DivisionAnimator` (Cell-Division Primitive — `DivisionAnimator.js`)
Modular, self-contained animation controller for organic parent→child splits. Each instance encapsulates the full lifecycle: **divide** (bud → pinch → split → settle) and **absorb** (shrink → absorb → remove). Consumers create an instance with geometry options, then `await div.divide()` / `await div.absorb()`.
- **Constructor options:** `{ parent, child, target: { top, left?, width, height }, direction?, shellTarget?, shellAttribute?, budSize, budOverlap, budDuration, pinchGap, pinchWidth, pinchDuration, splitDuration, membrane?, childZIndex, onPhase, onSettled, onRemoved, owner, membraneOptions }`.
- **`direction`** — `'down'` (default) | `'up'` | `'left'` | `'right'`. Controls which edge the child buds from. An internal `AXIS_MAP` translates each direction into abstract axis properties (`mainPos`, `crossPos`, `mainSize`, `crossSize`, `parentEdge`, `sign`, `clipSide`, `membraneAxis`). **All phase logic is axis-agnostic** — no direction-specific branches in animation code.
  - `down`/`up` use `mainSize: 'height'`, `crossSize: 'width'`, membrane axis `'vertical'`.
  - `left`/`right` use `mainSize: 'width'`, `crossSize: 'height'`, membrane axis `'horizontal'`.
  - Negative directions (`up`/`left`) transition **both** `mainPos` and `mainSize` simultaneously during bud/absorb so the child grows/shrinks toward the parent edge (CSS `width`/`height` grow in the positive direction only).
- **Phase callbacks:** `onPhase(name, { parent, child, bridge, membrane })` fires on every phase entry — useful for revealing child content at the right moment (e.g. `split` → show player stage).
- **CSS transitions for bud/pinch/absorb** — membrane SVG reads `getBoundingClientRect()` every RAF, requires real layout dimensions.
- **WAAPI FLIP for split** — membrane is gone, pure GPU compositor (`transform + clipPath`). Cross-size animates via CSS transition (content needs reflow). Clip reveal uses `_buildClipPath()` which targets the correct `inset()` side for each direction.
- **Bridge element** — DOM div creating the hourglass neck between parent and child during pinch. For vertical divisions it's a horizontal strip at the parent's edge; for horizontal divisions it's a vertical strip. Membrane `buildConnectedMembranePath` (vertical) or `buildConnectedMembranePathHorizontal` (horizontal) draws through it. Created/removed internally.
- **Membrane element ordering** — `_membraneElements(child)` swaps `topElement/bottomElement` for reversed directions (`up`/`left`), so the membrane path builder always receives elements in spatial order (top-to-bottom or left-to-right).
- **Timer isolation:** uses dedicated `TIMER_PROP = '_divisionTimers'` so `abort()` never clears the owner's unrelated timers.
- **`shellTarget`** — separate from `parent`. Example: `parent` = `#bar-container` (shadow DOM), `shellTarget` = `<rolfsound-island>` host (for attribute-based CSS).
- **Child lifecycle:** caller creates the child element with content/styling. DivisionAnimator only manages positioning, DOM insertion (`document.body.appendChild`), animation, and removal.
- `abort()` — cancels WAAPI, clears `_divisionTimers`, removes membrane/bridge. Safe to call at any phase.
- `destroy()` — abort + null all refs. **Call in consumer's `destroy()` method.**

### `Cursor` (`Cursor.js`)
Custom magnetic cursor with context-ring morphing.
- Imports `AnimationEngine` — uses `AnimationEngine.schedule()` for the context morph timer (not raw `setTimeout`).
- All event handler refs stored in constructor: `this._renderBound`, `this._onMouseMove`, `this._onMouseLeave`, `this._onScroll`, `this._onContextOpen`, `this._onContextClose`.
- RAF stored as `this._rafId = requestAnimationFrame(this._renderBound)`. **Never call `requestAnimationFrame(fn.bind(this))` inline inside the RAF loop** — creates a new `Function` object every ~16ms (≈60 GC allocations/second).
- `destroy()` removes all listeners, calls `cancelAnimationFrame(this._rafId)`, and calls `AnimationEngine.clearScheduled(this, 'contextMorphTimer')`.

### `ContextMenuController` (Shell Pattern — `ContextMenuController.js`)
- **Zero hardcoded menu items.** The controller is pure infrastructure — it positions, renders, and closes the menu.
- Views contribute actions by listening to the `rolfsound-context-build` window event and pushing `{ id, label, action }` objects into `e.detail.items[]`.
- `_buildContext(sourceTarget)` exposes `{ activeView, selectedText, trackId, cardElement }` to action handlers.
- **Only suppress the native context menu when items actually exist.** Calling `e.preventDefault()` unconditionally would break right-click on inputs and text — build items first, then decide.
- **Visual design:** vertical pill (`width: 52px`, expands to `200px` on hover). Items have `.rs-context-item-icon` + `.rs-context-item-label` structure. Destructive actions use `danger: true` → class `rs-context-item--danger` (red). Text fades in with `transition-delay: 0.08s`.

### Reactive Theme System
Four modules implement the "light box" ambient theming — neutral when idle, vivid gradient when playing:

#### `ColorPaletteExtractor` (`ColorPaletteExtractor.js`) — Static
- `static async extract(srcUrl, cacheKey)` → `{ base, accent, contrast }` or `null`
- Draws image onto a 64×64 canvas, runs k-means++ (3 clusters, 12 iterations), assigns roles.
- Returns colors as `'R G B'` channel strings (not hex) so they compose with `rgba(var(--x) / 0.4)`.
- LRU cache (max 64 entries), keyed by `cacheKey`.
- Fails silently on `SecurityError` (CORS-tainted canvas) — returns `null`, caller cascades.

#### `PaletteNormalizer` (`PaletteNormalizer.js`) — Static
- `static normalize({ base, accent, contrast })` → normalized palette, same shape.
- Clamps: base → dark/desaturated (`l: 0.04–0.22`), accent → vibrant (`s: 0.40–0.90`), contrast → distinct hue (≥30° from accent).
- Prevents radioactive neon UI — always call this before passing raw palette to backdrop.

#### `ReactiveBackdropController` (`ReactiveBackdropController.js`)
- Creates 3 fixed DOM layers (`#rs-bg-base`, `#rs-bg-accent`, `#rs-bg-contrast`) at z-index 1/2/3 — behind all UI.
- `applyPalette(palette, key)` — starts a RAF loop that lerps each RGB channel frame-by-frame (CSS cannot interpolate `radial-gradient` strings). Uses `ease-in-out` quadratic.
- `applyNeutral(instant?)` — fades layers to opacity 0.
- Publishes `--rs-theme-base-rgb`, `--rs-theme-accent-rgb`, `--rs-theme-contrast-rgb`, `--rs-theme-intensity` on `:root`, updated every frame during transitions.
- **Do NOT use CSS `transition: background` on these layers** — it has no effect on gradient strings.

#### `NowPlayingThemeController` (`NowPlayingThemeController.js`)
- Instantiates `ReactiveBackdropController` internally. Boot: `new NowPlayingThemeController()` in `index.html`.
- Listens to `rolfsound-now-playing-changed`. Applies colors only when `state === 'playing'` — **any other state → `applyNeutral()`** (whitelist, not blacklist).
- Cascades cover URL candidates: `maxresdefault → hqdefault → local /thumbs/`. CORS fallback is automatic.
- `_preextractTrack(nextTrack)` — fire-and-forget pre-extraction while current track plays, so the next transition starts instantly with no extraction latency.
- **Race condition guard:** compares `_pendingKey` before and after every `await`. Stale results are silently discarded — never applied.

---

## Event Bus

All inter-module communication uses `window.dispatchEvent` / `window.addEventListener` with typed `CustomEvent`s. **Never pass direct object references or callbacks across module boundaries** — this preserves loose coupling and makes teardown trivial.

| Event                           | Emitter                    | Payload                                              | Consumer(s)               |
|---------------------------------|----------------------------|------------------------------------------------------|---------------------------|
| `rolfsound-navigate`            | Island                     | `{ tab }`                                            | Views, controllers        |
| `rolfsound-filter`              | Island                     | `{ filter }`                                         | Active view               |
| `rolfsound-search`              | Island                     | `{ query }`                                          | SearchController          |
| `rolfsound-search-results`      | SearchController           | `{ results[], tab }`                                 | Active view               |
| `rolfsound-library-mode-change` | Island                     | `{ mode: 'vinyl'\|'digital' }`                       | Library views             |
| `rolfsound-context-build`       | ContextMenuController      | `{ context, items[] }`                               | Active view (pushes items)|
| `rolfsound-now-playing-changed` | PlaybackMitosisManager     | `{ trackId, thumbnail, source, state, nextTrack }`   | NowPlayingThemeController |
| `rolfsound-theme-change`        | NowPlayingThemeController  | `{ palette, trackKey }`                              | Any reactive component    |

**Theme event rules:**
- `rolfsound-now-playing-changed` is dispatched **only** from `_dispatchThemeEvent()`, which is called from:
  1. `applyServerStatus()` — whenever the `playState|trackId` tuple differs from `_lastThemeKey`. This fires on every meaningful server state change: track start, pause, resume, idle. **No guard gate** — if the guard prevented a state update, the key hasn't changed, so no duplicate fires.
  2. `_applyOptimisticTrackChange()` — for immediate visual response on skip (before the server confirms).
- **Never call `_dispatchThemeEvent()` from `togglePlayPause()` or any other button handler.** Optimistic dispatch from button clicks causes inversion bugs when JS state diverges from server state after guard expiry. The ~600ms post-action poll (`setTimeout(() => this.pollStatus(), 600)`) is the intentional and accepted latency for backdrop transitions.
- **Never dispatch on every poll** — compare against `_lastThemeKey` first.

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

Easing token vocabulary — always use these in CSS transitions, never hardcode `cubic-bezier()` literals:
```css
--ease-standard:   cubic-bezier(0.32, 0.72, 0, 1)   /* smooth decel, general transitions */
--ease-emphasized: cubic-bezier(0.2, 0, 0, 1)        /* heavy decel, large surface morphs */
--ease-spring:     cubic-bezier(0.34, 1.28, 0.64, 1) /* slight overshoot, spring feel */
--ease-exit:       cubic-bezier(0.3, 0, 1, 1)        /* fast exit, dismiss/collapse */
--ease-snappy:     cubic-bezier(0.16, 1, 0.3, 1)     /* snappy enter, border-radius */
```
**WAAPI exception:** `.animate()` calls cannot read CSS vars at runtime. Use the literal `cubic-bezier(...)` value with a `// --ease-X` comment for traceability (e.g. `easing: 'cubic-bezier(0.32, 0.72, 0, 1)' // --ease-standard`).

Reactive theme tokens (published by `ReactiveBackdropController`, do not set manually):
```css
--rs-theme-base-rgb:     /* 'R G B' — dominant dark color */
--rs-theme-accent-rgb:   /* 'R G B' — vibrant accent */
--rs-theme-contrast-rgb: /* 'R G B' — second accent pole */
--rs-theme-intensity:    /* 0 → 1, animates during fade in/out */
```
Usage pattern: `rgba(var(--rs-theme-accent-rgb) / 0.4)` — the space-separated format is required for this CSS syntax.

### Event delegation rules
- **Web Components:** ONE listener on `shadowRoot`. Use `e.target.closest('.selector')` to identify the target. Never attach listeners to dynamic child elements.
- **Embedded view scripts (`<script type="module">` in HTML views):** Bind to the container or `document`. Same delegation rule applies.

---

## GPU Compositing Rules
These rules apply to all JS-driven animations (WAAPI and CSS transitions).

- **`will-change`** — only list `transform`, `clip-path`, and `opacity`. Never list `width`, `height`, `left`, or `top` — they are layout properties that cannot be composited.
- **Progress bars / fill indicators** — always use `transform: scaleX(fraction)` + `transform-origin: left center`, never `width: N%`. Changing `width` invalidates layout every frame; `scaleX` stays on the GPU compositor.
- **FLIP technique** (for large surface morphs like `morph()` grow phase): capture `getBoundingClientRect()` first → apply instant layout change → measure delta → WAAPI-animate an inverse `transform + clipPath` from the old position to the new. Zero per-frame layout recalculations.
- **WAAPI `fill: 'forwards'` cleanup** — finished `fill:forwards` animations stay active and override inline styles silently. Always call `this._animator.releaseAll(el)` before writing explicit inline styles in settle/cleanup callbacks.
- **Membrane exception:** `onBud`, `onPinch`, `onShrink`, `onAbsorb` callbacks in the mitosis strategy deliberately animate `top`, `height`, `width` via CSS transitions. The SVG division membrane reads `getBoundingClientRect()` every RAF to draw its outline, requiring real computed dimensions. FLIP is architecturally impossible here.

---

## Safety & Memory Leak Prevention
Every addition must include its teardown path. This is not optional.

- Store bound handler references explicitly: `this._onX = this._handleX.bind(this)` → used in both `addEventListener` and `removeEventListener`.
- Check `!element.isConnected` before applying any deferred DOM mutation.
- Call `AnimationEngine.clearScheduled(this)` in every `destroy()` / `disconnectedCallback()`.
- SQLite: always `conn.close()` in a `finally` block — no exceptions.
- `AbortController`: cancel pending fetches/SSE streams in `destroy()` before nulling references.
- **RAF loops:** store the RAF id (`this._rafId = requestAnimationFrame(this._renderBound)`). Call `cancelAnimationFrame(this._rafId)` in `destroy()`. **Never call `requestAnimationFrame(fn.bind(this))` inline inside the loop** — it creates a new `Function` object every ~16ms.
- **WAAPI cleanup:** call `this._animator.cancelAll()` at every `morph()` / `unmorph()` entry point. Call `this._animator.releaseAll(el)` before writing explicit inline styles in settle callbacks.
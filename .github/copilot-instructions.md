# Rolfsound 3D Vinyl Library - Global Copilot Instructions

## Identity
You are an expert Performance Engineer and Creative Developer specializing in vanilla WebGL (Three.js) and native Web Components. You write highly optimized, zero-dependency frontend code.

## Tech Stack Rules
1.  **NO FRAMEWORKS:** Do not use React, Vue, Svelte, or any Virtual DOM libraries. Use Vanilla JS, HTML, and CSS.
2.  **BACKEND:** The backend is Python (FastAPI). Do not suggest Node.js, Express, or npm packages for server logic.
3.  **3D ENGINE:** Three.js is used directly via ES Modules (`<script type="importmap">`).

## Core Principles & Patterns

### 1. WebGL & Three.js Performance
- Maintain 60fps at all costs.
- **Object Pooling:** Do not create or destroy 3D meshes continuously. We recycle a pool of `MAX_MESHES` (45) `VinylRecord` instances.
- **Zero Allocations in Loop:** Never use the `new` keyword (e.g., `new THREE.Vector3`) inside the `animate()` loop or the `VinylRecord.update()` method. Use pre-allocated global temporary variables (e.g., `tempV`).
- **Memory Leaks:** Always call `.dispose()` on unused textures, geometries, and materials. Use the project's `textureLRU` cache for cover art.
- **Fluidity:** Always use `THREE.MathUtils.lerp()` for animating position, rotation, and scale.

### 2. UI Architecture (RolfsoundIsland)
- **Web Components:** The main UI is a native Web Component (`<rolfsound-island>`) using Shadow DOM.
- **Mitosis Engine:** Temporary UI elements (search bars, close buttons) must be dynamically injected into the DOM using the `mitosis()` method and destroyed using `undoMitosis()`. Never hardcode temporary state buttons in the static HTML.
- **Event Delegation:** Bind event listeners to the `shadowRoot` and use `e.target.closest('.class')` to handle clicks. Do not attach individual listeners to dynamic buttons within the component.
- **Animations:** UI animations rely on CSS transitions (`width`, `height`, `transform`) and hardware acceleration (`translate3d`).

## Formatting Your Output
- **Safety First:** If you suggest adding an event listener, a timeout, or a DOM element, you must also provide the teardown logic to prevent memory leaks (e.g., handling the `!isConnected` state).
# Rolfsound — Refactor Modular em Fases (Apple-Inspired Vanilla Architecture)

## Contexto

O Rolfsound tem **dois repositórios locais**:
- **`c:/Users/lucbo/Documents/rolfsound/`** — core de áudio (Python + `http.server` stdlib + PyAV + sounddevice, porta 8765). Pipeline em 3 camadas desacopladas: worker thread de comando → decode daemon → callback do PortAudio. `POST /volume` já existe, `POST /pitch` **não**. Event bus interno publica em `deque(maxlen=500)` lido via `GET /events?since=N` (polling).
- **`c:/Users/lucbo/Documents/rolfsound-web/`** — control/UI (FastAPI + vanilla JS, porta 8766). Conversa com o core via HTTP (`utils/core_client.py`).

Roda num Raspberry Pi com recursos limitados; a prioridade absoluta é o DSP. A arquitetura já tem fundamentos sólidos — processos separados, frontend vanilla com Web Components, SSE para monitor e search — mas apresenta gargalos reais que violam os 4 pilares:

- **Duplo polling** cria drift e pressão de GIL: frontend pede `/api/status` a cada 1.5s ([playback-mitosis.js:1712-1732](static/js/playback-mitosis.js)) enquanto o backend polla `core/events` a cada 2s ([utils/event_poller.py:28](utils/event_poller.py)).
- **God components**: [playback-mitosis.js](static/js/playback-mitosis.js) (2344 LOC) concentra estado, DOM, animação, fetch e lógica de seek. [AnimationEngine.js](static/js/AnimationEngine.js) (1576 LOC) e [RolfsoundIsland.js](static/js/RolfsoundIsland.js) (1264 LOC) sofrem do mesmo problema.
- **Controles inline**: seek-bar, play/pause, shuffle e repeat são template strings com `style="..."` embutido em [playback-mitosis.js:864-977](static/js/playback-mitosis.js) — sem Shadow DOM, sem CSS co-localizado.
- **Fetches espalhados**: intents como `/api/seek`, `/api/play`, `/api/queue/*` vivem em múltiplos arquivos sem ponto único de auditoria, throttling ou reconciliação.
- **CSS global monolítico** em [static/css/global.css](static/css/global.css) mistura tokens (bom) com regras de componente (ruim).
- **Inexistência de controles** de volume e de pitch/BPM — nem UI, nem endpoints no core.

O objetivo é evoluir a arquitetura — sem big bang, em fases reversíveis — para atingir os 4 pilares: vanilla-first, isolamento Core↔UI, modularidade por componente e comunicação push-based via WebSocket.

---

## Pilar 1 — Nova Árvore de Diretórios (aditiva, não realocação em massa)

```
rolfsound-web/
├── api/
│   ├── app.py                          (existente — monta WS no lifespan)
│   ├── routes/                         (HTTP routes atuais permanecem como fallback)
│   ├── status_enricher.py              NOVO — extrai _enrich_status de app.py
│   └── ws/                             NOVO
│       ├── endpoint.py                 FastAPI WebSocket em /api/ws
│       ├── connection_manager.py       fan-out + backpressure (espelha MonitorAccumulator)
│       ├── intent_router.py            intent.* → core_client.*
│       └── state_broadcaster.py        EventPoller → frames WS
│
├── contracts/                          NOVO
│   └── ws_protocol.json                single source of truth do envelope
│
├── static/
│   ├── css/
│   │   ├── tokens.css                  NOVO — tokens extraídos
│   │   └── global.css                  (trimado — só resets de página)
│   │
│   ├── js/
│   │   ├── channel/                    NOVO
│   │   │   ├── RolfsoundChannel.js     abstração transporte (WS + polling fallback)
│   │   │   ├── ChannelReconnector.js   backoff exponencial
│   │   │   └── IntentQueue.js          buffer offline
│   │   │
│   │   ├── core/                       NOVO
│   │   │   ├── RolfsoundControl.js     classe base abstrata para Web Components
│   │   │   └── adoptStyles.js          cache de CSSStyleSheet p/ Shadow DOM
│   │   │
│   │   ├── components/                 NOVO — um folder por controle
│   │   │   ├── seek-bar/seek-bar.{js,css}
│   │   │   ├── play-button/play-button.{js,css}
│   │   │   ├── skip-buttons/skip-buttons.{js,css}
│   │   │   ├── shuffle-toggle/shuffle-toggle.{js,css}
│   │   │   ├── repeat-toggle/repeat-toggle.{js,css}
│   │   │   ├── queue-button/queue-button.{js,css}
│   │   │   └── volume-slider/volume-slider.{js,css}   (Fase 6)
│   │   │
│   │   ├── playback/                   NOVO (Fase 5)
│   │   │   ├── MitosisStateMachine.js
│   │   │   ├── ThumbnailCrossfader.js
│   │   │   └── PlayerShell.js
│   │   │
│   │   └── [arquivos atuais permanecem e diminuem a cada fase]
│   │
│   └── ...
└── dashboard/                          (sem mudanças estruturais)
```

---

## Pilar 2 — Protocolo WebSocket (substitui polling de `/api/status`)

**Decisão de arquitetura**: o WebSocket vive **apenas no lado web/control** (FastAPI torna trivial). O core **não** ganha WS — migrar seu `http.server` stdlib para asyncio/websockets adicionaria dependência e risco de regressão no callback de áudio, contradizendo "áudio é prioridade". O `state_broadcaster` no web continua fazendo bridge entre `EventPoller` (que polla `core/events` a cada 2s) e os clientes WS conectados.

**Endpoint único**: `GET /api/ws` (upgrade) no FastAPI. SSE existentes (`/api/monitor/stream`, `/api/search`) **permanecem** — fluxos especializados de alta frequência (samples 20ms, streaming de busca); misturá-los forçaria regras de backpressure do canal de controle sobre dados de áudio.

**Envelope**:
```json
{ "type": "<namespace>.<name>", "payload": { ... }, "id": "<uuid?>", "ts": <unix-ms> }
```

**Namespaces**:
- `state.*` — servidor → cliente (estado autoritativo, idempotente)
- `event.*` — servidor → cliente (notificação one-shot)
- `intent.*` — cliente → servidor (comando)
- `ack.*` — servidor → cliente (resposta correlacionada ao `id` do intent)

**Frames server → client**:

| type | payload | quando |
|---|---|---|
| `state.playback` | snapshot completo (mesmo shape de `/api/status`) | conexão, eventos core, throttle ≤ 4 Hz |
| `state.queue` | fila + current_index | queue mutada |
| `event.track_changed` | `{track_id, title, artist, thumbnail}` | edge-trigger |
| `event.track_finished` | `{track_id, filepath}` | edge-trigger |
| `event.progress` | `{position, duration, position_updated_at}` | 1 Hz tocando |
| `ack.<intent_type>` | `{ok, error?}` | resposta a intent com id |

**Intents client → server**: `intent.play`, `intent.pause`, `intent.skip {direction}`, `intent.seek {position}`, `intent.shuffle.set {enabled}`, `intent.repeat.set {mode}`, `intent.volume.set {value}`, `intent.queue.{add,remove,move,clear}`, `intent.ping`.

**Backpressure**: `ConnectionManager` mantém `asyncio.Queue(maxsize=32)` por cliente. Queue cheia → descarta o frame `state.*` mais antigo (coalescing é seguro em snapshot); **nunca** descarta `event.*`. Padrão idêntico ao já provado em [utils/monitor_accumulator.py:57-60](utils/monitor_accumulator.py).

**Reconexão**: backoff exponencial 250ms → 500ms → 1s → 2s → 4s → 8s cap. Após reconexão, servidor envia `state.playback` fresco. Cliente mantém `IntentQueue` (cap 16) durante offline, flush ao voltar. Heartbeat: ping WS a cada 20s; drop se 10s sem pong.

**Integração backend**: `state_broadcaster` registra `poller.on("*", ...)` no wildcard já suportado em [event_poller.py:103](utils/event_poller.py). `intent_router` é tabela de dispatch única ligando `intent.seek → core_client.seek`, etc. — remove os fetches ad-hoc espalhados. Rotas HTTP atuais permanecem como fallback de transporte.

**Integração frontend**:
```js
window.rolfsoundChannel = new RolfsoundChannel({ url: '/api/ws', fallback: 'polling' });
rolfsoundChannel.on('state.playback', snapshot => {...});
rolfsoundChannel.send('intent.seek', { position: 42.0 });
```

---

## Pilar 3 — Padrão Canônico de Web Component

**Layout por componente** (co-localização):
```
static/js/components/<name>/
  ├── <name>.js     # extends RolfsoundControl
  └── <name>.css    # Shadow DOM encapsulated
```

**Classe base** [static/js/core/RolfsoundControl.js](static/js/core/RolfsoundControl.js):
```js
class RolfsoundControl extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._subs = [];
  }
  connectedCallback()    { this.render(); this.subscribe(); }
  disconnectedCallback() { this._subs.forEach(u => u()); this._subs = []; }
  on(type, fn)           { this._subs.push(window.rolfsoundChannel.on(type, fn)); }
  send(type, payload)    { window.rolfsoundChannel.send(type, payload); }
}
```

**Injeção de CSS**: `adoptStyles` cacheia o `CSSStyleSheet` no módulo — toda instância de `<rolfsound-seek-bar>` reusa o mesmo objeto (zero reparse, crítico no RPi).

**Regra dura de acesso**: componente lê APENAS de `window.rolfsoundChannel` e dos próprios atributos. **Não** toca `window.playbackStore._state`, `window.mitosis.state`, nem DOM de outros componentes.

**Memória no RPi**: `disconnectedCallback` garante desinscrição; replica o padrão já correto em [RolfsoundIsland.js:57-62](static/js/RolfsoundIsland.js).

---

## Pilar 4 — Rollout em 6 Fases Incrementais

Cada fase é **independentemente aplicável, testável e reversível**.

### Fase 0 — Fundações (zero mudança visível)
**Objetivo**: aterrar esqueleto — canal, classe base, pastas — com polling ainda por baixo.

**Criar**: `static/js/channel/RolfsoundChannel.js` (wrap inicial do `fetch('/api/status')`), `IntentQueue.js`, `ChannelReconnector.js` stubs, `static/js/core/RolfsoundControl.js`, `adoptStyles.js`, `static/css/tokens.css` (cópia dos `:root` de [global.css](static/css/global.css) — duplicação temporária é OK), `contracts/ws_protocol.json`.

**Modificar**: [dashboard/index.html](dashboard/index.html) carrega `RolfsoundChannel` **antes** de `playback-mitosis.js`. [playback-mitosis.js:1712](static/js/playback-mitosis.js) `pollStatus()` passa a usar `window.rolfsoundChannel` — comportamento idêntico.

**Verificação**: boot normal, DevTools Network mostra os mesmos requests, `typeof window.rolfsoundChannel === 'object'`.

**Rollback**: reverter 2 arquivos; pastas novas ficam como dead code.

---

### Fase 1 — Transporte WebSocket
**Objetivo**: endpoint WS ativo, canal prefere WS com fallback automático para polling.

**Criar**: `api/ws/connection_manager.py` (copia pattern de [monitor_accumulator.py:73-79](utils/monitor_accumulator.py)), `api/ws/state_broadcaster.py` (registra em `poller.on("*", ...)`, transforma eventos core em frames), `api/ws/intent_router.py`, `api/ws/endpoint.py` (`@app.websocket("/api/ws")`).

**Modificar**: [api/app.py:303](api/app.py) `create_app()` — monta WS e starta broadcaster no lifespan. Extrair `_enrich_status` de [api/app.py:218-300](api/app.py) para `api/status_enricher.py` (single source of truth reusada por HTTP e WS). `RolfsoundChannel.js` implementa transporte WS com reconexão.

**Reuso**: [event_poller.py:103](utils/event_poller.py) wildcard `on("*")` existente; `core_client.get_status()` reusada sem alteração.

**Verificação**: `wscat -c ws://localhost:8766/api/ws` retorna `state.playback` < 500ms. Matar core → fallback para polling transparente. RSS do Python no RPi permanece ≤ baseline +5MB após 30min.

**Rollback**: `localStorage.setItem('rolfsound.transport','polling')` força fallback; endpoint WS fica ocioso.

---

### Fase 2 — PoC: `<rolfsound-seek-bar>` (controle existente, maior valor didático)

**Por que seek-bar e não shuffle/volume**:
- Exercita todos os eixos da nova arquitetura: bidirecional (lê `state.playback` + `event.progress`, envia `intent.seek`), stateful, alta frequência (1 Hz tick + RAF dead-reckoning), drag interativo, já tem padrão de optimistic update em [playback-mitosis.js:2287-2289](static/js/playback-mitosis.js).
- Shuffle é toggle booleano — trivial demais para validar o padrão.
- Volume exigiria mexer no rolfsound-core antes (endpoint `POST /volume` não existe) + UI nova = duplo risco. Reservado para Fase 6.

**Objetivo**: substituir `#progress-bar` + `#progress-fill` + `#current-time` + `#total-time` de [playback-mitosis.js:864-895](static/js/playback-mitosis.js) por `<rolfsound-seek-bar></rolfsound-seek-bar>`.

**Criar**:
- `static/js/components/seek-bar/seek-bar.js` — extende `RolfsoundControl`, subscreve `state.playback` e `event.progress`, envia `intent.seek`, dead-reckoning copiado de [PlaybackStateStore.js:86-89](static/js/PlaybackStateStore.js), emite click + drag.
- `static/js/components/seek-bar/seek-bar.css` — inline styles de [playback-mitosis.js:867-893](static/js/playback-mitosis.js) migrados.

**Modificar**: [playback-mitosis.js](static/js/playback-mitosis.js) — remove `handleSeek` (linha 2273), entries `dom.progressBar`/`progressFill`/`currentTime`/`totalTime`, e update de `progressFill.style.transform` dentro do RAF loop. Net: ~150 LOC removidas.

**Reuso**: dead-reckoning existente em `PlaybackStateStore`; tokens `--color-progress-track`, `--color-progress-fill`, `--font-mono` já em [global.css](static/css/global.css).

**Verificação**: diff visual pixel-a-pixel na região 340×12. Click → frame `intent.seek` visível no inspector WS. Drag → fill otimista imediato, reconcilia com `state.playback` ao soltar. Trocar de view → `disconnectedCallback` roda, zero vazamento de listener (`getEventListeners(document)`).

**Rollback**: deletar 2 arquivos do componente; restaurar 2 blocos de diff em `playback-mitosis.js`.

---

### Fase 3 — `<rolfsound-play-button>` + `<rolfsound-skip-buttons>`
Criar os dois componentes. Remover `togglePlayPause`, `skipBack`, `skipForward` e wiring `dom.btnPlayPause/btnSkipBack/btnSkipFwd` de [playback-mitosis.js:927-944](static/js/playback-mitosis.js). Classe `.playback-control-btn` de [global.css](static/css/global.css) migrada via `adoptStyles` ou shared `components/shared/button.css`. ~80 LOC removidas.

---

### Fase 4 — `<rolfsound-shuffle-toggle>` + `<rolfsound-repeat-toggle>` + `<rolfsound-queue-button>`
Conclui a migração do pill de controles. Handlers `toggleShuffle`, `toggleRepeat`, `toggleQueue` de [playback-mitosis.js:1608-1636](static/js/playback-mitosis.js) deletados. Intents mapeiam 1:1 a `core_client.queue_repeat()` e `queue_shuffle()` em [utils/core_client.py:147-148](utils/core_client.py).

---

### Fase 5 — Quebra do god class `playback-mitosis.js`
Com controles externalizados, o que resta é (a) state machine de morph, (b) thumbnail crossfade, (c) RAF loop que agora só atualiza tint. Extrair em `static/js/playback/MitosisStateMachine.js`, `ThumbnailCrossfader.js`, `PlayerShell.js`. [playback-mitosis.js](static/js/playback-mitosis.js) vira bootstrap de ~200 LOC.

`AnimationEngine`, `DivisionAnimator`, `Animator`, `MiniMorphAnimator` permanecem sem mudanças.

**Gate de segurança**: esta é a ÚNICA fase não puramente aditiva. Feature flag `playback_mitosis_v2` em `config.json`; manter arquivo antigo por um release antes de remover.

---

### Fase 6 — Novo controle: `<rolfsound-volume-slider>` (prova do padrão)
Demonstra que novo controle surge sem tocar JS existente — apenas uma pasta de componente + uma linha em `intent_router.py` + uma linha de template.

**Vantagem**: `POST /volume {"volume": 0..1}` **já existe no core** em [services/playback_service.py:289-310](../../rolfsound/services/playback_service.py) com clamp [0,1] e aplicação in-place no callback (linha 375). Volume já aparece em `GET /status.playback.volume`. Zero trabalho no core.

**Criar**: `static/js/components/volume-slider/volume-slider.{js,css}`. Adicionar `core_client.volume(value)` em [utils/core_client.py](utils/core_client.py) (async helper chamando `_post("/volume", {"volume": value})`). Adicionar case `intent.volume.set` em `api/ws/intent_router.py` → `core_client.volume(payload.value)`.

**Modificar**: [playback-mitosis.js](static/js/playback-mitosis.js) template ganha uma linha: `<rolfsound-volume-slider></rolfsound-volume-slider>`.

**Fora de escopo deste plano — pitch/BPM**: o core não tem pitch-shifter nem time-stretcher hoje. Implementar exigiria ou (a) adicionar filter graph ao `av.AudioResampler` no decode loop, ou (b) integrar `pyrubberband`/`librosa` (librosa é ~300MB — proibitivo no RPi). Isso é um projeto próprio, com testes de fidelidade de DSP, não parte do refactor de arquitetura.

---

## Arquivos Críticos a Modificar

| Arquivo | Razão |
|---|---|
| [api/app.py](api/app.py) | monta WS, lifespan do broadcaster, extrai `_enrich_status` |
| [utils/event_poller.py](utils/event_poller.py) | fonte dos eventos que o broadcaster assina |
| [utils/core_client.py](utils/core_client.py) | adiciona `volume()` (Fase 6); ponto único de I/O com core |
| [static/js/playback-mitosis.js](static/js/playback-mitosis.js) | diminui a cada fase; split final na Fase 5 |
| [static/js/PlaybackStateStore.js](static/js/PlaybackStateStore.js) | re-ligado para assinar `RolfsoundChannel` |
| [static/js/RolfsoundIsland.js](static/js/RolfsoundIsland.js) | subscrever canal direto; largar `playbackStore` após Fase 1 |
| [static/js/RolfsoundMiniplayer.js](static/js/RolfsoundMiniplayer.js) | mesmo: migrar para subscriptions do canal |
| [dashboard/index.html](dashboard/index.html) | bootstrap do canal, imports dos módulos de componente |
| [static/css/global.css](static/css/global.css) | extrair tokens → `tokens.css` |
| [api/routes/playback.py](api/routes/playback.py) | permanece como fallback; validar contrato bate com `intent_router` |
| [utils/monitor_accumulator.py](utils/monitor_accumulator.py) | referência de implementação para `connection_manager` |
| **Novo**: `api/ws/connection_manager.py` | fan-out com backpressure |
| **Novo**: `api/ws/state_broadcaster.py` | ponte EventPoller → WS |
| **Novo**: `static/js/channel/RolfsoundChannel.js` | abstração transporte |

---

## Oportunidades de Reuso (não reescrever)

- **`EventPoller.on("*", ...)`** wildcard em [utils/event_poller.py:103-107](utils/event_poller.py) — broadcaster hook.
- **`core_client.get_status()` + `_enrich_status()`** — extrair para função compartilhada.
- **Padrão de subscribe/unsubscribe por fila** em [monitor_accumulator.py:73-79](utils/monitor_accumulator.py) — copiar tal qual para `ConnectionManager`.
- **`PlaybackStateStore._deadReckonedPos`** em [PlaybackStateStore.js:86-89](static/js/PlaybackStateStore.js) — reusado pelo seek-bar.
- **`AnimationEngine.schedule(this, fn, delay, tag)`** — já resolve retries memory-safe no RPi; reusar em `IntentQueue.flush`.
- **`MiniMorphAnimator`, `DivisionAnimator`, `Animator`, `MiniBirthAnimator`** — zero mudanças.
- **Rotas HTTP atuais (`/api/seek`, `/api/play`, `/api/queue/*`)** — permanecem como fallback.
- **CSS custom properties** em [global.css](static/css/global.css) — movidas para `tokens.css`, adotadas via `adoptStyles`.

---

## Verificação End-to-End

**Por fase**:
- **Fase 0**: boot OK; Network mostra `/api/status` a cada 1.5s; `typeof window.rolfsoundChannel === 'object'`.
- **Fase 1**: `wscat -c ws://localhost:8766/api/ws` retorna `{"type":"state.playback",...}` em < 500ms; frame WS por evento core em vez de polling; matar core → fallback automático; restart core → reconnect < 2s.
- **Fase 2**: click/drag no seek-bar emite `intent.seek` com `ack` correlacionado; `document.querySelector('rolfsound-seek-bar').shadowRoot` tem exatamente um sheet adotado.
- **Fase 3–4**: cada toggle emite um intent e um ack; estado do core (`status.shuffle`, `status.repeat_mode`, `status.queue.tracks.length`) reflete em um RTT.
- **Fase 5**: frame-timing da animação mitose idêntico ao baseline (±1 frame em DevTools Performance).
- **Fase 6**: drag do volume; `curl http://localhost:8765/status | jq .playback.volume` reflete em < 200ms.

**Checks específicos do RPi**:
- `top -b -n 1 -p $(pidof python)` — CPU% ≤ baseline + 3pp após Fase 1 (WS idle < HTTP polling).
- `cat /proc/$(pidof python)/status | grep VmRSS` — 30min dashboard aberto, memória não cresce > 10MB acima do steady state.

---

## Lado Core (`Documents/rolfsound/`) — o que muda

**Nada estrutural.** O core permanece como está:
- `http.server` stdlib (não migrar para asyncio)
- Event bus interno + `deque(maxlen=500)` em [core/event_log.py](../../rolfsound/core/event_log.py) continua sendo a fonte de eventos
- `POST /volume` já existe e será reusado na Fase 6
- Pipeline de 3 camadas (control plane → decode → callback PortAudio) **intocada**

**Única mudança opcional** (não requerida pelas fases 0-6): se no futuro quisermos reduzir latência percebida de eventos (hoje 2s de polling do `EventPoller`), podemos adicionar um `GET /events/stream` SSE no core em uma thread daemon separada, consumindo do event bus. Isso fica como upgrade futuro isolado, não bloqueia o refactor do lado web.

---

## Riscos & Mitigações

1. **WiFi cai no RPi durante playback** → reconexão com backoff + re-snapshot obrigatório de `state.playback` no reconnect. Nunca mutar estado crítico otimisticamente durante reconexão.
2. **GIL pressure no broadcaster** (mesmo sintoma do incidente 503 documentado em [core_client.py:22](utils/core_client.py)) → broadcaster reusa o `httpx.AsyncClient` persistente e roda no event loop do uvicorn; `EventPoller` continua sendo o único holder de GIL adicional. Não introduzir nova thread de polling.
3. **Backpressure com cliente em sleep** → `asyncio.Queue(maxsize=32)` drop-oldest em `state.*`, nunca em `event.*`. Pattern já provado em [monitor_accumulator.py:57-60](utils/monitor_accumulator.py).
4. **Reparse de CSS por instância no RPi** → `adoptStyles` com cache por módulo; toda `<rolfsound-seek-bar>` adota o MESMO objeto `CSSStyleSheet`.
5. **Regressão da animação na Fase 5** → única fase não-aditiva; feature flag `playback_mitosis_v2` + ambos arquivos coexistem por um release.
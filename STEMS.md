# STEMS — Fase 2: reprodução multipista ("Stem Ready")

Plano de implementação fechado em 2026-07-03 (decisões do usuário via sessão de
design). Cobre **dois repositórios**: este (`rolfsound-web`) e o core
(`./rolfsound-core`, branch `debug_sse`). A fase 1 (catalogar + UI)
já está pronta — ver `api/routes/stems.py` e `static/js/stems.js`.

---

## 1. O modelo (decisões de produto — não rediscutir)

- **"Stem" é uma faixa-variação separada**, não um "modo" da original.
  Ela nasce dos sidecars enviados na gaveta e entra no **grupo de versões** da
  original (rótulo `Stems`, editável pela feature de versões). Não existe
  toggle de fonte nem troca ao vivo master↔stems.
- **Tocar a variação = tocar multipista, sempre** — de qualquer superfície
  (gaveta de versões, fila, playlist). Tocar a original = master, sempre.
- **Criação automática na 2ª camada**: ao completar 2 camadas na gaveta a
  variação nasce sozinha (toast avisa). Cair para <2 camadas **desfaz a
  variação automaticamente**.
- **Original limpa**: badge de 4 pontos e lanes pertencem só à variação. Na
  original, o botão Stems do Remixer vira só "gerenciar camadas" (abre a
  gaveta). A original não sinaliza stems no Acervo.
- **Lanes sempre visíveis** no Remixer quando a faixa carregada é a variação;
  mudo/solo/gain são **ao vivo** (chegam ao core).
- **Toggle nas Configurações**: "Manter mix de stems ao trocar de faixa"
  (padrão: **resetar** — mesmo espírito do `reset_on_track_change` do remix).
- **Fallback gracioso**: se <2 stems válidos no disco na hora do play, a
  variação toca o master da original (a soma em ganho cheio soa igual ao
  master, então nada quebra de forma audível).

## 2. Arquitetura do fluxo

```
UI (stems.js)                       web (FastAPI)                     core (rolfsound)
─────────────                       ─────────────                     ────────────────
tocar variação V ────────────────▶  POST /api/play {track_id: V}      POST /play
                                      V.stem_source_id → X              {filepath, track_id,
                                      resolve paths de track_stems(X)    stems:{role:abspath}}
                                      (abs, exists, ≥2 senão fallback)      │
                                                                            ▼
                                                                      decode 4 arquivos em lockstep
                                                                      → StemMixer (ganhos+rampa)
                                                                      → RemixEngine (pitch/tempo)
                                                                      → ring buffer → sinks
mudo/solo/fader (debounce 120ms) ─▶ POST /api/remix/stems ─────────▶  POST /stems/mix (ao vivo)
rolf:status ◀────────────────────── GET /api/status ◀───────────────  /status + bloco stems
```

Pontos estruturais:

- **Os stems viajam com a entrada da fila**: `queue/add` de uma variação leva
  o dict `stems` junto, para `play_next`/repeat/`play_at_index` tocarem
  multipista **sem a web no meio** (o core não tem banco).
- O mix mixado passa pelo `RemixEngine` existente ⇒ pitch/tempo continuam
  funcionando sobre stems de graça.
- Web e core compartilham o filesystem (mesmo padrão do master hoje: a web
  resolve caminho absoluto, o core abre direto). O endpoint
  `GET /api/library/{id}/stems/{role}/download` continua existindo mas não é
  usado pelo core.

## 3. Contratos novos

### 3.1 Banco (web, `db/database.py`)

- `ALTER TABLE tracks ADD COLUMN stem_source_id TEXT` (migração idempotente
  via `PRAGMA table_info`, como as demais).
- A variação V de uma faixa X:
  - `id = "{X.id}::stems"` (determinístico ⇒ criação idempotente; seguro com
    `encodeURIComponent`/`CSS.escape` já usados na UI).
  - `stem_source_id = X.id`; `version_label = 'Stems'`;
    `file_path = X.file_path` (**fallback**: tocá-la "cru" toca o master).
  - title/artist/album/bpm/key/duration/thumbnail/source/status copiados de X.
  - Membro do grupo de versões de X (cria o grupo se não existir; **primary
    continua X**). Como não-primária, V não vira row visível no Acervo — vive
    na gaveta "Explorar versões". Nenhum rerender de Acervo é necessário.
- `track_stems` **continua keyed por X** (sidecars `{X.id}.stem.{role}.ext`
  não mudam de nome). V referencia via `stem_source_id`.
- **Backfill** na subida do app: para cada faixa com ≥2 stems e sem variação,
  criar V + grupo (idempotente).

### 3.2 API do core (novidades)

| Rota | Corpo | Efeito |
|---|---|---|
| `POST /play` | + `stems: {role: path}` (2–4), + `position: float` opcional | sanitiza/valida `exists` por path; <2 válidos ⇒ toca só `filepath`. `position` = seek inicial |
| `POST /queue/add` | + `stems: {role: path}` opcional | stems ficam no track dict da fila |
| `POST /stems/mix` | `{levels?: {role: 0..1}, mutes?: {role: bool}, solos?: {role: bool}}` (parcial) | ganhos ao vivo no mixer |
| `POST /stems/keep_mix` | `{enabled: bool}` | flag manter mix na troca de faixa (default false = resetar) |
| `GET /status` | — | + bloco `stems: {active, roles, levels, mutes, solos, keep_mix_on_track_change}` |

Evento novo: `Stems.CHANGED = "stems_changed"` (event_log/SSE, payload = bloco
stems). Ganho efetivo por papel: `0 se mute ou (existe solo e não é solo),
senão level`.

### 3.3 API do web (novidades)

- `POST /api/play` — quando `track_id` é variação (`stem_source_id` não
  nulo): resolve stems de X, filtra existentes, ≥2 ⇒ envia `stems` ao core;
  senão play normal. Resposta ganha `"stems": true|false` (UI toasta o
  fallback). `filepath` enviado continua sendo o master (identidade +
  fallback no core).
- `POST /api/queue/add` — idem: variação leva `stems` resolvidos.
- `POST /api/remix/stems` (em `playback.py`) — repassa a `/stems/mix`.
- `GET /api/status` — repassa bloco `stems`; **corrigir precedência em
  `_enrich_status`** (ver §5.3).
- `POST /api/settings` — nova chave `stems_keep_mix: bool`: persiste no
  `config.json` da web e repassa ao core (`/stems/keep_mix`). Reenviar no
  startup (lifespan) — o core guarda só em runtime.

## 4. Implementação — CORE (`rolfsound-pack/rolfsound`)

### 4.1 `services/stem_mixer.py` (novo)

- `StemMixParams` (frozen dataclass): levels/mutes/solos imutáveis.
- `StemMixer`:
  - Plano de controle (engine worker): `set_mix(levels, mutes, solos)`
    parcial, `reset()`, `get_params()` — lock só na troca da referência
    (mesmo padrão do `RemixEngine`).
  - Plano de dados (decode thread): `mix(blocks: dict[role, ndarray]) →
    ndarray` — soma com **rampa anti-click por bloco**: ganho corrente por
    papel caminha ao alvo via `np.linspace` quando difere (padrão já usado em
    `_render_sinks`).

### 4.2 `services/playback_service.py`

- `play(filepath, seek_to=0.0, stems=None)`:
  - `stems=None` + mesmo arquivo (caso do seek) ⇒ **preserva**
    `self._current_stems`; troca de faixa ⇒ limpa stems e, se
    `keep_mix_on_track_change` desligado, `mixer.reset()` + publica
    `Stems.CHANGED`.
  - `seek()` passa `stems=self._current_stems`.
- **Refactor do decode loop** em duas fontes com a mesma interface
  (`open() → duration_s`, iterador de chunks float32 `(n, 2)` @48k,
  `close()`):
  - `_SingleSource` — o caminho atual, byte a byte idêntico.
  - `_StemsSource` — N containers/resamplers:
    - **Seek alinhado (fase!)**: seek para `max(0, t-1.0s)` e descarta
      amostras até `t` usando o pts do primeiro frame decodificado, por stem.
    - **Lockstep**: FIFO por papel; bloco de mix fixo (~2048 frames); EOF de
      um stem ⇒ zero-pad; termina quando todos EOF e FIFOs drenados;
      `duration_s = max` das durações.
    - Cada bloco passa por `mixer.mix()` antes do yield.
  - Loop principal comum (inalterado na semântica): session guard, stop/pause,
    `remix.process()`, backpressure, `_audio_buf.write`, position/tick, drain,
    `_advance`.
- `set_stem_mix(...)` → mixer + `state.update_stems` + `Stems.CHANGED`.
- `set_stems_keep_mix(enabled)`.

### 4.3 Demais arquivos do core

- `core/system_state.py` — `StemsState {active, roles, levels, mutes, solos,
  keep_mix_on_track_change}` + `update_stems`.
- `core/events.py` — classe `Stems` com `CHANGED`.
- `engine.py` — cmd `play` repassa `stems`/`position`; novos cmds
  `set_stem_mix`, `set_stems_keep_mix`; `play_next`/`play_at_index` repassam
  `t.get("stems")` do track dict da fila ao `playback.play`.
- `services/queue_service.py` — `add_track(..., stems=None)` guarda no dict.
- `services/api_service.py` — rotas do §3.2; `_handle_play` valida paths de
  stems (sanitize + exists, ignora papel inválido, <2 ⇒ só master); `/status`
  monta o bloco; subscribe `Stems.CHANGED` → event_log (SSE).

### 4.4 Testes (core, `tests/`)

- `test_stem_mixer.py` — ganho efetivo (mute/solo/level), rampa (sem
  descontinuidade > passo), soma correta com arrays sintéticos, zero-pad.
- Rodar `test_playback_service.py` existente (regressão do refactor).
- `audio_tests/`: gerar 4 wavs senoidais e verificar que o mix soma (e que
  solo isola a frequência certa) — teste de fonte sem hardware.

## 5. Implementação — WEB (`rolfsound-web`)

### 5.1 `db/database.py`

- Migração `stem_source_id` + helpers: `get_stem_variant(conn, source_id)`,
  `create_stem_variant(conn, source_track) → V` (copia campos, cria/junta
  grupo), `delete_stem_variant`, `list_stem_variants` (p/ backfill e cascade).

### 5.2 `api/routes/stems.py`

- No início das rotas: se `track_id` é variação, **redirecionar para
  `stem_source_id`** (a gaveta aberta na V gerencia os sidecars de X; V nunca
  ganha variação própria).
- `upload_stem`: após o upsert, se agora ≥2 papéis e não existe variação ⇒
  criar V + grupo. Resposta ganha
  `variant: {created, id, group_id} | null`.
- `delete_stem`: se caiu para <2 ⇒ deletar V. Resposta ganha
  `variant: {removed, id} | null`.
- Backfill de variações no startup (chamar de `api/app.py` lifespan, junto do
  `scan_and_reconcile`).

### 5.3 `api/app.py`

- `_enrich_status`: **inverter a precedência** — `now_playing.track_id` (o
  core sabe qual faixa toca) ganha do lookup por `file_path` (ambíguo agora
  que V compartilha o path do master). Repassar o bloco `stems` cru.
- Lifespan: reenviar `stems_keep_mix` ao core na subida.
- Rota library DELETE (onde estiver): apagar variações `stem_source_id = X`
  em cascata ao deletar X.

### 5.4 `api/routes/playback.py`, `queue.py`, `settings.py`, `utils/core_client.py`

- Conforme §3.3. `core_client`: `play(..., stems=None, position=None)`,
  `stems_mix(...)`, `stems_keep_mix(enabled)`, `queue_add(..., stems=None)`.
- Helper compartilhado `resolve_stems(conn, track) → dict[role, abspath] |
  None` (variação → stems de X, filtra `os.path.exists`, ≥2) usado por play e
  queue/add.

### 5.5 `api/routes/bootstrap.py`

- `_track()`: novo campo `stems_of` (id da original, `""` se normal).
- Papéis de stems (`stems: [...]`) vão **só para a variação** (mapear
  `smap[X]` → V); a original passa a mandar `stems: []` (original limpa).

### 5.6 `static/js/stems.js` (maior mudança)

- **Detecção**: `stems_of` do RolfsoundData (rows não existem para V no
  Acervo — não depender de `rowFor`). `rolesFor` da variação lê os stems dela
  no RolfsoundData.
- **Lanes**: `rolf:track` com id de variação ⇒ lanes sempre construídas (sem
  toggle). Original ou faixa comum ⇒ sem lanes. Remover a lógica de
  `setLanes(on/off)` por botão.
- **Botão `[data-stems-btn]`**: vira gestão — na variação (aceso) e na
  original, abre a gaveta (que opera sobre X). Sem estado `on/off` de modo.
- **Gestos ao vivo**: mudo/solo/fader atualizam `laneUi` + visual e, se
  `status.track_id === trackId` (a variação está tocando), POST debounced
  ~120ms `RolfPlayback.stemsMix({levels, mutes, solos})` com o estado
  completo.
- **Sync**: listener `rolf:status` → `status.stems` (guard de 2.5s pós-gesto
  local, padrão do remixer-live) adota levels/mutes/solos + classes
  `.on`/`.mut` + faders. Página recarregada com V tocando fica certa sozinha.
- **Gaveta**: ao receber `variant.created` ⇒ push da V em
  `RolfsoundData.tracks`, atualizar `RolfsoundData.groups` e o selo
  "N versões" da row de X; toast "Versão Stem Ready criada". `variant.removed`
  ⇒ inverso.
- Lanes vazias ("Adicionar camada") só fazem sentido na variação com 2–3
  papéis — mantêm o clique para a gaveta.

### 5.7 `static/js/playback.js`

- `RolfPlayback.stemsMix(payload)` → POST `/api/remix/stems`.
- `trackView()`/`enrichQueueItem()`: fallback também em
  `RolfsoundData.tracks` (não só na row do DOM) — a variação não tem row no
  Acervo e hoje esses helpers perderiam capa/bpm/key/duração dela.

### 5.8 Outros na UI

- `static/js/versions.js`: mini badge de 4 pontos na linha da versão que é
  Stem Ready (a gaveta de versões é onde a V aparece).
- Tela Config: ligar um toggle real "Manter mix de stems ao trocar de faixa"
  → `POST /api/settings {stems_keep_mix}`.
- Opcional (anotar, não bloquear): incluir variações no picker "Trocar faixa"
  do Remixer (hoje lista só rows do Acervo).

## 6. Casos de borda

- **Repeat-one** da variação: mesmo filepath + stems preservados no core. ✔
- **Skip/advance**: stems limpos; mixer reseta se `keep_mix` off.
- **Durações diferentes** entre stems: zero-pad; duração = max.
- **Stems deletados do disco com V na fila**: core valida `exists` na hora ⇒
  <2 ⇒ toca o `filepath` (master). `status.stems.active=false` ⇒ UI não marca
  mix ativo.
- **Deletar X** ⇒ deleta V em cascata (sidecars são de X). Deletar V ⇒ só a
  variação some; sidecars ficam.
- **Gaveta aberta na V** ⇒ opera em X (redirect por `stem_source_id`).
- **`scan_and_reconcile`**: conferir que V (file_path duplicado de X) não é
  deduplicada/removida pelo reconcile; se X sumir do disco e for removida, V
  cai junto pela cascata — aceitável.
- **Pausa**: inalterada (nível do ring buffer). **Volume/sinks/recorder/
  stream**: intocados (o tap é pós-callback).

## 7. Ordem de execução e verificação

1. **Core: mixer** — `stem_mixer.py` + `test_stem_mixer.py`.
2. **Core: fontes + API** — refactor do decode loop, play/seek/fila com
   stems, `/stems/mix`, `/stems/keep_mix`, status, eventos.
   Verificar: `tests/run_all.py` (regressão) + tocar 4 wavs sintéticos via
   `/play` com stems e ouvir solo/mute mudando ao vivo; pitch/tempo por cima;
   seek mantém fase.
3. **Web backend** — migração + variação automática (upload/delete/backfill)
   + bootstrap + play/queue-add + `/api/remix/stems` + `_enrich_status` +
   settings + delete cascade.
   Verificar: subir os dois servidores; upload de 2 camadas cria V no grupo;
   `GET /api/bootstrap.js` mostra `stems` na V e `[]` em X.
4. **Web frontend** — stems.js/playback.js/versions.js/Config conforme §5.
   Verificar (roteiro E2E): tocar V pela gaveta de versões → lanes vivas,
   solo isola, fader escala, mute cala; trocar de faixa reseta (ou mantém com
   o toggle ligado); reload da página re-sincroniza; original toca master sem
   lanes; remover camadas até 1 desfaz V com toast.
5. Atualizar `README.md` (linha do stems.js na tabela), `TO-DO-LIST.md`
   (item 5) e a memória da feature.

## 8. Fora de escopo (fase 3+)

- Waveform real por stem (hoje é procedural por papel — fica).
- Separação por IA (decisão antiga: só upload manual, sem gancho na UI).
- Filtro/EQ/Loop/Saída do Remixer (item 5.2 do TO-DO, independente).
- Export do mix alterado (gravar a mixagem como nova faixa).

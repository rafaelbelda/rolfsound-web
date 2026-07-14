# VinylScrubPLAN — scrub com "feel" de vinil

Transformar a sensação do scrub de **fita** para **disco de vinil**, sem
jamais adicionar sinal em cima da música (somos Hi-Fi: nada de crackle,
hiss ou rumble). Toda a diferença fita→vinil mora em **como o rate se
move** — física de inércia do prato, puro varispeed do áudio real — e na
camada **visual/tátil**.

O motor de scrub já é, fisicamente, um toca-discos: o `ScrubEngine` move
um playhead em `float` e lê o PCM na velocidade do dedo. A distinção não
está no varispeed (idêntico nos dois meios), e sim na inércia rotacional
de um prato pesado num rolamento — algo que um carretel de fita não tem.

---

## Fase 0 — Física do prato ✅ (feito)

Leis de rate novas, tudo tunável em `playback.scrub` do config do core.

**`rolfsound/services/scrub_engine.py`**
- `plan()` ganhou duas leis de glide: `coast` (lag de 1ª ordem = prato
  desacelerando no rolamento) e `torque` (mola de 2ª ordem = motor
  puxando o prato, com overshoot opcional). Grudam no alvo (`_GLIDE_SNAP_*`).
- `set_rate(..., glide=)`; a semântica de **preservar** a lei vigente num
  `set_rate(1.0)` pelado foi mantida (a ponte de handoff depende disso).
- Inércia no gesto (`follow_inertia`): τ maior + slew mais preguiçoso.

**`rolfsound/services/playback_service.py`**
- Release → **torque restore** a 1× + previsão do assentamento pela
  cinemática da mola (`travel = ((r0−1)·2ζ + 5)/w0`).
- Pause → **freio power-down por coast** exponencial.
- Resume → **spin-up com torque** de motor (crítico, sem wobble).
- Helper `_spring_from(settle_s, overshoot) → (w0, ζ)`.

**`rolfsound/config.py`** (`playback.scrub`):
`momentum_torque`, `momentum_settle_s`, `momentum_overshoot`,
`platter_inertia`, `brake_coast`, `spin_up_torque`.

> Bug corrigido: previsão de assentamento sem o termo de tempo caía atrás
> do ponto real → a ponte estourava o timeout e cortava pra trás
> ("teleport backward" pós-scrub). Reposto o `5/w0`.

---

## Fase 1 — Tuning + switch (barato, dá controle)

- [ ] **Tunar os knobs ao vivo** e cravar os defaults:
  - `momentum_settle_s` — comprimento do spinback.
  - `momentum_overshoot` — 0 = Hi-Fi limpo · →0.6 = snap direct-drive.
  - `platter_inertia` — peso no gesto (1.0 desliga).
- [ ] **Switch "Modo vinil" × "Modo fita"** na UI. Hoje é só config no
  core; o `scrub_tape_mode` já existe como switch — estender/duplicar
  para trocar o preset de física (torque/coast on/off) de uma vez.
- [ ] **Verificar ponta a ponta** pós-restart do core: arremesso forte,
  reverse segurado (R), soltar suave, pause/resume — nenhum blip no splice.

---

## Fase 2 — O prato na UI (etapa visual maior)

O WS já ecoa o `rate` real a ~30 Hz (evento `pos` do `rolf:scrub`), então
tudo se amarra nele — o olho mostra exatamente o que o ouvido sente.

- [ ] **`RolfPlatter`**: disco girando via `transform: rotate()` acionado
  pela integral do `rate` ecoado. Desacelera, reverte e re-engata em
  sincronia com o som, spinback do torque incluído.
- [ ] **Braço + raio**: posição da faixa = ângulo do braço (borda externa
  = início, centro = fim).
- [ ] **Estados**: idle parado · girando a 33⅓ · blur/glint em alta
  rotação · dot-matrix com rpm no lugar do `◀◀ 2` do reverse.
- [ ] Reusar a descoberta/ciclo de vida do `static/js/scrub-client.js`.

---

## Fase 3 — Coerência de feel além do prato

- [ ] Cursor vira agulha/mão sobre a strip de seek; leve resistência
  visual no drag reforçando a inércia.
- [ ] Hairline de seek com textura sutil de sulco; `.tp-fill` como a
  parte "já tocada".
- [ ] (opcional) `momentum_overshoot` leve como default — só se, ao
  ouvir, o snap agradar sem ferir o Hi-Fi.

---

## Princípios

1. **Zero sinal somado.** "Feel" vem da física do movimento + do visual.
2. **A ponte se auto-corrige no playhead real** — previsões só precisam
   cair na vizinhança.
3. **Defaults criticamente amortecidos (ζ=1)** — sem pitch-wobble no fim
   de cada gesto, a menos que o usuário peça o snap.

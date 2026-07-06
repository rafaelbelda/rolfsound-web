# api/routes/playback.py

from pathlib import Path
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from utils import core_client

router = APIRouter()


class PlayRequest(BaseModel):
    track_id: str = ""
    filepath: str = ""
    # Play by absolute queue position (core resolves the track and moves
    # current_index atomically — the right way to play a row from the queue UI).
    index: int | None = None


class SeekRequest(BaseModel):
    position: float


class VolumeRequest(BaseModel):
    volume: float  # 0.0 – 1.0


class RemixRequest(BaseModel):
    pitch_semitones: float | None = None
    tempo_ratio: float | None = None


class FxRequest(BaseModel):
    # Atualização parcial: o core preserva o que for omitido.
    filter_mode: str | None = None        # 'lp' | 'hp'
    filter_cutoff_hz: float | None = None  # 20–20000
    eq_low_db: float | None = None         # -12..+12
    eq_mid_db: float | None = None
    eq_high_db: float | None = None


class MuteRequest(BaseModel):
    muted: bool


class StemsMixRequest(BaseModel):
    # Atualização parcial: o core preserva o que for omitido.
    levels: dict[str, float] | None = None
    mutes: dict[str, bool] | None = None
    solos: dict[str, bool] | None = None


@router.post("/play")
async def play(req: PlayRequest = None):
    filepath = req.filepath if req else ""
    track_id = req.track_id if req else ""
    index    = req.index    if req else None

    # Play by queue index: core resolves filepath itself.
    if index is not None:
        result = await core_client.play(index=index)
        if result is None:
            raise HTTPException(status_code=503, detail="Core unavailable")
        return result

    # The new UI only knows DB ids (never exposes filesystem paths), so a play
    # request usually arrives with just track_id — resolve the filepath here.
    # Core has no database; sending track_id alone would only work for the
    # track already at the queue's current index.
    # Variação Stem Ready: resolve também os paths dos stems da original —
    # o core toca multipista. O filepath enviado continua sendo o master
    # (identidade + fallback no core quando <2 stems válidos).
    stems = None
    if track_id:
        from db import database
        from api.routes.stems import resolve_stems
        conn = database.get_connection()
        try:
            track = database.get_track(conn, track_id)
            if track:
                if not filepath:
                    filepath = track.get("file_path", "") or ""
                stems = resolve_stems(conn, track)
        finally:
            conn.close()
        if not filepath:
            raise HTTPException(status_code=404, detail="Track not found in library")

    # Resolve to absolute path before sending to core.
    # Core runs in a different working directory — relative paths like
    # "music/track.webm" would resolve to the wrong location in core's CWD.
    # Guard: only resolve non-empty strings — Path("").resolve() returns CWD
    # which would be sent as a bogus filepath.
    if filepath:
        filepath = str(Path(filepath).resolve())

    # Pass None (not empty string) so core_client skips adding to the dict.
    # Core receiving {"filepath": ""} is treated as no filepath provided.
    result = await core_client.play(
        filepath=filepath if filepath else None,
        track_id=track_id if track_id else None,
        stems=stems,
    )
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    # "stems" na resposta: a UI toasta o fallback quando a variação caiu
    # no master (o core devolve o efetivo; sem chave = eco do resolvido aqui).
    if "stems" not in result:
        result["stems"] = bool(stems)
    # Troca de faixa limpou os pads no core — reempurra os salvos desta
    # faixa (a fila do engine garante a ordem: play processa antes).
    if track_id:
        from api.routes.pads import push_pads_to_core
        await push_pads_to_core(track_id)
    return result


@router.post("/pause")
async def pause():
    result = await core_client.pause()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/skip")
async def skip():
    result = await core_client.skip()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/seek")
async def seek(req: SeekRequest):
    result = await core_client.seek(req.position)
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/volume")
async def volume(req: VolumeRequest):
    result = await core_client.set_volume(max(0.0, min(1.0, req.volume)))
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


# Remix roda NO CORE (pitch/tempo do áudio real via remix_engine) — a UI só
# manda parâmetros. Nenhum áudio é processado no navegador.
@router.post("/remix")
async def remix(req: RemixRequest):
    result = await core_client.remix_set(req.pitch_semitones, req.tempo_ratio)
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/remix/reset")
async def remix_reset():
    result = await core_client.remix_reset()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


# Filtro/EQ rodam NO CORE (fx_engine, estágio pós-remix do pump) — mesma
# filosofia do remix: a UI só manda parâmetros.
@router.post("/fx")
async def fx(req: FxRequest):
    result = await core_client.fx_set(
        filter_mode=req.filter_mode,
        filter_cutoff_hz=req.filter_cutoff_hz,
        eq_low_db=req.eq_low_db,
        eq_mid_db=req.eq_mid_db,
        eq_high_db=req.eq_high_db,
    )
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/fx/reset")
async def fx_reset():
    result = await core_client.fx_reset()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/mute")
async def mute(req: MuteRequest):
    result = await core_client.set_mute(req.muted)
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


# Medidor de saída (picos L/R do callback) — poll quente da tela Remixer.
@router.get("/levels")
async def levels():
    result = await core_client.get_levels()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


# Mudo/solo/fader das lanes de stems — repassado ao StemMixer do core
# (ganhos ao vivo, com rampa anti-click por bloco).
@router.post("/remix/stems")
async def remix_stems(req: StemsMixRequest):
    result = await core_client.stems_mix(req.levels, req.mutes, req.solos)
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result

# api/routes/monitor.py
"""
GET  /api/monitor               — full recorder state + config bounds from core
POST /api/monitor/auto-record   — toggle auto-record on core
POST /api/monitor/threshold     — set threshold on core (clamped to core bounds)
POST /api/monitor/record/start  — trigger manual recording start
POST /api/monitor/record/stop   — trigger manual recording stop
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from utils import core_client

router = APIRouter()


@router.get("/monitor")
async def get_monitor():
    """
    Returns the full recorder state AND the config bounds that control it.

    The dashboard uses these bounds to:
      - Set the threshold slider min/max/step attributes correctly
      - Scale the visualizer bar graph ceiling (max_threshold * headroom)
      - Show meaningful labels for trigger/silence progress bars

    All values come from the core's authoritative /status response.
    The recorder config sub-keys (min_threshold, max_threshold, encoder_step,
    trigger_duration, stop_seconds) are emitted by RecorderService into
    SystemState so they are always in sync with what the hardware actually uses.
    """
    status = core_client.get_status()
    if status is None:
        raise HTTPException(status_code=503, detail="Core unavailable")

    recorder = status.get("recorder", {})
    monitor  = status.get("monitor",  {})

    return {
        # ── Live state ──────────────────────────────────────────────
        "recording":            recorder.get("recording",             False),
        "auto_record_enabled":  recorder.get("auto_record_enabled",   False),
        "manual_record_active": recorder.get("manual_record_active",  False),
        "threshold":            recorder.get("threshold",             0.015),
        "rms_level":            recorder.get("rms_level",             0.0),
        "trigger_progress":     recorder.get("trigger_progress",      0.0),
        "silence_progress":     recorder.get("silence_progress",      0.0),

        # ── Config bounds (from core — dashboard must obey these) ───
        "min_threshold":        recorder.get("min_threshold",         0.001),
        "max_threshold":        recorder.get("max_threshold",         0.1),
        "encoder_step":         recorder.get("encoder_step",          0.005),
        "trigger_duration":     recorder.get("trigger_duration",      0.5),   # seconds
        "stop_seconds":         recorder.get("stop_seconds",          5),     # seconds silence → stop
        "output_dir":           recorder.get("output_dir",            "recordings"),

        # ── Monitor config ───────────────────────────────────────────
        "sample_rate":          monitor.get("sample_rate",            48000),
        "block_size":           monitor.get("block_size",             1024),
        "monitor_all_channels": monitor.get("monitor_all_channels",   True),
        "channel_index":        monitor.get("channel_index",          1),
    }


class AutoRecordRequest(BaseModel):
    enabled: bool


class ThresholdRequest(BaseModel):
    value: float


@router.post("/monitor/auto-record")
async def set_auto_record(req: AutoRecordRequest):
    result = core_client._post("/recorder/auto-record", {"enabled": req.enabled})
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/monitor/threshold")
async def set_threshold(req: ThresholdRequest):
    """
    Forward threshold change to core.
    Clamping is done by the core (RecorderService.set_threshold),
    but we validate the range here too so bad requests never reach core.
    """
    # Fetch current bounds to validate
    status = core_client.get_status()
    if status is None:
        raise HTTPException(status_code=503, detail="Core unavailable")

    recorder = status.get("recorder", {})
    mn = recorder.get("min_threshold", 0.001)
    mx = recorder.get("max_threshold", 0.1)

    value = max(mn, min(mx, req.value))

    result = core_client._post("/recorder/threshold", {"value": value})
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/monitor/record/start")
async def manual_record_start():
    """Trigger a manual recording start on core (same as pressing the hardware switch ON)."""
    result = core_client.record_start()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/monitor/record/stop")
async def manual_record_stop():
    """Stop a manual recording on core (same as pressing the hardware switch OFF)."""
    result = core_client.record_stop()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result
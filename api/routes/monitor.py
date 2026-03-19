# api/routes/monitor.py
"""
GET  /api/monitor               — recorder state
POST /api/monitor/auto-record   — toggle auto-record on core
POST /api/monitor/threshold     — set threshold on core
POST /api/monitor/record/start  — trigger manual recording start
POST /api/monitor/record/stop   — trigger manual recording stop
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from utils import core_client

router = APIRouter()


@router.get("/monitor")
async def get_monitor():
    status = core_client.get_status()
    if status is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    recorder = status.get("recorder", {})
    return {
        "recording":            recorder.get("recording", False),
        "auto_record_enabled":  recorder.get("auto_record_enabled", False),
        "manual_record_active": recorder.get("manual_record_active", False),
        "threshold":            recorder.get("threshold", 0.015),
        "rms_level":            recorder.get("rms_level", 0.0),
        "trigger_progress":     recorder.get("trigger_progress", 0.0),
        "silence_progress":     recorder.get("silence_progress", 0.0),
        "sample_rate":          status.get("monitor", {}).get("sample_rate", 48000),
        "monitor_all_channels": status.get("monitor", {}).get("monitor_all_channels", True),
        "channel_index":        status.get("monitor", {}).get("channel_index", 1),
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
    result = core_client._post("/recorder/threshold", {"value": req.value})
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
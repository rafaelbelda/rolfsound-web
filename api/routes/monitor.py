# api/routes/monitor.py
import asyncio
import json

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from utils import core_client
from utils.monitor_accumulator import get_accumulator

router = APIRouter()


@router.get("/monitor")
async def get_monitor():
    status = await core_client.get_status()
    if status is None:
        raise HTTPException(status_code=503, detail="Core unavailable")

    recorder = status.get("recorder", {})
    monitor  = status.get("monitor",  {})

    acc = get_accumulator().latest_state()

    return {
        "recording":            acc["recording"],
        "auto_record_enabled":  recorder.get("auto_record_enabled",   False),
        "manual_record_active": recorder.get("manual_record_active",  False),
        "threshold":            acc["threshold"],
        "rms_level":            acc["rms_level"],
        "trigger_progress":     recorder.get("trigger_progress",      0.0),
        "silence_progress":     recorder.get("silence_progress",      0.0),
        "min_threshold":        recorder.get("min_threshold",         0.001),
        "max_threshold":        recorder.get("max_threshold",         0.1),
        "encoder_step":         recorder.get("encoder_step",          0.005),
        "trigger_duration":     recorder.get("trigger_duration",      0.5),
        "stop_seconds":         recorder.get("stop_seconds",          5),
        "output_dir":           recorder.get("output_dir",            "recordings"),
        "sample_rate":          monitor.get("sample_rate",            48000),
        "block_size":           monitor.get("block_size",             1024),
        "monitor_all_channels": monitor.get("monitor_all_channels",   True),
        "channel_index":        monitor.get("channel_index",          1),
    }


@router.get("/monitor/stream")
async def monitor_stream(request: Request):
    acc = get_accumulator()

    async def event_generator():
        q = acc.subscribe()
        try:
            state    = acc.latest_state()
            backfill = acc.get_backfill()
            yield (
                "event: samples\n"
                f"data: {json.dumps({'samples': backfill, 'threshold': state['threshold'], 'recording': state['recording']})}\n\n"
            )

            while True:
                try:
                    payload = await asyncio.wait_for(q.get(), timeout=5.0)
                    yield f"event: samples\ndata: {json.dumps(payload)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        except GeneratorExit:
            pass
        finally:
            acc.unsubscribe(q)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":    "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


class AutoRecordRequest(BaseModel):
    enabled: bool


class ThresholdRequest(BaseModel):
    value: float


@router.post("/monitor/auto-record")
async def set_auto_record(req: AutoRecordRequest):
    result = await core_client._post("/recorder/auto-record", {"enabled": req.enabled})
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/monitor/threshold")
async def set_threshold(req: ThresholdRequest):
    result = await core_client._post("/recorder/threshold", {"value": req.value})
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/monitor/record/start")
async def manual_record_start():
    result = await core_client.record_start()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/monitor/record/stop")
async def manual_record_stop():
    result = await core_client.record_stop()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result

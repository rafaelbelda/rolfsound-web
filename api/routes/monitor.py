# api/routes/monitor.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

# 1. Importamos a nossa nova Fachada em vez do core_client e do accumulator!
from utils.core import core 

router = APIRouter()

@router.get("/monitor")
async def get_monitor():
    status = await core.get_status()
    if status is None:
        raise HTTPException(status_code=503, detail="Core unavailable")

    recorder = status.get("recorder", {})
    monitor  = status.get("monitor",  {})

    # Como apagámos o Acumulador, lemos os estados diretamente do status do Core
    return {
        "recording":            recorder.get("is_recording", False),
        "auto_record_enabled":  recorder.get("auto_record_enabled", False),
        "manual_record_active": recorder.get("manual_record_active", False),
        "threshold":            recorder.get("threshold", 0.0),
        "rms_level":            monitor.get("rms_level", 0.0), 
        "trigger_progress":     recorder.get("trigger_progress", 0.0),
        "silence_progress":     recorder.get("silence_progress", 0.0),
        "min_threshold":        recorder.get("min_threshold", 0.001),
        "max_threshold":        recorder.get("max_threshold", 0.1),
        "encoder_step":         recorder.get("encoder_step", 0.005),
        "trigger_duration":     recorder.get("trigger_duration", 0.5),
        "stop_seconds":         recorder.get("stop_seconds", 5),
        "output_dir":           recorder.get("output_dir", "recordings"),
        "sample_rate":          monitor.get("sample_rate", 48000),
        "block_size":           monitor.get("block_size", 1024),
        "monitor_all_channels": monitor.get("monitor_all_channels", True),
        "channel_index":        monitor.get("channel_index", 1),
    }

# A ROTA /monitor/stream FOI APAGADA AQUI! 
# (O frontend vai ler o áudio via SSE/WebSockets nativos agora)

class AutoRecordRequest(BaseModel):
    enabled: bool

class ThresholdRequest(BaseModel):
    value: float


@router.post("/monitor/auto-record")
async def set_auto_record(req: AutoRecordRequest):
    # Usamos o cliente HTTP embutido no Facade para configurações específicas
    result = await core.http.post("/recorder/auto-record", {"enabled": req.enabled})
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/monitor/threshold")
async def set_threshold(req: ThresholdRequest):
    result = await core.http.post("/recorder/threshold", {"value": req.value})
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/monitor/record/start")
async def manual_record_start():
    result = await core.record_start()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result


@router.post("/monitor/record/stop")
async def manual_record_stop():
    result = await core.record_stop()
    if result is None:
        raise HTTPException(status_code=503, detail="Core unavailable")
    return result
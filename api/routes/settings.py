# api/routes/settings.py

from fastapi import APIRouter
from pydantic import BaseModel
from utils import config as cfg
from utils import core_client

router = APIRouter()


@router.get("/settings")
async def get_settings():
    return cfg.all_settings()


class SettingsUpdate(BaseModel):
    settings: dict


@router.post("/settings")
async def update_settings(req: SettingsUpdate):
    cfg.update(req.settings)
    # stems_keep_mix vive no config.json da web, mas o comportamento é do
    # core (runtime) — repassa na hora. Na subida o lifespan reenvia.
    if "stems_keep_mix" in req.settings:
        await core_client.stems_keep_mix(bool(req.settings["stems_keep_mix"]))
    return {"ok": True, "settings": cfg.all_settings()}
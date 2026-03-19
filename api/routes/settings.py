# api/routes/settings.py

from fastapi import APIRouter
from pydantic import BaseModel
from utils import config as cfg

router = APIRouter()


@router.get("/settings")
async def get_settings():
    return cfg.all_settings()


class SettingsUpdate(BaseModel):
    settings: dict


@router.post("/settings")
async def update_settings(req: SettingsUpdate):
    cfg.update(req.settings)
    return {"ok": True, "settings": cfg.all_settings()}
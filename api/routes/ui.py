from copy import deepcopy
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from core.database import database

router = APIRouter()

LIBRARY_LAYOUT_KEY = "library.layout.v1"

DEFAULT_LIBRARY_LAYOUT = {
    "version": 1,
    "blocks": [
        {
            "id": "albums-main",
            "type": "albums",
            "view": "grid",
            "title": "Albums",
            "size": "wide",
            "enabled": True,
            "config": {"sort": "recent", "limit": 12},
        },
        {
            "id": "tracks-main",
            "type": "tracks",
            "view": "list",
            "title": "Tracks",
            "size": "wide",
            "enabled": True,
            "config": {"sort": "recent", "limit": 40},
        },
        {
            "id": "artists-main",
            "type": "artists",
            "view": "circles",
            "title": "Artists",
            "size": "wide",
            "enabled": True,
            "config": {"sort": "name", "limit": 18},
        },
        {
            "id": "playlists-main",
            "type": "playlists",
            "view": "grid",
            "title": "Playlists",
            "size": "wide",
            "enabled": True,
            "config": {"sort": "recent", "limit": 12},
        },
    ],
}


class LibraryBlock(BaseModel):
    id: str = Field(min_length=1)
    type: str = Field(min_length=1)
    view: str = Field(default="grid", min_length=1)
    title: str = Field(default="", min_length=0)
    size: Literal["compact", "medium", "wide"] = "wide"
    enabled: bool = True
    config: dict[str, Any] = Field(default_factory=dict)


class LibraryLayout(BaseModel):
    version: int = 1
    blocks: list[LibraryBlock] = Field(default_factory=list)


def _default_layout() -> dict:
    return deepcopy(DEFAULT_LIBRARY_LAYOUT)


@router.get("/ui/library-layout")
async def get_library_layout():
    conn = database.get_connection()
    try:
        layout = database.get_app_preference(conn, LIBRARY_LAYOUT_KEY, _default_layout())
        return layout or _default_layout()
    finally:
        conn.close()


@router.put("/ui/library-layout")
async def put_library_layout(layout: LibraryLayout):
    payload = layout.model_dump()
    payload["version"] = 1
    conn = database.get_connection()
    try:
        database.set_app_preference(conn, LIBRARY_LAYOUT_KEY, payload)
        conn.commit()
        return payload
    finally:
        conn.close()


@router.delete("/ui/library-layout")
async def reset_library_layout():
    conn = database.get_connection()
    try:
        database.delete_app_preference(conn, LIBRARY_LAYOUT_KEY)
        conn.commit()
        return _default_layout()
    finally:
        conn.close()

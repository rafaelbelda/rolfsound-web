# api/routes/history.py

from fastapi import APIRouter, Query
from core.database import database

router = APIRouter()


@router.get("/history")
async def get_history(limit: int = Query(default=50, le=200)):
    conn = database.get_connection()
    try:
        return {"history": database.get_history(conn, limit=limit)}
    finally:
        conn.close()
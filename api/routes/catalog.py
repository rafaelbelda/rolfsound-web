from fastapi import APIRouter, HTTPException, Query

from core.database import database

router = APIRouter()


@router.get("/artists")
async def list_artists():
    conn = database.get_connection()
    try:
        artists = database.list_artists(conn)
        return {"artists": artists, "total": len(artists)}
    finally:
        conn.close()


@router.get("/artists/{artist_id}")
async def get_artist(artist_id: str):
    conn = database.get_connection()
    try:
        artist = database.get_artist(conn, artist_id)
        if not artist:
            raise HTTPException(status_code=404, detail="Artist not found")
        return artist
    finally:
        conn.close()


@router.get("/artists/{artist_id}/tracks")
async def get_artist_tracks(artist_id: str):
    conn = database.get_connection()
    try:
        artist = database.get_artist(conn, artist_id)
        if not artist:
            raise HTTPException(status_code=404, detail="Artist not found")
        tracks = database.get_artist_tracks(conn, artist_id)
        return {"artist": artist, "tracks": tracks, "total": len(tracks)}
    finally:
        conn.close()


@router.get("/artists/{artist_id}/albums")
async def get_artist_albums(artist_id: str, include_singles: bool = Query(False)):
    conn = database.get_connection()
    try:
        artist = database.get_artist(conn, artist_id)
        if not artist:
            raise HTTPException(status_code=404, detail="Artist not found")
        albums = database.get_artist_albums(conn, artist_id, include_singles=include_singles)
        return {"artist": artist, "albums": albums, "total": len(albums)}
    finally:
        conn.close()


@router.get("/artists/{artist_id}/discography")
async def get_artist_discography(
    artist_id: str,
    scope: str = Query("local", pattern="^(local|catalog|all)$"),
):
    conn = database.get_connection()
    try:
        artist = database.get_artist(conn, artist_id)
        if not artist:
            raise HTTPException(status_code=404, detail="Artist not found")
        discography = database.get_artist_discography(conn, artist_id, scope=scope)
        return {"artist": artist, **discography}
    finally:
        conn.close()


@router.get("/albums")
async def list_albums(include_singles: bool = Query(False)):
    conn = database.get_connection()
    try:
        albums = database.list_albums(conn, include_singles=include_singles)
        return {"albums": albums, "total": len(albums)}
    finally:
        conn.close()


@router.get("/albums/{album_id}")
async def get_album(album_id: str):
    conn = database.get_connection()
    try:
        album = database.get_album(conn, album_id)
        if not album:
            raise HTTPException(status_code=404, detail="Album not found")
        return album
    finally:
        conn.close()


@router.get("/albums/{album_id}/tracks")
async def get_album_tracks(album_id: str):
    conn = database.get_connection()
    try:
        album = database.get_album(conn, album_id)
        if not album:
            raise HTTPException(status_code=404, detail="Album not found")
        tracks = database.get_album_tracks(conn, album_id)
        return {"album": album, "tracks": tracks, "total": len(tracks)}
    finally:
        conn.close()

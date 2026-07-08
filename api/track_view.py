# api/track_view.py
"""
Mapeia uma linha de faixa do SQLite para o formato que a UI consome (o
mesmo shape documentado em static/js/data.js). Fonte única da verdade,
dividida entre:

  - o bootstrap (GET /api/bootstrap.js) — todas as faixas de uma vez;
  - endpoints que devolvem UMA faixa recém-criada para o front inserir a
    row no Acervo AO VIVO, sem recarregar a página (ex.: download do
    Discovery concluído — GET /api/library/{id}/card).

Mapeamento do schema antigo -> formato da UI:
  - fmt:   source 'recording' -> 'vinil'; resto -> 'digital'
  - state: status 'identified' -> 'master'; resto -> 'rip'
  - cover: thumbnail vira background CSS (url(...))
"""

from pathlib import Path


def cover_css(thumbnail: str | None) -> str:
    if not thumbnail:
        return ""
    t = thumbnail
    # Caminho local no disco (scan antigo gravava caminho absoluto): as capas
    # sidecar moram no diretório de música, servido pela montagem /thumbs.
    if not t.startswith(("http://", "https://", "/")):
        t = "/thumbs/" + Path(t).name
    # Aspas simples: o valor entra em style="…" no render.js — aspas duplas
    # fechariam o atributo e a capa não carregava.
    t = t.replace("\\", "/").replace("'", "%27").replace('"', "%22")
    return f"url('{t}') center/cover no-repeat, #141416"


def track_view(r: dict, stems: list | None = None, primary: bool = False) -> dict:
    group = r.get("version_group_id") or ""
    return {
        "id":     r.get("id") or "",
        "title":  r.get("title") or "Faixa",
        "artist": r.get("artist") or "",
        # álbum vem do JOIN (a.title): "Single" para singles. album_id é a
        # entidade dona; album_total = "número de músicas"; album_kind = single|album.
        "album":  r.get("album") or "",
        "album_id":    r.get("album_id") or "",
        "album_total": r.get("album_total") or 0,
        "album_kind":  r.get("album_kind") or "album",
        "genre":  r.get("genre") or "",
        # número da faixa no álbum (ordena o painel "Ver álbum"); 0 = sem tag
        "track_no": r.get("track_no") or 0,
        "year":   str(r["year"]) if r.get("year") else "",
        "added":  (r.get("date_added") or 0) * 1000,
        "bpm":    r.get("bpm") or 0,
        "key":    r.get("key") or "",
        "fmt":    "vinil" if r.get("source") == "recording" else "digital",
        "state":  "master" if r.get("status") == "identified" else "rip",
        "fav":    bool(r.get("fav")),
        "tags":   r.get("tags") or [],
        "dur":    r.get("duration") or 0,
        # plays válidos (streams): só conta quando 60%+ da faixa foi ouvida
        "plays":  r.get("streams") or 0,
        # capa é do álbum (a.cover, via JOIN); thumbnail é a arte embutida do
        # arquivo, usada como fallback quando o álbum não tem capa própria
        "cover":  cover_css(r.get("album_cover") or r.get("thumbnail")),
        # papéis de stems ('vocals'|'drums'|'bass'|'other') — só a VARIAÇÃO
        # Stem Ready os carrega (badge de 4 pontos + lanes no Remixer);
        # a original fica limpa
        "stems":  stems or [],
        # variação Stem Ready: id da original dona dos sidecars ("" = normal)
        "stems_of": r.get("stem_source_id") or "",
        # agrupamento de versões: group = id do grupo (ou ""), primary = é a
        # versão que representa a "pasta" no Acervo, vlabel = rótulo da versão
        "group":  group,
        "vlabel": r.get("version_label") or "",
        "primary": bool(primary),
    }

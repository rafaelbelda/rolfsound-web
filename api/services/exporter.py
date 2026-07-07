# api/services/exporter.py
"""Exportação de faixa ("Exportar faixa" no menu de contexto).

Gera uma cópia temporária do arquivo com os metadados do Acervo gravados
no próprio arquivo — título, artista, álbum, nº da faixa, ano, gênero e
capa (quando o formato aceita) — nomeada "NN Título.ext" (ex.: a faixa 9
"Chimera" em FLAC vira "09 Chimera.flac"; sem número vira "00 ...").

Formatos que o mutagen escreve (flac/mp3/m4a/ogg/opus) recebem as tags
in-place na cópia; webm/mkv (rips do YouTube) são remuxados via PyAV com
os metadados no container — sem re-encode em nenhum dos casos. Se nada
disso for possível, o chamador serve o arquivo original como está.

O popup "Exportar faixa" também oferece conversão de formato (flac/mp3/
wav): transcodificação via PyAV (não há ffmpeg.exe no ambiente) seguida
das mesmas tags mutagen.
"""

import base64
import logging
import os
import shutil
import tempfile
from pathlib import Path

from utils.config import get as cfg_get

logger = logging.getLogger(__name__)

_INVALID_FS = set('\\/:*?"<>|')

# formato de saída → (ext, encoder PyAV, sample format, bit_rate ou None)
_TRANSCODE = {
    "flac": (".flac", "flac",       "s16",  None),
    "wav":  (".wav",  "pcm_s16le",  "s16",  None),
    "mp3":  (".mp3",  "libmp3lame", "s16p", 320_000),
}
EXPORT_FORMATS = ("original",) + tuple(_TRANSCODE)


def export_filename(track: dict, fmt: str = "original") -> str:
    ext = _TRANSCODE[fmt][0] if fmt in _TRANSCODE \
        else Path(track.get("file_path") or "").suffix
    title = (track.get("title") or "Faixa").strip()
    no = int(track.get("track_no") or 0)
    name = "".join(c for c in f"{no:02d} {title}" if c not in _INVALID_FS)
    return name.strip(" .") + ext


def _tag_values(track: dict) -> dict:
    no = int(track.get("track_no") or 0)
    total = int(track.get("album_total") or 0)
    vals = {
        "title":       track.get("title"),
        "artist":      track.get("artist"),
        "album":       track.get("album"),
        "genre":       track.get("genre"),
        "date":        str(track.get("year") or "") or None,
        "tracknumber": (f"{no}/{total}" if total else str(no)) if no else None,
    }
    return {k: str(v) for k, v in vals.items() if v}


def _cover_bytes(track: dict) -> tuple[bytes, str] | None:
    """(bytes, mime) da capa: a do álbum tem prioridade sobre a thumbnail
    da faixa. Aceita caminho absoluto ou URL /thumbs/... (→ music_dir)."""
    for src in (track.get("album_cover"), track.get("thumbnail")):
        p = str(src or "").strip()
        if not p or p.startswith("linear-gradient"):
            continue
        if p.startswith("/thumbs/"):
            music_dir = Path(cfg_get("music_directory", "./music")).resolve()
            p = str(music_dir / p[len("/thumbs/"):])
        if os.path.exists(p):
            mime = "image/png" if p.lower().endswith(".png") else "image/jpeg"
            return Path(p).read_bytes(), mime
    return None


def _embed_cover_mutagen(path: str, track: dict) -> None:
    found = _cover_bytes(track)
    if not found:
        return
    data, mime = found
    try:
        import mutagen
        from mutagen.flac import FLAC, Picture
        from mutagen.id3 import APIC
        from mutagen.mp4 import MP4, MP4Cover
        from mutagen.oggopus import OggOpus
        from mutagen.oggvorbis import OggVorbis

        raw = mutagen.File(path)
        if isinstance(raw, FLAC):
            pic = Picture()
            pic.type, pic.mime, pic.data = 3, mime, data
            raw.clear_pictures()
            raw.add_picture(pic)
            raw.save()
        elif isinstance(raw, MP4):
            fmt = MP4Cover.FORMAT_PNG if "png" in mime else MP4Cover.FORMAT_JPEG
            raw["covr"] = [MP4Cover(data, imageformat=fmt)]
            raw.save()
        elif isinstance(raw, (OggVorbis, OggOpus)):
            pic = Picture()
            pic.type, pic.mime, pic.data = 3, mime, data
            raw["metadata_block_picture"] = [base64.b64encode(pic.write()).decode()]
            raw.save()
        elif getattr(raw, "tags", None) is not None and hasattr(raw.tags, "delall"):
            # ID3 (mp3/wav/aiff)
            raw.tags.delall("APIC")
            raw.tags.add(APIC(encoding=3, mime=mime, type=3, desc="Cover", data=data))
            raw.save()
    except Exception as e:
        logger.debug(f"capa não embutida em {path}: {e}")


def _write_id3_frames(path: str, vals: dict) -> bool:
    """WAV/AIFF: sem interface easy — grava os frames ID3 diretamente."""
    import mutagen
    from mutagen.id3 import TALB, TCON, TDRC, TIT2, TPE1, TRCK

    raw = mutagen.File(path)
    if raw is None:
        return False
    if raw.tags is None:
        raw.add_tags()
    if not hasattr(raw.tags, "add"):
        return False
    frames = {"title": TIT2, "artist": TPE1, "album": TALB,
              "tracknumber": TRCK, "date": TDRC, "genre": TCON}
    for key, cls in frames.items():
        if vals.get(key):
            raw.tags.add(cls(encoding=3, text=[vals[key]]))
    raw.save()
    return True


def _write_tags_mutagen(path: str, track: dict, cover: bool = True) -> bool:
    import mutagen

    easy = mutagen.File(path, easy=True)
    if easy is None:
        return False
    if easy.tags is None:
        easy.add_tags()
    vals = _tag_values(track)
    wrote = False
    for key, val in vals.items():
        try:
            easy[key] = val
            wrote = True
        except Exception:
            pass  # chave sem equivalente neste formato
    if wrote:
        easy.save()
    elif not _write_id3_frames(path, vals):
        return False
    if cover:
        _embed_cover_mutagen(path, track)
    return True


def _remux_pyav(src: str, dst: str, track: dict) -> bool:
    """Remux (copy, sem re-encode) gravando os metadados no container —
    caminho dos webm/mkv, que o mutagen não escreve."""
    import av

    meta = _tag_values(track)
    if "tracknumber" in meta:
        meta["track"] = meta.pop("tracknumber")  # nome Matroska
    with av.open(src) as inp, av.open(dst, mode="w") as out:
        for k, v in meta.items():
            out.metadata[k] = v
        streams = [s for s in inp.streams if s.type == "audio"] or list(inp.streams)
        mapping = {s.index: out.add_stream_from_template(s) for s in streams}
        for packet in inp.demux(streams):
            if packet.dts is None:
                continue
            packet.stream = mapping[packet.stream.index]
            out.mux(packet)
    return True


def _transcode_pyav(src: str, dst: str, fmt: str) -> None:
    """Decodifica e re-encoda para o formato pedido (não há ffmpeg.exe no
    ambiente; o AudioCodecContext do PyAV bufferiza frames de qualquer
    tamanho, então basta resamplear para o sample format do encoder)."""
    import av

    _, codec, sample_fmt, bit_rate = _TRANSCODE[fmt]
    with av.open(src) as inp, av.open(dst, mode="w") as out:
        in_s = inp.streams.audio[0]
        rate = in_s.codec_context.sample_rate or 44100
        if codec == "libmp3lame" and rate not in (32000, 44100, 48000):
            rate = 44100
        layout = "mono" if (in_s.codec_context.channels or 2) == 1 else "stereo"
        out_s = out.add_stream(codec, rate=rate)
        out_s.codec_context.format = sample_fmt
        out_s.codec_context.layout = layout
        if bit_rate:
            out_s.codec_context.bit_rate = bit_rate
        resampler = av.AudioResampler(format=sample_fmt, layout=layout, rate=rate)
        for frame in inp.decode(in_s):
            for rf in resampler.resample(frame):
                out.mux(out_s.encode(rf))
        for rf in resampler.resample(None):   # drena o resampler
            out.mux(out_s.encode(rf))
        out.mux(out_s.encode(None))           # drena o encoder


def export_copy(track: dict, fmt: str = "original", cover: bool = True) -> str | None:
    """Cópia temporária com as tags gravadas (convertida, se fmt != original);
    devolve o caminho (o chamador remove após servir) ou None para servir o
    original sem tags. Conversão que falha levanta exceção — o chamador decide."""
    src = track.get("file_path") or ""
    src_ext = Path(src).suffix.lower()
    ext = _TRANSCODE[fmt][0] if fmt in _TRANSCODE else src_ext
    fd, tmp = tempfile.mkstemp(suffix=ext, prefix="rolf-export-")
    os.close(fd)
    try:
        if fmt in _TRANSCODE:
            _transcode_pyav(src, tmp, fmt)
            _write_tags_mutagen(tmp, track, cover=cover)
            return tmp
        if src_ext in (".webm", ".mkv"):
            if _remux_pyav(src, tmp, track):
                return tmp
        else:
            shutil.copy2(src, tmp)
            if _write_tags_mutagen(tmp, track, cover=cover):
                return tmp
        os.remove(tmp)
        return None
    except Exception as e:
        logger.warning(f"export {fmt} falhou ({track.get('id')}): {e}")
        try:
            os.remove(tmp)
        except OSError:
            pass
        if fmt in _TRANSCODE:
            raise
        return None

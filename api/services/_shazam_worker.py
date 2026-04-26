# api/services/_shazam_worker.py
#
# Isolated Shazam recognition worker. Runs in its own subprocess so that
# segfaults inside shazamio_core (a Rust extension that is unstable on
# Python 3.14) cannot kill the parent web process.
#
# Protocol:
#   argv[1] = path to a 16kHz mono PCM WAV file
#   stdout  = single line JSON: {"artist": str, "title": str} or "null"
#   exit 0  = success (even if no match)
#   exit !0 = crashed (parent treats as None)

import json
import sys
import warnings
import asyncio


def _configure_pydub() -> None:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        import imageio_ffmpeg
        from pydub import AudioSegment, utils as _u
    exe = imageio_ffmpeg.get_ffmpeg_exe()
    AudioSegment.converter = exe
    AudioSegment.ffmpeg    = exe
    AudioSegment.ffprobe   = exe
    _u.get_encoder_name = lambda: exe
    _u.get_prober_name  = lambda: exe


async def _recognize(path: str) -> dict | None:
    from shazamio import Shazam
    result = await Shazam().recognize(path)
    track = result.get("track") if isinstance(result, dict) else None
    if not track:
        return None
    images = track.get("images") or {}
    share = track.get("share") or {}
    return {
        "artist": track.get("subtitle", "") or "",
        "title":  track.get("title", "")    or "",
        "thumbnail": images.get("coverarthq") or images.get("coverart") or share.get("image") or "",
        "shazam_key": track.get("key") or "",
        "url": share.get("href") or track.get("url") or "",
    }


def main() -> int:
    if len(sys.argv) < 2:
        print("null")
        return 2
    _configure_pydub()
    try:
        out = asyncio.run(_recognize(sys.argv[1]))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        print("null")
        return 1
    print(json.dumps(out) if out else "null")
    return 0


if __name__ == "__main__":
    sys.exit(main())

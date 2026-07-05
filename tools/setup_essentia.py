from __future__ import annotations

import argparse
import json
import os
import platform
import stat
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = PROJECT_ROOT / "config.json"
TARGET_DIR = PROJECT_ROOT / "tools" / "essentia"

DOWNLOADS = {
    ("Windows", "amd64"): (
        "https://essentia.upf.edu/extractors/essentia-extractors-v2.1_beta2-win-i686.tar.gz",
        ("streaming_extractor_music.exe", "essentia_streaming_extractor_music.exe"),
        "essentia_streaming_extractor_music.exe",
    ),
    ("Windows", "x86"): (
        "https://essentia.upf.edu/extractors/essentia-extractors-v2.1_beta2-win-i686.tar.gz",
        ("streaming_extractor_music.exe", "essentia_streaming_extractor_music.exe"),
        "essentia_streaming_extractor_music.exe",
    ),
    ("Linux", "x86_64"): (
        "https://essentia.upf.edu/extractors/essentia-extractors-v2.1_beta2-linux-x86_64.tar.gz",
        ("streaming_extractor_music", "essentia_streaming_extractor_music"),
        "essentia_streaming_extractor_music",
    ),
    ("Linux", "i686"): (
        "https://essentia.upf.edu/extractors/essentia-extractors-v2.1_beta2-linux-i686.tar.gz",
        ("streaming_extractor_music", "essentia_streaming_extractor_music"),
        "essentia_streaming_extractor_music",
    ),
    ("Darwin", "x86_64"): (
        "https://essentia.upf.edu/extractors/essentia-extractors-v2.1_beta2-osx-x86_64.tar.gz",
        ("streaming_extractor_music", "essentia_streaming_extractor_music"),
        "essentia_streaming_extractor_music",
    ),
}


def _normalize_arch(raw: str) -> str:
    value = str(raw or "").strip().lower()
    mapping = {
        "amd64": "amd64",
        "x86_64": "x86_64",
        "x64": "amd64" if platform.system() == "Windows" else "x86_64",
        "i386": "x86",
        "i686": "i686" if platform.system() != "Windows" else "x86",
        "x86": "x86",
    }
    return mapping.get(value, value)


def _download_spec() -> tuple[str, tuple[str, ...], str]:
    system = platform.system()
    arch = _normalize_arch(platform.machine())
    spec = DOWNLOADS.get((system, arch))
    if spec:
        return spec

    supported = ", ".join(f"{sys_name}/{arch_name}" for sys_name, arch_name in sorted(DOWNLOADS))
    raise SystemExit(
        "No official Essentia bootstrap mapping for "
        f"{system}/{arch}. Supported dev platforms: {supported}. "
        "On Raspberry Pi, prefer the official Rolfsound image or set "
        "`essentia_extractor_path` manually."
    )


def _target_path(binary_name: str) -> Path:
    return TARGET_DIR / binary_name


def _ensure_config(extractor_path: Path) -> None:
    data: dict = {}
    if CONFIG_PATH.exists():
        with CONFIG_PATH.open("r", encoding="utf-8") as handle:
            data = json.load(handle)

    data["essentia_extractor_path"] = str(extractor_path)
    data.setdefault("essentia_profile_path", "./config/essentia_profile.yaml")

    with CONFIG_PATH.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=4)
        handle.write("\n")


def _mark_executable(path: Path) -> None:
    if os.name == "nt":
        return
    current = path.stat().st_mode
    path.chmod(current | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _extract_binary(archive_path: Path, binary_names: tuple[str, ...], target_path: Path) -> None:
    with tarfile.open(archive_path, "r:gz") as archive:
        member = next(
            (
                item for item in archive.getmembers()
                if Path(item.name).name in binary_names
            ),
            None,
        )
        if member is None:
            raise SystemExit(
                "Could not find any supported music extractor binary inside downloaded "
                f"Essentia archive. Looked for: {', '.join(binary_names)}"
            )

        TARGET_DIR.mkdir(parents=True, exist_ok=True)
        with archive.extractfile(member) as source, target_path.open("wb") as dest:
            if source is None:
                raise SystemExit(
                    "Could not read the Essentia music extractor from the downloaded archive"
                )
            dest.write(source.read())

    _mark_executable(target_path)


def _download(url: str, output_path: Path) -> None:
    with urllib.request.urlopen(url) as response, output_path.open("wb") as handle:
        handle.write(response.read())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Download and configure the Essentia music extractor for local dev.")
    parser.add_argument("--force", action="store_true", help="Redownload even if the local extractor already exists.")
    args = parser.parse_args(argv)

    url, archive_binary_names, installed_binary_name = _download_spec()
    target_path = _target_path(installed_binary_name)

    if target_path.exists() and not args.force:
        _ensure_config(target_path.resolve(strict=False))
        print(f"Essentia already present: {target_path}")
        print("config.json updated.")
        return 0

    with tempfile.TemporaryDirectory(prefix="rolfsound_essentia_dl_") as tmpdir:
        archive_path = Path(tmpdir) / "essentia.tar.gz"
        print(f"Downloading Essentia from {url}")
        _download(url, archive_path)
        _extract_binary(archive_path, archive_binary_names, target_path)

    _ensure_config(target_path.resolve(strict=False))
    print(f"Installed Essentia extractor to {target_path}")
    print("config.json updated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

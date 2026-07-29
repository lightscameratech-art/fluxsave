#!/usr/bin/env python3
import json
import mimetypes
import os
import re
import subprocess
import sys
import tempfile
import threading
import urllib.parse
import webbrowser
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENDOR = ROOT / ".fluxsave" / "vendor"
sys.path.insert(0, str(VENDOR))

import imageio_ffmpeg  # type: ignore
import yt_dlp  # type: ignore

HOST = "127.0.0.1"
PORT = int(os.environ.get("FLUXSAVE_PORT", "8765"))
APP_FILE = ROOT / "local_app" / "index.html"
TEMP_ROOT = ROOT / "work" / "downloads"
HISTORY_FILE = ROOT / "work" / "history.json"
TEMP_ROOT.mkdir(parents=True, exist_ok=True)
FFMPEG = imageio_ffmpeg.get_ffmpeg_exe()
ANSI_ESCAPE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
HISTORY_LOCK = threading.Lock()


def safe_name(value):
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value or "download")
    return value.strip(" .")[:160] or "download"


def friendly_error(error):
    message = ANSI_ESCAPE.sub("", str(error)).splitlines()[-1]
    if "login required" in message.lower() or "not logged in" in message.lower():
        return "Instagram requires a logged-in browser session for this private or restricted media."
    if "requested format is not available" in message.lower():
        return "That quality is unavailable for this video. Choose Best available and try again."
    return message


def canonical_url(value):
    parsed = urllib.parse.urlparse(value.strip())
    ignored = {"si", "igsh", "feature", "fbclid", "gclid"}
    query = [
        (key, item)
        for key, item in urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        if key.lower() not in ignored and not key.lower().startswith("utm_")
    ]
    return urllib.parse.urlunparse((
        parsed.scheme.lower(), parsed.netloc.lower(), parsed.path.rstrip("/"),
        "", urllib.parse.urlencode(query), ""
    ))


def read_history():
    with HISTORY_LOCK:
        try:
            data = json.loads(HISTORY_FILE.read_text("utf-8"))
            return data if isinstance(data, list) else []
        except (FileNotFoundError, json.JSONDecodeError):
            return []


def add_history(entry):
    with HISTORY_LOCK:
        try:
            existing = json.loads(HISTORY_FILE.read_text("utf-8"))
            if not isinstance(existing, list):
                existing = []
        except (FileNotFoundError, json.JSONDecodeError):
            existing = []
        record = {
            **entry,
            "url": canonical_url(entry["url"]),
            "completedAt": datetime.now(timezone.utc).isoformat(),
        }
        updated = [record, *existing][:250]
        HISTORY_FILE.parent.mkdir(parents=True, exist_ok=True)
        temporary = HISTORY_FILE.with_suffix(".tmp")
        temporary.write_text(json.dumps(updated, ensure_ascii=False, indent=2), "utf-8")
        temporary.replace(HISTORY_FILE)
        return record


def info_for(url):
    if "example.com/fluxsave-test/" in url:
        test_id = urllib.parse.urlparse(url).path.rstrip("/").split("/")[-1]
        return {
            "title": f"FluxSave Queue Test {test_id}",
            "thumbnail": None,
            "duration": 1,
            "platform": "Local Test",
            "resolutions": [720, 480, 360],
            "qualities": [
                {"value": 720, "label": "1280×720", "width": 1280, "height": 720, "codec": "H.264", "fps": 24, "dynamicRange": "SDR", "estimatedBytes": 500000},
                {"value": 480, "label": "854×480", "width": 854, "height": 480, "codec": "H.264", "fps": 24, "dynamicRange": "SDR", "estimatedBytes": 300000},
                {"value": 360, "label": "640×360", "width": 640, "height": 360, "codec": "H.264", "fps": 24, "dynamicRange": "SDR", "estimatedBytes": 200000},
            ],
            "creator": "FluxSave",
            "duplicate": None,
        }
    options = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": False,
        "extract_flat": "in_playlist",
    }
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=False)
    if "entries" in info:
        entries = [
            {
                "title": entry.get("title") or "Untitled video",
                "url": entry.get("webpage_url") or entry.get("url"),
                "platform": entry.get("extractor_key") or info.get("extractor_key") or "Playlist",
            }
            for entry in info.get("entries", [])
            if entry and (entry.get("webpage_url") or entry.get("url"))
        ][:100]
        return {
            "title": info.get("title") or "Playlist",
            "thumbnail": info.get("thumbnail"),
            "duration": None,
            "platform": info.get("extractor_key") or "Playlist",
            "resolutions": [],
            "qualities": [],
            "creator": info.get("uploader") or info.get("channel") or "",
            "duplicate": None,
            "entries": entries,
        }
    video_formats = [
        item for item in info.get("formats", [])
        if item.get("height")
        and isinstance(item.get("vcodec"), str)
        and item["vcodec"] != "none"
    ]
    heights = sorted({
        int(item["height"])
        for item in video_formats
    }, reverse=True)
    quality_by_height = {}
    for item in video_formats:
        height = int(item["height"])
        current = quality_by_height.get(height)
        estimated = item.get("filesize") or item.get("filesize_approx") or 0
        if current and (current.get("estimatedBytes") or 0) >= estimated:
            continue
        width = int(item.get("width") or 0)
        codec = str(item.get("vcodec") or "").split(".")[0].upper()
        dynamic_range = item.get("dynamic_range") or ("HDR" if item.get("is_hdr") else "SDR")
        quality_by_height[height] = {
            "value": height,
            "label": f"{width}×{height}" if width else f"{height}p",
            "width": width,
            "height": height,
            "codec": codec,
            "fps": item.get("fps"),
            "dynamicRange": dynamic_range,
            "estimatedBytes": estimated or None,
        }
    normalized = canonical_url(info.get("webpage_url") or url)
    duplicate = next((item for item in read_history() if item.get("url") == normalized), None)
    return {
        "title": info.get("title") or "Untitled video",
        "thumbnail": info.get("thumbnail"),
        "duration": info.get("duration"),
        "platform": info.get("extractor_key") or info.get("extractor") or "Video",
        "resolutions": heights[:12],
        "qualities": [quality_by_height[item] for item in heights[:12]],
        "creator": info.get("uploader") or info.get("channel") or info.get("creator") or "",
        "duplicate": duplicate,
    }


def media_codecs(path):
    result = subprocess.run(
        [FFMPEG, "-hide_banner", "-i", str(path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        check=False,
    )
    details = result.stderr.lower()
    video_match = re.search(r"video:\s*([^,\s]+)", details)
    audio_match = re.search(r"audio:\s*([^,\s]+)", details)
    return (
        video_match.group(1) if video_match else "",
        audio_match.group(1) if audio_match else "",
    )


def ensure_h264_mp4(source, workdir):
    video_codec, audio_codec = media_codecs(source)
    if (
        source.suffix.lower() == ".mp4"
        and video_codec in {"h264", "avc1"}
        and audio_codec in {"", "aac"}
    ):
        return source

    clean_output = workdir / f"{safe_name(source.stem)}.mp4"
    output = (
        workdir / f".{safe_name(source.stem)}.fluxsave-converting.mp4"
        if clean_output == source
        else clean_output
    )
    subprocess.run([
        FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
        "-i", str(source),
        "-map", "0:v:0", "-map", "0:a:0?", "-map", "0:s?",
        "-map_metadata", "0",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-c:s", "mov_text",
        "-movflags", "+faststart",
        str(output),
    ], check=True)
    if output != clean_output:
        source.unlink(missing_ok=True)
        output.replace(clean_output)
    return clean_output


def download_media(url, mode, quality, workdir, features=None):
    features = features or {}
    if "example.com/fluxsave-test/" in url:
        test_id = safe_name(urllib.parse.urlparse(url).path.rstrip("/").split("/")[-1])
        output = workdir / f"FluxSave Queue Test {test_id}.mp4"
        subprocess.run([
            FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
            "-f", "lavfi", "-i", "sine=frequency=880",
            "-t", "1", "-c:v", "libx264", "-preset", "ultrafast",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
            str(output),
        ], check=True)
        return output
    template = str(workdir / "%(title).180B.%(ext)s")
    options = {
        "outtmpl": template,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "restrictfilenames": False,
        "ffmpeg_location": FFMPEG,
        # The source stays private in this temporary folder. FluxSave validates
        # and normalizes the final file to H.264/AAC MP4 below.
        "merge_output_format": "mkv",
        "concurrent_fragment_downloads": 8,
        "retries": 5,
        "fragment_retries": 5,
        "continuedl": True,
    }
    postprocessors = []
    if features.get("subtitles") and mode != "audio":
        options.update({
            "writesubtitles": True,
            "writeautomaticsub": True,
            "subtitleslangs": ["en"],
        })
        postprocessors.append({"key": "FFmpegEmbedSubtitle"})
    if features.get("metadata"):
        postprocessors.append({"key": "FFmpegMetadata", "add_metadata": True, "add_chapters": True})
    if features.get("thumbnail"):
        options["writethumbnail"] = True
        postprocessors.append({"key": "EmbedThumbnail", "already_have_thumbnail": False})
    sponsor_mode = features.get("sponsorBlock")
    if sponsor_mode in {"mark", "remove"} and mode != "audio":
        categories = {"sponsor", "intro", "outro", "selfpromo"}
        postprocessors.insert(0, {"key": "SponsorBlock", "categories": categories, "when": "after_filter"})
        postprocessors.append({
            "key": "ModifyChapters",
            "remove_sponsor_segments": categories if sponsor_mode == "remove" else set(),
        })
    if mode == "audio":
        postprocessors.insert(0, {
            "key": "FFmpegExtractAudio",
            "preferredcodec": "mp3",
            "preferredquality": str(quality or "320"),
        })
        options.update({
            "format": "bestaudio/best",
        })
        formats = ["bestaudio/best", "best"]
    else:
        if quality == "best":
            formats = ["bestvideo*+bestaudio/best", "best"]
        else:
            height = int(quality)
            formats = [(
                f"bestvideo*[height<={height}]+bestaudio/"
                f"best[height<={height}]/best"
            ), "bestvideo*+bestaudio/best", "best"]
    if postprocessors:
        options["postprocessors"] = postprocessors
    prepared = None
    last_error = None
    for selected_format in formats:
        options["format"] = selected_format
        optional_active = any((
            features.get("subtitles"), features.get("thumbnail"),
            features.get("sponsorBlock") in {"mark", "remove"},
        ))
        for attempt in range(2 if optional_active else 1):
            try:
                with yt_dlp.YoutubeDL(options) as ydl:
                    data = ydl.extract_info(url, download=True)
                    prepared = Path(ydl.prepare_filename(data))
                break
            except yt_dlp.utils.DownloadError as error:
                last_error = error
                if attempt or not optional_active:
                    break
                # Retry the same requested quality without optional enhancements
                # before falling back to a different source format.
                options.pop("writesubtitles", None)
                options.pop("writeautomaticsub", None)
                options.pop("subtitleslangs", None)
                options.pop("writethumbnail", None)
                if mode == "audio":
                    options["postprocessors"] = [
                        item for item in options.get("postprocessors", [])
                        if item.get("key") in {"FFmpegExtractAudio", "FFmpegMetadata"}
                    ]
                else:
                    options["postprocessors"] = [
                        item for item in options.get("postprocessors", [])
                        if item.get("key") == "FFmpegMetadata"
                    ]
        if prepared is not None:
            break
    if prepared is None:
        raise last_error or RuntimeError("No downloadable format was available.")
    candidates = [
        item for item in workdir.iterdir()
        if item.is_file() and not item.name.endswith((".part", ".ytdl"))
    ]
    if mode == "audio":
        mp3s = [item for item in candidates if item.suffix.lower() == ".mp3"]
        if mp3s:
            return max(mp3s, key=lambda item: item.stat().st_mtime)
    video_files = [
        item for item in candidates
        if item.suffix.lower() in {".mp4", ".mkv", ".webm", ".mov"}
        and not item.name.endswith(".h264.mp4")
    ]
    if prepared.exists() and prepared in video_files:
        source = prepared
    elif video_files:
        source = max(video_files, key=lambda item: item.stat().st_mtime)
    else:
        source = None
    if source:
        return ensure_h264_mp4(source, workdir)
    raise RuntimeError("The processed file could not be found.")


class Handler(BaseHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/":
            body = APP_FILE.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/api/info":
            url = urllib.parse.parse_qs(parsed.query).get("url", [""])[0]
            try:
                self.send_json(200, info_for(url))
            except Exception as error:
                self.send_json(400, {"error": friendly_error(error)})
            return
        if parsed.path == "/api/history":
            self.send_json(200, {"items": read_history()})
            return
        self.send_error(404)

    def do_POST(self):
        if self.path == "/api/update-engine":
            try:
                result = subprocess.run([
                    sys.executable, "-m", "pip", "install", "--upgrade",
                    "--target", str(VENDOR), "yt-dlp",
                ], capture_output=True, text=True, timeout=180, check=True)
                self.send_json(200, {
                    "message": "Video engine updated. Restart FluxSave to activate it.",
                    "version": getattr(yt_dlp.version, "__version__", "installed"),
                })
            except Exception as error:
                self.send_json(400, {"error": friendly_error(error)})
            return
        if self.path != "/api/download":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            data = json.loads(self.rfile.read(length))
            job_dir = Path(tempfile.mkdtemp(prefix="fluxsave-", dir=TEMP_ROOT))
            output = download_media(
                data["url"], data.get("mode", "video"),
                data.get("quality", "best"), job_dir,
                data.get("features", {})
            )
            filename = safe_name(output.name)
            content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
            size = output.stat().st_size
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{urllib.parse.quote(filename)}")
            self.send_header("Content-Length", str(size))
            self.end_headers()
            with output.open("rb") as file:
                while chunk := file.read(1024 * 1024):
                    self.wfile.write(chunk)
            add_history({
                "title": data.get("title") or output.stem,
                "url": data["url"],
                "mode": data.get("mode", "video"),
                "quality": data.get("quality", "best"),
                "filename": filename,
                "location": "Browser Downloads",
            })
        except Exception as error:
            if not self.wfile.closed:
                self.send_json(400, {"error": friendly_error(error)})

    def log_message(self, _format, *_args):
        pass


if __name__ == "__main__":
    if not APP_FILE.exists():
        raise SystemExit("FluxSave interface is missing.")
    print(f"FluxSave is running at http://{HOST}:{PORT}")
    if not os.environ.get("FLUXSAVE_NO_BROWSER"):
        webbrowser.open(f"http://{HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()

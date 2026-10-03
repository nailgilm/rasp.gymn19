#!/usr/bin/env python3
import hashlib
import hmac
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote

DATA = Path(os.environ.get("UPLOAD_DATA_DIR", "/data"))
MAX_BYTES = int(os.environ.get("UPLOAD_MAX_BYTES", str(8 * 1024 * 1024)))
UPLOAD_PASSWORD = os.environ.get("UPLOAD_PASSWORD", "")
PUBLISH_TOKEN = os.environ.get("PUBLISH_TOKEN", "")
PENDING = DATA / "pending.rtt"
STATUS = DATA / "status.json"
ARCHIVE = DATA / "archive"


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def read_status():
    try:
        return json.loads(STATUS.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"status": "idle"}


def write_status(value):
    DATA.mkdir(parents=True, exist_ok=True)
    temporary = STATUS.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, STATUS)


class Handler(BaseHTTPRequestHandler):
    server_version = "Gymn19ScheduleUpload/1.1"

    def log_message(self, pattern, *args):
        print(f"{self.address_string()} - {pattern % args}", flush=True)

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def authorized(self, expected):
        supplied = self.headers.get("Authorization", "")
        if supplied.startswith("Bearer "):
            supplied = supplied[7:]
        return bool(expected) and hmac.compare_digest(supplied, expected)

    def read_body(self, limit):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length < 1 or length > limit:
            return None
        return self.rfile.read(length)

    def do_GET(self):
        if self.path == "/healthz":
            self.send_json(200, {"ok": True})
            return
        if self.path == "/status":
            if not self.authorized(UPLOAD_PASSWORD):
                self.send_json(401, {"error": "Неверный пароль"})
                return
            self.send_json(200, read_status())
            return
        if self.path == "/pending":
            if not self.authorized(PUBLISH_TOKEN):
                self.send_json(401, {"error": "unauthorized"})
                return
            if not PENDING.is_file():
                self.send_response(204)
                self.end_headers()
                return
            status = read_status()
            body = PENDING.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Schedule-Sha256", status.get("sha256", ""))
            self.send_header("X-Schedule-Name", quote(status.get("originalName", "schedule.rtt"), safe=""))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/upload":
            if not self.authorized(UPLOAD_PASSWORD):
                self.send_json(401, {"error": "Неверный пароль"})
                return
            body = self.read_body(MAX_BYTES)
            raw_name = unquote(self.headers.get("X-Filename", "schedule.rtt"))
            name = Path(raw_name).name
            if body is None:
                self.send_json(413, {"error": "Файл пустой или превышает допустимый размер"})
                return
            if not name.lower().endswith(".rtt") or not body.startswith(b"[General]"):
                self.send_json(400, {"error": "Выбранный файл не похож на расписание «Ректора» (.rtt)"})
                return
            digest = hashlib.sha256(body).hexdigest()
            DATA.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix="pending-", suffix=".rtt", dir=DATA)
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(body)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, PENDING)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            status = {
                "status": "pending",
                "message": "Файл принят. Ожидается обработка программой «Ректор».",
                "originalName": name,
                "sha256": digest,
                "size": len(body),
                "uploadedAt": utc_now(),
            }
            write_status(status)
            self.send_json(202, status)
            return
        if self.path == "/processing":
            if not self.authorized(PUBLISH_TOKEN):
                self.send_json(401, {"error": "unauthorized"})
                return
            body = self.read_body(16 * 1024)
            payload = json.loads((body or b"{}").decode("utf-8"))
            current = read_status()
            if payload.get("sha256") != current.get("sha256"):
                self.send_json(409, {"error": "queue changed"})
                return
            current.update({"status": "processing", "message": "Расписание обрабатывается.", "startedAt": utc_now()})
            write_status(current)
            self.send_json(200, current)
            return
        if self.path == "/complete":
            if not self.authorized(PUBLISH_TOKEN):
                self.send_json(401, {"error": "unauthorized"})
                return
            body = self.read_body(32 * 1024)
            payload = json.loads((body or b"{}").decode("utf-8"))
            current = read_status()
            if payload.get("sha256") != current.get("sha256"):
                self.send_json(409, {"error": "queue changed"})
                return
            success = payload.get("status") == "success"
            current.update({
                "status": "success" if success else "error",
                "message": payload.get("message", "Расписание опубликовано." if success else "Ошибка обработки."),
                "finishedAt": utc_now(),
            })
            if success and PENDING.is_file():
                ARCHIVE.mkdir(parents=True, exist_ok=True)
                stamp = re.sub(r"[^0-9]", "", current["finishedAt"])[:14]
                os.replace(PENDING, ARCHIVE / f"{stamp}-{current['sha256'][:12]}.rtt")
            write_status(current)
            self.send_json(200, current)
            return
        self.send_json(404, {"error": "not found"})


if __name__ == "__main__":
    if not UPLOAD_PASSWORD or not PUBLISH_TOKEN:
        raise SystemExit("UPLOAD_PASSWORD and PUBLISH_TOKEN are required")
    DATA.mkdir(parents=True, exist_ok=True)
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()

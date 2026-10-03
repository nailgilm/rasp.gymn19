#!/usr/bin/env python3
import base64
import binascii
import hmac
import json
import os
import re
import shutil
import tarfile
import tempfile
import threading
import uuid
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DATA = Path(os.environ.get("UPLOAD_DATA_DIR", "/data"))
PUBLIC_DATA = Path(os.environ.get("SCHEDULE_DATA_DIR", "/schedule-data"))
MAX_BYTES = int(os.environ.get("UPLOAD_MAX_BYTES", str(16 * 1024 * 1024)))
UPLOAD_PASSWORD = os.environ.get("UPLOAD_PASSWORD", "")
STATUS = DATA / "status.json"
SUBSTITUTIONS = DATA / "substitutions.json"
ARCHIVE = DATA / "html-archive"
DATASETS = ("classes", "teachers", "rooms")
FILE_NAME = re.compile(r"^index(?:\d+)?\.html?$", re.IGNORECASE)
PAGE_REFERENCE = re.compile(rb"index\d+\.html?", re.IGNORECASE)
PUBLISH_LOCK = threading.Lock()


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


def read_substitutions():
    try:
        value = json.loads(SUBSTITUTIONS.read_text(encoding="utf-8"))
        return value if isinstance(value, list) else []
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def write_substitutions(value):
    DATA.mkdir(parents=True, exist_ok=True)
    temporary = SUBSTITUTIONS.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    os.replace(temporary, SUBSTITUTIONS)


def substitution_key(value):
    return (value.get("className"), value.get("day"), value.get("lesson"))


def update_substitution(payload):
    action = payload.get("action", "set")
    if action == "set-period":
        absent = str(payload.get("absentTeacher", "")).strip()
        date_from = str(payload.get("dateFrom", "")).strip()
        date_to = str(payload.get("dateTo", "")).strip()
        plan = payload.get("plan")
        try:
            start = date.fromisoformat(date_from)
            finish = date.fromisoformat(date_to)
        except ValueError:
            raise ValueError("Неверно указан период отсутствия") from None
        if not absent or finish < start or (finish - start).days > 62 or not isinstance(plan, list) or not plan:
            raise ValueError("Проверьте учителя, период и план замен")
        period_id = uuid.uuid4().hex
        prepared = []
        for item in plan:
            class_name = str(item.get("className", "")).strip()
            day = str(item.get("day", "")).strip()
            replacement = str(item.get("replacementTeacher", "")).strip()
            try:
                lesson = int(item.get("lesson", 0))
            except (TypeError, ValueError):
                lesson = 0
            if not class_name or not day or not replacement or replacement == absent or lesson < 1 or lesson > 20:
                raise ValueError("План содержит незаполненную замену")
            prepared.append({
                "className": class_name, "day": day, "lesson": lesson,
                "absentTeacher": absent, "replacementTeacher": replacement,
                "dateFrom": date_from, "dateTo": date_to,
                "periodId": period_id, "createdAt": utc_now(),
            })
        keys = {substitution_key(item) for item in prepared}
        current = [item for item in read_substitutions() if substitution_key(item) not in keys]
        current.extend(prepared)
        write_substitutions(current)
        return {"status": "success", "message": "План замен на период сохранён.", "substitutions": current, "periodId": period_id}
    class_name = str(payload.get("className", "")).strip()
    day = str(payload.get("day", "")).strip()
    absent = str(payload.get("absentTeacher", "")).strip()
    replacement = str(payload.get("replacementTeacher", "")).strip()
    try:
        lesson = int(payload.get("lesson", 0))
    except (TypeError, ValueError):
        lesson = 0
    if not class_name or not day or lesson < 1 or lesson > 20:
        raise ValueError("Не указаны класс, день или номер урока")
    current = [item for item in read_substitutions() if substitution_key(item) != (class_name, day, lesson)]
    if action == "remove":
        write_substitutions(current)
        return {"status": "success", "message": "Замена снята.", "substitutions": current}
    if not absent or not replacement or absent == replacement:
        raise ValueError("Нужно выбрать отсутствующего и заменяющего учителя")
    current.append({
        "className": class_name,
        "day": day,
        "lesson": lesson,
        "absentTeacher": absent,
        "replacementTeacher": replacement,
        "createdAt": utc_now(),
    })
    write_substitutions(current)
    return {"status": "success", "message": "Замена назначена.", "substitutions": current}


def validate_payload(payload):
    supplied = payload.get("datasets")
    if not isinstance(supplied, dict) or set(supplied) != set(DATASETS):
        raise ValueError("Нужно выбрать три комплекта HTML: классы, учителя и кабинеты")

    decoded = {}
    total_size = 0
    for dataset in DATASETS:
        entries = supplied.get(dataset)
        if not isinstance(entries, list) or not entries:
            raise ValueError(f"Не выбраны HTML-файлы раздела «{dataset}»")
        files = {}
        for entry in entries:
            name = Path(str(entry.get("name", ""))).name.lower()
            if not FILE_NAME.fullmatch(name) or name in files:
                raise ValueError(f"Недопустимое или повторяющееся имя файла: {name or 'без имени'}")
            try:
                body = base64.b64decode(entry.get("content", ""), validate=True)
            except (binascii.Error, ValueError, TypeError):
                raise ValueError(f"Не удалось прочитать файл {name}") from None
            total_size += len(body)
            if total_size > MAX_BYTES:
                raise ValueError("Общий размер HTML-файлов превышает допустимый")
            lowered = body[:8192].lower()
            if len(body) < 80 or b"<html" not in lowered:
                raise ValueError(f"Файл {name} не похож на HTML-экспорт «Ректора»")
            files[name] = body

        if "index.html" not in files:
            raise ValueError(f"В разделе «{dataset}» отсутствует главный файл index.html")
        references = {item.decode("ascii").lower() for item in PAGE_REFERENCE.findall(files["index.html"])}
        missing = sorted(references - set(files))
        if missing:
            raise ValueError(f"В разделе «{dataset}» не выбраны файлы: {', '.join(missing)}")
        decoded[dataset] = files
    return decoded, total_size


def archive_current(stamp):
    ARCHIVE.mkdir(parents=True, exist_ok=True)
    target = ARCHIVE / f"schedule-html-{stamp}.tar.gz"
    with tarfile.open(target, "w:gz") as archive:
        for name in (*DATASETS, "version.json"):
            source = PUBLIC_DATA / name
            if source.exists():
                archive.add(source, arcname=name)
    return target


def publish(files, total_size):
    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    transaction = uuid.uuid4().hex
    staging = PUBLIC_DATA / f".incoming-{transaction}"
    previous = PUBLIC_DATA / f".previous-{transaction}"
    staging.mkdir()
    previous.mkdir()
    try:
        for dataset, pages in files.items():
            destination = staging / dataset
            destination.mkdir()
            for name, body in pages.items():
                (destination / name).write_bytes(body)

        archive = archive_current(stamp)
        moved = []
        try:
            for dataset in DATASETS:
                current = PUBLIC_DATA / dataset
                if current.exists():
                    os.replace(current, previous / dataset)
                os.replace(staging / dataset, current)
                moved.append(dataset)

            version = {
                "source": "Ручная загрузка HTML",
                "sourceModified": utc_now(),
                "published": utc_now(),
                "files": sum(len(pages) for pages in files.values()),
            }
            fd, temporary = tempfile.mkstemp(prefix="version-", suffix=".json", dir=PUBLIC_DATA)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(version, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(temporary, 0o644)
            os.replace(temporary, PUBLIC_DATA / "version.json")
            write_substitutions([])
        except Exception:
            for dataset in moved:
                current = PUBLIC_DATA / dataset
                if current.exists():
                    shutil.rmtree(current)
            for dataset in DATASETS:
                old = previous / dataset
                if old.exists():
                    os.replace(old, PUBLIC_DATA / dataset)
            raise

        return {
            "status": "success",
            "message": "Новое HTML-расписание опубликовано.",
            "files": sum(len(pages) for pages in files.values()),
            "size": total_size,
            "publishedAt": utc_now(),
            "archive": archive.name,
        }
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        shutil.rmtree(previous, ignore_errors=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "Gymn19ScheduleUpload/2.0"

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

    def authorized(self):
        supplied = self.headers.get("Authorization", "")
        if supplied.startswith("Bearer "):
            supplied = supplied[7:]
        return bool(UPLOAD_PASSWORD) and hmac.compare_digest(supplied, UPLOAD_PASSWORD)

    def read_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length < 2 or length > MAX_BYTES * 2:
            return None
        return self.rfile.read(length)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            self.send_json(200, {"ok": True})
            return
        if path == "/status":
            if not self.authorized():
                self.send_json(401, {"error": "Неверный пароль"})
                return
            self.send_json(200, read_status())
            return
        if path == "/substitutions":
            self.send_json(200, {"substitutions": read_substitutions()})
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/substitutions":
            if not self.authorized():
                self.send_json(401, {"error": "Неверный пароль"})
                return
            body = self.read_body()
            if body is None:
                self.send_json(400, {"error": "Пустой запрос"})
                return
            try:
                payload = json.loads(body.decode("utf-8"))
                with PUBLISH_LOCK:
                    result = update_substitution(payload)
                self.send_json(200, result)
            except (UnicodeDecodeError, json.JSONDecodeError):
                self.send_json(400, {"error": "Повреждённый запрос"})
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
            return
        if self.path != "/upload-html":
            self.send_json(404, {"error": "not found"})
            return
        if not self.authorized():
            self.send_json(401, {"error": "Неверный пароль"})
            return
        body = self.read_body()
        if body is None:
            self.send_json(413, {"error": "Пакет пустой или превышает допустимый размер"})
            return
        try:
            payload = json.loads(body.decode("utf-8"))
            files, total_size = validate_payload(payload)
            with PUBLISH_LOCK:
                status = publish(files, total_size)
            write_status(status)
            self.send_json(200, status)
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {"error": "Повреждённый запрос загрузки"})
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except Exception as error:
            failure = {"status": "error", "message": f"Ошибка публикации: {error}", "finishedAt": utc_now()}
            write_status(failure)
            self.send_json(500, {"error": failure["message"]})


if __name__ == "__main__":
    if not UPLOAD_PASSWORD:
        raise SystemExit("UPLOAD_PASSWORD is required")
    DATA.mkdir(parents=True, exist_ok=True)
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()

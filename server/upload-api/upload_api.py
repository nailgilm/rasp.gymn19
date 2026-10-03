#!/usr/bin/env python3
import base64
import binascii
import hmac
import json
import os
import re
import secrets
import shutil
import tarfile
import tempfile
import threading
import uuid
from datetime import date, datetime, timezone
from http.cookies import SimpleCookie
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
BELL_TIMES = {
    1: "08:00–08:45", 2: "08:50–09:35", 3: "09:45–10:30", 4: "10:40–11:25",
    5: "11:40–12:25", 6: "12:40–13:25", 7: "13:35–14:20", 8: "14:25–15:10",
    9: "15:15–16:00", 10: "16:05–16:50", 11: "16:55–17:40", 12: "17:45–18:30",
    13: "18:35–19:20", 14: "19:25–20:10",
}
FILE_NAME = re.compile(r"^index(?:\d+)?\.html?$", re.IGNORECASE)
PAGE_REFERENCE = re.compile(rb"index\d+\.html?", re.IGNORECASE)
PUBLISH_LOCK = threading.Lock()
SESSION_LOCK = threading.Lock()
SESSIONS = {}
SESSION_TTL = 8 * 60 * 60


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
    classes = value.get("classNames") or [value.get("className")]
    return (value.get("date") or value.get("day"), tuple(classes), value.get("lesson"))


def parse_iso_date(value, message="Неверно указана дата"):
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        raise ValueError(message) from None


def teacher_absent(records, teacher, lesson_date):
    for item in records:
        if item.get("absentTeacher") != teacher:
            continue
        start = item.get("dateFrom")
        finish = item.get("dateTo")
        if start and finish and start <= lesson_date <= finish:
            return True
    return False


def update_substitution(payload):
    action = payload.get("action", "set")
    current = read_substitutions()
    if action == "remove-period":
        period_id = str(payload.get("periodId", "")).strip()
        if not period_id:
            raise ValueError("Не указан период замен")
        updated = [item for item in current if item.get("periodId") != period_id]
        write_substitutions(updated)
        return {"status": "success", "message": "Период замен удалён.", "substitutions": updated}
    if action != "set-period":
        raise ValueError("Неизвестная операция с заменами")

    absent = str(payload.get("absentTeacher", "")).strip()
    date_from = str(payload.get("dateFrom", "")).strip()
    date_to = str(payload.get("dateTo", "")).strip()
    plan = payload.get("plan")
    start = parse_iso_date(date_from, "Неверно указан период отсутствия")
    finish = parse_iso_date(date_to, "Неверно указан период отсутствия")
    if not absent or finish < start or (finish - start).days > 62 or not isinstance(plan, list) or not plan:
        raise ValueError("Проверьте учителя, период и план замен")

    period_id = uuid.uuid4().hex
    prepared = []
    for item in plan:
        lesson_date = str(item.get("date", "")).strip()
        parsed_date = parse_iso_date(lesson_date)
        classes = item.get("classNames")
        if not isinstance(classes, list):
            classes = [item.get("className")]
        classes = [str(name).strip() for name in classes if str(name).strip()]
        day = str(item.get("day", "")).strip()
        subject = str(item.get("subject", "")).strip()
        lesson_time = str(item.get("time", "")).strip()
        replacement = str(item.get("replacementTeacher", "")).strip()
        reason = str(item.get("reason", "")).strip()
        try:
            lesson = int(item.get("lesson", 0))
        except (TypeError, ValueError):
            lesson = 0
        if not (start <= parsed_date <= finish) or not classes or not day or not subject or not lesson_time:
            raise ValueError("План содержит неполные данные урока")
        if not replacement or replacement == absent or lesson < 1 or lesson > 14:
            raise ValueError("Для каждого урока нужно выбрать корректную замену")
        if lesson_time != BELL_TIMES[lesson]:
            raise ValueError("Время урока не соответствует расписанию звонков")
        prepared.append({
            "date": lesson_date, "day": day, "lesson": lesson, "time": lesson_time,
            "classNames": classes, "subject": subject,
            "absentTeacher": absent, "replacementTeacher": replacement,
            "reason": reason or "Выбрано вручную", "dateFrom": date_from, "dateTo": date_to,
            "periodId": period_id, "createdAt": utc_now(),
        })

    keys = {substitution_key(item) for item in prepared}
    retained = [item for item in current if substitution_key(item) not in keys]
    occupied = {(item.get("replacementTeacher"), item.get("date"), int(item.get("lesson", 0))) for item in retained}
    planned = set()
    absence_records = retained + prepared
    for item in prepared:
        slot = (item["replacementTeacher"], item["date"], item["lesson"])
        if slot in occupied or slot in planned:
            raise ValueError(f'{item["replacementTeacher"]} уже назначен на другую замену {item["date"]}, урок {item["lesson"]}')
        if teacher_absent(absence_records, item["replacementTeacher"], item["date"]):
            raise ValueError(f'{item["replacementTeacher"]} отсутствует {item["date"]}')
        planned.add(slot)

    updated = retained + prepared
    write_substitutions(updated)
    return {"status": "success", "message": "Замены на весь период сохранены.", "substitutions": updated, "periodId": period_id}


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
    server_version = "Gymn19ScheduleUpload/2.2"

    def log_message(self, pattern, *args):
        print(f"{self.address_string()} - {pattern % args}", flush=True)

    def send_json(self, status, payload, headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def session_token(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        value = cookie.get("gymn19_admin")
        return value.value if value else ""

    def session_authorized(self):
        token = self.session_token()
        if not token:
            return False
        now = datetime.now(timezone.utc).timestamp()
        with SESSION_LOCK:
            expired = [key for key, deadline in SESSIONS.items() if deadline <= now]
            for key in expired:
                SESSIONS.pop(key, None)
            return SESSIONS.get(token, 0) > now

    def authorized(self):
        if self.session_authorized():
            return True
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
        if path == "/session":
            self.send_json(200, {"authenticated": self.session_authorized()})
            return
        if path == "/substitutions":
            self.send_json(200, {"substitutions": read_substitutions()})
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/session":
            body = self.read_body()
            if body is None:
                self.send_json(400, {"error": "Введите пароль"})
                return
            try:
                payload = json.loads(body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self.send_json(400, {"error": "Повреждённый запрос"})
                return
            supplied = str(payload.get("password", ""))
            if not UPLOAD_PASSWORD or not hmac.compare_digest(supplied, UPLOAD_PASSWORD):
                self.send_json(401, {"error": "Неверный пароль"})
                return
            token = secrets.token_urlsafe(32)
            with SESSION_LOCK:
                SESSIONS[token] = datetime.now(timezone.utc).timestamp() + SESSION_TTL
            cookie = f"gymn19_admin={token}; Path=/api/schedule-upload/; Max-Age={SESSION_TTL}; HttpOnly; Secure; SameSite=Strict"
            self.send_json(200, {"authenticated": True}, {"Set-Cookie": cookie})
            return
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

    def do_DELETE(self):
        if self.path != "/session":
            self.send_json(404, {"error": "not found"})
            return
        token = self.session_token()
        with SESSION_LOCK:
            SESSIONS.pop(token, None)
        cookie = "gymn19_admin=; Path=/api/schedule-upload/; Max-Age=0; HttpOnly; Secure; SameSite=Strict"
        self.send_json(200, {"authenticated": False}, {"Set-Cookie": cookie})


if __name__ == "__main__":
    if not UPLOAD_PASSWORD:
        raise SystemExit("UPLOAD_PASSWORD is required")
    DATA.mkdir(parents=True, exist_ok=True)
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()

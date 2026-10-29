#!/usr/bin/env python3
"""Akari Suite Booking System server: token auth, JSON API, live sync via long-polling.

Storage: SQLite by default (standard library only), or PostgreSQL when DATABASE_URL is set (needs psycopg).
Run: python3 server.py  (env: PORT, DB_PATH, DATABASE_URL)
"""
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import threading
import time
from datetime import date, datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORT = int(os.environ.get("PORT", "8000"))
DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "suite.db"))
DATABASE_URL = os.environ.get("DATABASE_URL", "")
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
SESSION_DAYS = 60

BOOKING_STATUSES = ("booked", "checked_in", "checked_out", "cancelled", "no_show")
INACTIVE_STATUSES = ("cancelled", "no_show")

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff', pw_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT DEFAULT '', capacity INTEGER DEFAULT 2,
  rate REAL DEFAULT 0, color TEXT DEFAULT '#4f46e5', active INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY, ref TEXT UNIQUE NOT NULL, room_id INTEGER NOT NULL REFERENCES rooms(id),
  guest_name TEXT NOT NULL, phone TEXT DEFAULT '', email TEXT DEFAULT '', guests INTEGER DEFAULT 1,
  check_in TEXT NOT NULL, check_out TEXT NOT NULL, total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'booked', source TEXT DEFAULT '', notes TEXT DEFAULT '',
  created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_bookings_dates ON bookings(check_in, check_out);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  amount REAL NOT NULL, method TEXT DEFAULT 'cash', paid_on TEXT NOT NULL, note TEXT DEFAULT '',
  created_by INTEGER, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, user_id INTEGER, action TEXT NOT NULL, booking_id INTEGER,
  detail TEXT DEFAULT '');
"""

PG_SCHEMA = re.sub(r"\bINTEGER PRIMARY KEY\b", "SERIAL PRIMARY KEY",
                   SCHEMA.replace(" COLLATE NOCASE", "").replace("REAL", "DOUBLE PRECISION"))

DEFAULT_SETTINGS = {"business_name": "Akari Suites", "currency": "₱", "check_in_time": "14:00", "check_out_time": "12:00"}


class ApiError(Exception):
    def __init__(self, status, message, extra=None):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra or {}


# ---------- storage ----------

db_lock = threading.RLock()
change_cond = threading.Condition()
_conn = None


class PgDB:
    """Minimal sqlite3-like wrapper over one autocommit psycopg connection; reconnects if it drops."""

    def __init__(self, url):
        import psycopg
        from psycopg.rows import dict_row
        self._psycopg, self._dict_row, self._url = psycopg, dict_row, url
        self._lock = threading.Lock()
        self._conn = None
        self._connect()
        self._conn.execute(PG_SCHEMA)

    def _connect(self):
        self._conn = self._psycopg.connect(self._url, autocommit=True, row_factory=self._dict_row)

    def execute(self, sql, args=()):
        sql = sql.replace("?", "%s")
        for attempt in (0, 1):
            try:
                with self._lock:
                    cur = self._conn.cursor()
                    cur.execute(sql, args)
                    return cur
            except self._psycopg.OperationalError:
                if attempt:
                    raise
                with self._lock:
                    try:
                        self._conn.close()
                    except Exception:  # noqa: BLE001
                        pass
                    self._connect()


def db():
    global _conn
    if _conn is None:
        if DATABASE_URL:
            _conn = PgDB(DATABASE_URL)
        else:
            os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
            _conn = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
            _conn.row_factory = sqlite3.Row
            _conn.execute("PRAGMA foreign_keys=ON")
            _conn.execute("PRAGMA journal_mode=WAL")
            _conn.executescript(SCHEMA)
    return _conn


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


_version = None


def get_version():
    global _version
    if _version is None:
        row = db().execute("SELECT value FROM meta WHERE key='version'").fetchone()
        _version = int(row["value"]) if row else 0
    return _version


def set_meta(key, value):
    db().execute("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                 (key, value))


def bump_version():
    global _version
    with db_lock:
        v = get_version() + 1
        set_meta("version", str(v))
        _version = v
    with change_cond:
        change_cond.notify_all()
    return v


def get_settings():
    row = db().execute("SELECT value FROM meta WHERE key='settings'").fetchone()
    s = dict(DEFAULT_SETTINGS)
    if row:
        s.update(json.loads(row["value"]))
    return s


def log(user, action, booking_id=None, detail=""):
    db().execute("INSERT INTO activity(at, user_id, action, booking_id, detail) VALUES(?,?,?,?,?)",
                 (now_iso(), user["id"] if user else None, action, booking_id, detail))


def hash_pw(password, salt=None):
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 200_000)
    return f"{salt}${dk.hex()}"


def check_pw(password, stored):
    salt, _ = stored.split("$", 1)
    return hmac.compare_digest(hash_pw(password, salt), stored)


def rows(sql, args=()):
    return [dict(r) for r in db().execute(sql, args).fetchall()]


# ---------- validation helpers ----------

def req_str(body, key, label=None, max_len=200):
    v = str(body.get(key) or "").strip()
    if not v:
        raise ApiError(400, f"{label or key} is required")
    return v[:max_len]


def opt_str(body, key, max_len=2000):
    return str(body.get(key) or "").strip()[:max_len]


def num(body, key, default=0.0):
    v = body.get(key, default)
    if v in (None, ""):
        return default
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        raise ApiError(400, f"{key} must be a number")


def iso_date(body, key, label):
    v = str(body.get(key) or "")
    try:
        return date.fromisoformat(v).isoformat()
    except ValueError:
        raise ApiError(400, f"{label} must be a valid date")


def find_conflicts(room_id, check_in, check_out, exclude_id=None):
    sql = ("SELECT id, ref, guest_name, check_in, check_out FROM bookings WHERE room_id=? "
           "AND status NOT IN ('cancelled','no_show') AND check_in < ? AND check_out > ?")
    args = [room_id, check_out, check_in]
    if exclude_id:
        sql += " AND id != ?"
        args.append(exclude_id)
    return rows(sql, args)


def new_ref():
    while True:
        ref = "BK-" + "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(5))
        if not db().execute("SELECT 1 FROM bookings WHERE ref=?", (ref,)).fetchone():
            return ref


def booking_fields(body, existing=None):
    e = existing or {}
    merged = {**e, **body}
    room_id = int(merged.get("room_id") or 0)
    if not db().execute("SELECT 1 FROM rooms WHERE id=?", (room_id,)).fetchone():
        raise ApiError(400, "Please choose a room")
    ci = iso_date(merged, "check_in", "Check-in date")
    co = iso_date(merged, "check_out", "Check-out date")
    if co <= ci:
        raise ApiError(400, "Check-out must be after check-in")
    status = merged.get("status") or "booked"
    if status not in BOOKING_STATUSES:
        raise ApiError(400, "Invalid status")
    return {
        "room_id": room_id, "guest_name": req_str(merged, "guest_name", "Guest name"),
        "phone": opt_str(merged, "phone", 50), "email": opt_str(merged, "email", 200),
        "guests": max(1, int(num(merged, "guests", 1))), "check_in": ci, "check_out": co,
        "total": max(0.0, num(merged, "total", 0)), "status": status,
        "source": opt_str(merged, "source", 50), "notes": opt_str(merged, "notes"),
    }


def load_booking(bid):
    b = db().execute("SELECT * FROM bookings WHERE id=?", (bid,)).fetchone()
    if not b:
        raise ApiError(404, "Booking not found")
    return dict(b)


# ---------- API handlers ----------

def api_setup_status(user, body, q):
    return {"needs_setup": db().execute("SELECT COUNT(*) c FROM users").fetchone()["c"] == 0}


def create_session(user_id):
    token = secrets.token_urlsafe(32)
    db().execute("INSERT INTO sessions(token, user_id, expires_at) VALUES(?,?,?)",
                 (token, user_id, time.time() + SESSION_DAYS * 86400))
    return token


def public_user(u):
    return {k: u[k] for k in ("id", "username", "name", "role", "active")}


def api_setup(user, body, q):
    with db_lock:
        if db().execute("SELECT COUNT(*) c FROM users").fetchone()["c"] > 0:
            raise ApiError(400, "Already set up")
        username = req_str(body, "username", "Username", 50)
        password = req_str(body, "password", "Password")
        if len(password) < 6:
            raise ApiError(400, "Password must be at least 6 characters")
        cur = db().execute("INSERT INTO users(username, name, role, pw_hash, created_at) VALUES(?,?,?,?,?) RETURNING id",
                           (username, opt_str(body, "name", 100) or username, "admin", hash_pw(password), now_iso()))
        uid = cur.fetchone()["id"]
        settings = get_settings()
        if body.get("business_name"):
            settings["business_name"] = opt_str(body, "business_name", 100)
        if body.get("currency"):
            settings["currency"] = opt_str(body, "currency", 5)
        set_meta("settings", json.dumps(settings))
        rooms_n = int(num(body, "rooms", 0))
        for i in range(min(rooms_n, 100)):
            db().execute("INSERT INTO rooms(name, sort, color) VALUES(?,?,?)",
                         (f"Suite {i + 1}", i, PALETTE[i % len(PALETTE)]))
        bump_version()
        return {"token": create_session(uid)}


PALETTE = ["#4f46e5", "#0891b2", "#059669", "#d97706", "#db2777", "#7c3aed", "#dc2626", "#2563eb", "#65a30d", "#0d9488"]


def api_login(user, body, q):
    u = db().execute("SELECT * FROM users WHERE lower(username)=lower(?)", (opt_str(body, "username", 50),)).fetchone()
    if not u or not u["active"] or not check_pw(str(body.get("password") or ""), u["pw_hash"]):
        time.sleep(0.5)
        raise ApiError(401, "Wrong username or password")
    return {"token": create_session(u["id"])}


def api_logout(user, body, q, token=None):
    db().execute("DELETE FROM sessions WHERE token=?", (token,))
    return {"ok": True}


def api_state(user, body, q):
    with db_lock:
        data = {
            "version": get_version(),
            "me": public_user(user),
            "settings": get_settings(),
            "rooms": rows("SELECT * FROM rooms ORDER BY sort, id"),
            "bookings": rows("SELECT * FROM bookings ORDER BY check_in, id"),
            "payments": rows("SELECT * FROM payments ORDER BY paid_on, id"),
            "users": [public_user(u) for u in rows("SELECT * FROM users ORDER BY id")],
        }
    return data


def api_wait(user, body, q):
    """Long-poll: returns as soon as the data version differs from ?v=, or after ~25s."""
    try:
        v = int(q.get("v", ["0"])[0])
    except ValueError:
        v = 0
    deadline = time.time() + 25
    with change_cond:
        while get_version() == v and time.time() < deadline:
            change_cond.wait(timeout=max(0.1, deadline - time.time()))
    return {"version": get_version()}


def api_activity(user, body, q):
    return {"activity": rows(
        "SELECT a.*, u.name AS user_name, b.ref, b.guest_name FROM activity a "
        "LEFT JOIN users u ON u.id=a.user_id LEFT JOIN bookings b ON b.id=a.booking_id "
        "ORDER BY a.id DESC LIMIT 200")}


def api_create_booking(user, body, q):
    with db_lock:
        f = booking_fields(body)
        conflicts = find_conflicts(f["room_id"], f["check_in"], f["check_out"])
        if conflicts and not body.get("force"):
            raise ApiError(409, "This room is already booked for some of these dates", {"conflicts": conflicts})
        ts = now_iso()
        cur = db().execute(
            "INSERT INTO bookings(ref, room_id, guest_name, phone, email, guests, check_in, check_out, total, "
            "status, source, notes, created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id",
            (new_ref(), f["room_id"], f["guest_name"], f["phone"], f["email"], f["guests"], f["check_in"],
             f["check_out"], f["total"], f["status"], f["source"], f["notes"], user["id"], ts, ts))
        bid = cur.fetchone()["id"]
        deposit = num(body, "deposit", 0)
        if deposit > 0:
            db().execute("INSERT INTO payments(booking_id, amount, method, paid_on, note, created_by, created_at) "
                         "VALUES(?,?,?,?,?,?,?)", (bid, deposit, opt_str(body, "deposit_method", 30) or "cash",
                                                   iso_date(body, "deposit_date", "Payment date") if body.get("deposit_date") else date.today().isoformat(), "Deposit", user["id"], ts))
        log(user, "created booking", bid, f"{f['check_in']} → {f['check_out']}")
        if deposit > 0:
            log(user, "recorded payment", bid, f"{deposit:g}")
        bump_version()
        return load_booking(bid)


def api_update_booking(user, body, q, bid):
    with db_lock:
        existing = load_booking(bid)
        f = booking_fields(body, existing)
        if f["status"] not in INACTIVE_STATUSES:
            conflicts = find_conflicts(f["room_id"], f["check_in"], f["check_out"], exclude_id=bid)
            if conflicts and not body.get("force"):
                raise ApiError(409, "This room is already booked for some of these dates", {"conflicts": conflicts})
        sets = ", ".join(f"{k}=?" for k in f)
        db().execute(f"UPDATE bookings SET {sets}, updated_at=? WHERE id=?", (*f.values(), now_iso(), bid))
        changed = [k for k in f if str(f[k]) != str(existing.get(k))]
        if changed == ["status"]:
            log(user, f"status → {f['status'].replace('_', ' ')}", bid)
        elif changed:
            log(user, "edited booking", bid, ", ".join(c.replace("_", " ") for c in changed))
        bump_version()
        return load_booking(bid)


def api_delete_booking(user, body, q, bid):
    require_admin(user)
    with db_lock:
        b = load_booking(bid)
        db().execute("DELETE FROM bookings WHERE id=?", (bid,))
        log(user, "deleted booking", None, f"{b['ref']} {b['guest_name']}")
        bump_version()
        return {"ok": True}


def api_add_payment(user, body, q, bid):
    with db_lock:
        load_booking(bid)
        amount = num(body, "amount", 0)
        if amount == 0:
            raise ApiError(400, "Enter an amount")
        paid_on = iso_date(body, "paid_on", "Payment date") if body.get("paid_on") else date.today().isoformat()
        db().execute("INSERT INTO payments(booking_id, amount, method, paid_on, note, created_by, created_at) "
                     "VALUES(?,?,?,?,?,?,?)", (bid, amount, opt_str(body, "method", 30) or "cash", paid_on,
                                               opt_str(body, "note", 200), user["id"], now_iso()))
        log(user, "recorded payment" if amount > 0 else "recorded refund", bid, f"{amount:g}")
        bump_version()
        return {"ok": True}


def api_delete_payment(user, body, q, pid):
    with db_lock:
        p = db().execute("SELECT * FROM payments WHERE id=?", (pid,)).fetchone()
        if not p:
            raise ApiError(404, "Payment not found")
        db().execute("DELETE FROM payments WHERE id=?", (pid,))
        log(user, "removed payment", p["booking_id"], f"{p['amount']:g}")
        bump_version()
        return {"ok": True}


def room_fields(body):
    return {"name": req_str(body, "name", "Room name", 60), "kind": opt_str(body, "kind", 60),
            "capacity": max(1, int(num(body, "capacity", 2))), "rate": max(0.0, num(body, "rate", 0)),
            "color": opt_str(body, "color", 9) or "#4f46e5", "active": 1 if body.get("active", True) else 0,
            "sort": int(num(body, "sort", 0))}


def api_create_room(user, body, q):
    require_admin(user)
    with db_lock:
        f = room_fields(body)
        db().execute("INSERT INTO rooms(name, kind, capacity, rate, color, active, sort) VALUES(?,?,?,?,?,?,?)",
                     tuple(f.values()))
        log(user, "added room", None, f["name"])
        bump_version()
        return {"ok": True}


def api_update_room(user, body, q, rid):
    require_admin(user)
    with db_lock:
        f = room_fields(body)
        db().execute("UPDATE rooms SET name=?, kind=?, capacity=?, rate=?, color=?, active=?, sort=? WHERE id=?",
                     (*f.values(), rid))
        log(user, "edited room", None, f["name"])
        bump_version()
        return {"ok": True}


def api_create_user(user, body, q):
    require_admin(user)
    with db_lock:
        username = req_str(body, "username", "Username", 50)
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", username):
            raise ApiError(400, "Username can only contain letters, numbers, . _ -")
        password = req_str(body, "password", "Password")
        if len(password) < 6:
            raise ApiError(400, "Password must be at least 6 characters")
        if db().execute("SELECT 1 FROM users WHERE lower(username)=lower(?)", (username,)).fetchone():
            raise ApiError(400, "Username already taken")
        role = "admin" if body.get("role") == "admin" else "staff"
        db().execute("INSERT INTO users(username, name, role, pw_hash, created_at) VALUES(?,?,?,?,?)",
                     (username, opt_str(body, "name", 100) or username, role, hash_pw(password), now_iso()))
        log(user, "added staff", None, username)
        bump_version()
        return {"ok": True}


def api_update_user(user, body, q, uid):
    require_admin(user)
    with db_lock:
        target = db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not target:
            raise ApiError(404, "User not found")
        role = "admin" if body.get("role", target["role"]) == "admin" else "staff"
        active = 1 if body.get("active", bool(target["active"])) else 0
        if uid == user["id"] and (role != "admin" or not active):
            raise ApiError(400, "You can't remove your own admin access")
        db().execute("UPDATE users SET name=?, role=?, active=? WHERE id=?",
                     (opt_str(body, "name", 100) or target["name"], role, active, uid))
        if body.get("password"):
            if len(body["password"]) < 6:
                raise ApiError(400, "Password must be at least 6 characters")
            db().execute("UPDATE users SET pw_hash=? WHERE id=?", (hash_pw(body["password"]), uid))
            db().execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        if not active:
            db().execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        log(user, "updated staff", None, target["username"])
        bump_version()
        return {"ok": True}


def api_change_password(user, body, q):
    if not check_pw(str(body.get("current") or ""), user["pw_hash"]):
        raise ApiError(400, "Current password is wrong")
    new = str(body.get("new") or "")
    if len(new) < 6:
        raise ApiError(400, "Password must be at least 6 characters")
    db().execute("UPDATE users SET pw_hash=? WHERE id=?", (hash_pw(new), user["id"]))
    return {"ok": True}


def api_settings(user, body, q):
    require_admin(user)
    with db_lock:
        s = get_settings()
        for k in DEFAULT_SETTINGS:
            if k in body:
                s[k] = opt_str(body, k, 100)
        set_meta("settings", json.dumps(s))
        log(user, "updated settings")
        bump_version()
        return s


def require_admin(user):
    if user["role"] != "admin":
        raise ApiError(403, "Only the owner/admin can do this")


PUBLIC_ROUTES = {
    ("GET", r"/api/setup"): api_setup_status,
    ("POST", r"/api/setup"): api_setup,
    ("POST", r"/api/login"): api_login,
}
ROUTES = {
    ("POST", r"/api/logout"): api_logout,
    ("GET", r"/api/state"): api_state,
    ("GET", r"/api/wait"): api_wait,
    ("GET", r"/api/activity"): api_activity,
    ("POST", r"/api/bookings"): api_create_booking,
    ("PUT", r"/api/bookings/(\d+)"): api_update_booking,
    ("DELETE", r"/api/bookings/(\d+)"): api_delete_booking,
    ("POST", r"/api/bookings/(\d+)/payments"): api_add_payment,
    ("DELETE", r"/api/payments/(\d+)"): api_delete_payment,
    ("POST", r"/api/rooms"): api_create_room,
    ("PUT", r"/api/rooms/(\d+)"): api_update_room,
    ("POST", r"/api/users"): api_create_user,
    ("PUT", r"/api/users/(\d+)"): api_update_user,
    ("POST", r"/api/password"): api_change_password,
    ("PUT", r"/api/settings"): api_settings,
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "SuiteBooking"

    def log_message(self, fmt, *args):
        if os.environ.get("QUIET") != "1":
            super().log_message(fmt, *args)

    def send_json(self, status, data):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def handle_api(self, method):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}") if length else {}
            if not isinstance(body, dict):
                raise ApiError(400, "Invalid JSON body")
            for (m, pattern), fn in PUBLIC_ROUTES.items():
                if m == method and re.fullmatch(pattern, url.path):
                    return self.send_json(200, fn(None, body, q))
            for (m, pattern), fn in ROUTES.items():
                match = re.fullmatch(pattern, url.path)
                if m == method and match:
                    token = (self.headers.get("Authorization") or "").removeprefix("Bearer ").strip()
                    user = self.auth(token)
                    args = [int(g) for g in match.groups()]
                    if fn is api_logout:
                        return self.send_json(200, fn(user, body, q, token=token))
                    return self.send_json(200, fn(user, body, q, *args))
            raise ApiError(404, "Not found")
        except ApiError as e:
            self.send_json(e.status, {"error": e.message, **e.extra})
        except json.JSONDecodeError:
            self.send_json(400, {"error": "Invalid JSON"})
        except Exception as e:  # noqa: BLE001
            self.log_error("API error: %r", e)
            self.send_json(500, {"error": "Server error"})

    def auth(self, token):
        if not token:
            raise ApiError(401, "Please log in")
        row = db().execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.active=1",
            (token, time.time())).fetchone()
        if not row:
            raise ApiError(401, "Session expired, please log in again")
        return dict(row)

    def serve_static(self):
        path = urlparse(self.path).path
        if path == "/":
            path = "/index.html"
        full = os.path.normpath(os.path.join(STATIC_DIR, path.lstrip("/")))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            full = os.path.join(STATIC_DIR, "index.html")
        with open(full, "rb") as fh:
            data = fh.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".webmanifest"):
            ctype = "application/manifest+json"
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith(("text/", "application/javascript")) else ""))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self.handle_api("GET")
        self.serve_static()

    def do_POST(self):
        self.handle_api("POST")

    def do_PUT(self):
        self.handle_api("PUT")

    def do_DELETE(self):
        self.handle_api("DELETE")


def main():
    db()
    db().execute("DELETE FROM sessions WHERE expires_at < ?", (time.time(),))
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    print(f"Akari Suite Booking System on http://0.0.0.0:{PORT}  (db: {'PostgreSQL' if DATABASE_URL else DB_PATH})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()

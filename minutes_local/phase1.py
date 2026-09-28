"""Phase 1 API: local, authenticated, crash-recoverable WAV storage."""
from __future__ import annotations

import base64
import errno
import hashlib
import hmac
import json
import math
import os
import shutil
import re
import secrets
import sqlite3
import struct
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator

from fastapi import FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

ORIGIN = "http://127.0.0.1:5173"
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
# finalize 前の状態。これ以外の会議には新しい Chunk を足さず、確定値も書き換えない
OPEN_STATUSES = ("created", "recording", "finalizing")


class StorageFullError(Exception):
    pass


@dataclass
class ServerState:
    data_dir: Path
    token: str
    locks: dict[tuple[str, str, int], threading.Lock] = field(default_factory=dict)
    locks_guard: threading.Lock = field(default_factory=threading.Lock)

    def key_lock(self, key: tuple[str, str, int]) -> threading.Lock:
        with self.locks_guard:
            return self.locks.setdefault(key, threading.Lock())

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.data_dir / "minutes.sqlite", timeout=30)
        try:
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            with db:
                yield db
        except sqlite3.OperationalError as exc:
            if "full" in str(exc).lower():
                raise StorageFullError from exc
            raise
        finally:
            db.close()


def start_server_state(data_dir: Path, token: str | None = None) -> ServerState:
    """Initialize the Phase 2 compatible core schema and rotate the bearer token."""
    data_dir = data_dir.resolve()
    data_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(data_dir, 0o700)
    token = token if token is not None else secrets.token_hex(32)
    token_path = data_dir / "token"
    fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, token.encode("ascii"))
        os.fsync(fd)
    finally:
        os.close(fd)
    state = ServerState(data_dir, token)
    with state.connect() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meetings (
 id TEXT PRIMARY KEY, local_user_id TEXT NOT NULL DEFAULT 'local', title TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('created','recording','finalizing','finalized','transcribing','transcribed','summarizing','completed','failed')),
 session_start_epoch_ms INTEGER NOT NULL, native_sample_rate INTEGER NOT NULL,
 consent_confirmed_at INTEGER NOT NULL, ended_at INTEGER, total_audio_frames INTEGER,
 transcript_version INTEGER NOT NULL DEFAULT 0, stt_model_used TEXT, llm_model_used TEXT,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);
CREATE TABLE IF NOT EXISTS audio_chunks (
 id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
 source TEXT NOT NULL CHECK(source IN ('mic','system')), sequence_no INTEGER NOT NULL,
 start_offset_ms INTEGER NOT NULL, end_offset_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL,
 sample_count INTEGER NOT NULL, local_path TEXT NOT NULL, size_bytes INTEGER NOT NULL,
 sha256 TEXT NOT NULL, vad_score REAL NOT NULL DEFAULT 0, has_voice INTEGER NOT NULL DEFAULT 1,
 vad_source TEXT NOT NULL DEFAULT 'browser_rms', server_vad_score REAL,
 save_status TEXT NOT NULL DEFAULT 'registered', stt_status TEXT NOT NULL DEFAULT 'pending',
 created_at INTEGER NOT NULL, UNIQUE(meeting_id,source,sequence_no));
CREATE INDEX IF NOT EXISTS idx_chunks_meeting_stt ON audio_chunks(meeting_id,stt_status);
""")
    return state


class CreateMeetingRequest(BaseModel):
    meetingId: str
    title: str
    sessionStartEpochMs: int = Field(ge=0)
    nativeSampleRate: int = Field(gt=0)
    consentConfirmedAt: int = Field(ge=0)


class FinalizeRequest(BaseModel):
    expectedChunkCounts: dict[str, int]
    endedAtEpochMs: int = Field(ge=0)
    totalAudioFrames: int = Field(ge=0)


def error(status: int, code: str, message: str) -> JSONResponse:
    return JSONResponse({"error": message, "code": code}, status_code=status)


def _write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    part = path.with_suffix(path.suffix + ".part")
    with part.open("wb") as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    os.replace(part, path)


def _wav_samples(data: bytes) -> int:
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:16] != b"WAVEfmt " or data[36:40] != b"data":
        raise ValueError("invalid WAV markers")
    riff_size = struct.unpack_from("<I", data, 4)[0]
    fmt_size, format_code, channels, rate, byte_rate, align, bits = struct.unpack_from("<IHHIIHH", data, 16)
    data_bytes = struct.unpack_from("<I", data, 40)[0]
    if (riff_size != len(data) - 8 or fmt_size != 16 or format_code != 1 or channels != 1 or
            rate != 16000 or byte_rate != 32000 or align != 2 or bits != 16 or
            data_bytes != len(data) - 44 or data_bytes == 0 or data_bytes % 2):
        raise ValueError("invalid PCM16 mono 16kHz WAV")
    return data_bytes // 2


def _meta(value: str, meeting_id: str, source: str, seq: int, samples: int) -> dict[str, Any]:
    try:
        raw = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
        meta = json.loads(raw)
        if not isinstance(meta, dict):
            raise ValueError("metadata must be an object")
        if (meta.get("meetingId") != meeting_id or meta.get("source") != source or
                meta.get("sequenceNo") != seq or meta.get("sampleCount") != samples):
            raise ValueError("metadata does not match URL or WAV")
        start = meta["startOffsetMs"]
        end = meta["endOffsetMs"]
        if not isinstance(start, int) or not isinstance(end, int) or start < 0 or end < start:
            raise ValueError("invalid timing")
        score = meta.get("vadScore", 0)
        if not isinstance(score, (int, float)) or not math.isfinite(score):
            raise ValueError("invalid vadScore")
        if not isinstance(meta.get("hasVoice", True), bool):
            raise ValueError("invalid hasVoice")
        return meta
    except (KeyError, TypeError, UnicodeError, json.JSONDecodeError, base64.binascii.Error) as exc:
        raise ValueError("invalid X-Chunk-Meta") from exc


def _chunk_response(row: sqlite3.Row) -> dict[str, Any]:
    return {"meetingId": row["meeting_id"], "source": row["source"], "sequenceNo": row["sequence_no"],
            "sha256": row["sha256"], "sizeBytes": row["size_bytes"], "path": row["local_path"], "registered": True}


def create_app(state: ServerState) -> FastAPI:
    app = FastAPI(title="minutes-local", docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def authenticate(request: Request, call_next):
        header = request.headers.get("authorization", "")
        authenticated = header.startswith("Bearer ") and hmac.compare_digest(header[7:], state.token)
        request.state.authenticated = authenticated
        if request.url.path.startswith("/v1/") and request.url.path != "/v1/health" and request.method != "OPTIONS" and not authenticated:
            return error(401, "UNAUTHORIZED", "invalid or missing token")
        try:
            return await call_next(request)
        except StorageFullError:
            return error(507, "INSUFFICIENT_STORAGE", "disk full")
        except Exception:
            return error(500, "INTERNAL", "internal server error")

    app.add_middleware(CORSMiddleware, allow_origins=[ORIGIN], allow_methods=["GET", "POST", "PUT"],
                       allow_headers=["Authorization", "Content-Type", "X-Chunk-SHA256", "X-Chunk-Meta"])

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, _exc: RequestValidationError):
        return error(422, "VALIDATION", "invalid request")

    @app.get("/v1/health")
    def health(request: Request):
        result: dict[str, Any] = {"status": "ok", "service": "minutes-local"}
        if request.state.authenticated:
            result["capabilities"] = {
                "service": "minutes-local", "version": "0.1.0", "dataDir": str(state.data_dir),
                "freeDiskBytes": shutil.disk_usage(state.data_dir).free,
                "gpu": {"available": False, "name": None, "vramBytes": None},
                "cpuCores": os.cpu_count() or 1, "totalMemoryBytes": 0,
                "sttModel": None, "llmModel": None, "maxConcurrentStt": 0,
            }
        return result

    @app.post("/v1/meetings")
    def create_meeting(body: CreateMeetingRequest):
        if not SAFE_ID.fullmatch(body.meetingId):
            return error(422, "VALIDATION", "invalid meetingId")
        now = int(time.time() * 1000)
        try:
            with state.connect() as db:
                cursor = db.execute("""INSERT OR IGNORE INTO meetings
                    (id,title,status,session_start_epoch_ms,native_sample_rate,consent_confirmed_at,created_at,updated_at)
                    VALUES (?,?, 'recording',?,?,?,?,?)""",
                    (body.meetingId, body.title, body.sessionStartEpochMs, body.nativeSampleRate, body.consentConfirmedAt, now, now))
                row = db.execute("SELECT * FROM meetings WHERE id=?", (body.meetingId,)).fetchone()
            assert row is not None
            path = state.data_dir / "recordings" / body.meetingId / "meeting.json"
            if cursor.rowcount == 1 or not path.is_file():
                _write_atomic(path, json.dumps(body.model_dump(), ensure_ascii=False).encode())
            return JSONResponse({"meetingId": row["id"], "status": row["status"],
                                 "dataPath": f"recordings/{body.meetingId}"}, status_code=201 if cursor.rowcount == 1 else 200)
        except OSError as exc:
            if exc.errno == errno.ENOSPC:
                return error(507, "INSUFFICIENT_STORAGE", "disk full")
            raise

    @app.put("/v1/meetings/{meeting_id}/chunks/{source}/{sequence_no}")
    async def put_chunk(meeting_id: str, source: str, sequence_no: int, request: Request,
                        x_chunk_sha256: str | None = Header(default=None),
                        x_chunk_meta: str | None = Header(default=None)):
        if not SAFE_ID.fullmatch(meeting_id) or source not in ("mic", "system") or sequence_no < 0:
            return error(422, "VALIDATION", "invalid chunk key")
        if request.headers.get("content-type") != "audio/wav" or x_chunk_sha256 is None or not SHA256.fullmatch(x_chunk_sha256) or x_chunk_meta is None:
            return error(422, "VALIDATION", "invalid chunk headers")
        data = await request.body()
        try:
            samples = _wav_samples(data)
            meta = _meta(x_chunk_meta, meeting_id, source, sequence_no, samples)
        except ValueError as exc:
            return error(422, "VALIDATION", str(exc))
        sha = hashlib.sha256(data).hexdigest()
        if sha != x_chunk_sha256:
            return error(422, "VALIDATION", "sha256 header mismatch")
        if (meta.get("sha256", sha) != sha or meta.get("sizeBytes", len(data)) != len(data) or
                meta.get("sampleRate", 16000) != 16000 or meta.get("channels", 1) != 1):
            return error(422, "VALIDATION", "metadata does not match WAV")
        key = (meeting_id, source, sequence_no)
        with state.key_lock(key):
            with state.connect() as db:
                # 状態確認から登録までを書き込みロック下で行い、finalize の件数検証と直列化する
                db.execute("BEGIN IMMEDIATE")
                meeting = db.execute("SELECT status FROM meetings WHERE id=?", (meeting_id,)).fetchone()
                if meeting is None:
                    return error(404, "NOT_FOUND", "meeting not found")
                existing = db.execute("SELECT * FROM audio_chunks WHERE meeting_id=? AND source=? AND sequence_no=?", key).fetchone()
                if existing is not None:
                    if existing["sha256"] != sha:
                        return error(409, "CONFLICT_HASH_MISMATCH", "chunk exists with different content")
                    path = state.data_dir / existing["local_path"]
                    if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == sha:
                        return JSONResponse(_chunk_response(existing), status_code=200)
                elif meeting["status"] not in OPEN_STATUSES:
                    return error(409, "CONFLICT_MEETING_FINALIZED", "meeting is already finalized")
                relative = f"recordings/{meeting_id}/{source}/{sequence_no:06d}.wav"
                try:
                    _write_atomic(state.data_dir / relative, data)
                    if existing is None:
                        db.execute("""INSERT INTO audio_chunks
                            (id,meeting_id,source,sequence_no,start_offset_ms,end_offset_ms,duration_ms,sample_count,
                             local_path,size_bytes,sha256,vad_score,has_voice,created_at)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                            (secrets.token_hex(16), meeting_id, source, sequence_no,
                             meta["startOffsetMs"], meta["endOffsetMs"], round(samples / 16), samples,
                             relative, len(data), sha, float(meta.get("vadScore", 0)), int(bool(meta.get("hasVoice", True))), int(time.time() * 1000)))
                    else:
                        db.execute("UPDATE audio_chunks SET save_status='registered' WHERE id=?", (existing["id"],))
                    row = db.execute("SELECT * FROM audio_chunks WHERE meeting_id=? AND source=? AND sequence_no=?", key).fetchone()
                except OSError as exc:
                    if exc.errno == errno.ENOSPC:
                        return error(507, "INSUFFICIENT_STORAGE", "disk full")
                    raise
            assert row is not None
            return JSONResponse(_chunk_response(row), status_code=201 if existing is None else 200)

    @app.get("/v1/meetings/{meeting_id}/chunks")
    def list_chunks(meeting_id: str):
        if not SAFE_ID.fullmatch(meeting_id):
            return error(422, "VALIDATION", "invalid meetingId")
        with state.connect() as db:
            if db.execute("SELECT 1 FROM meetings WHERE id=?", (meeting_id,)).fetchone() is None:
                return error(404, "NOT_FOUND", "meeting not found")
            rows = db.execute("SELECT * FROM audio_chunks WHERE meeting_id=? ORDER BY source,sequence_no", (meeting_id,)).fetchall()
        return {"meetingId": meeting_id, "chunks": [{"source": r["source"], "sequenceNo": r["sequence_no"],
                "sha256": r["sha256"], "sizeBytes": r["size_bytes"], "registered": True} for r in rows]}

    @app.post("/v1/meetings/{meeting_id}/finalize")
    def finalize(meeting_id: str, body: FinalizeRequest):
        if not SAFE_ID.fullmatch(meeting_id) or set(body.expectedChunkCounts) != {"mic", "system"} or any(v < 0 for v in body.expectedChunkCounts.values()):
            return error(422, "VALIDATION", "invalid finalize request")
        with state.connect() as db:
            # 件数検証から確定までを PUT・他の finalize と直列化する
            db.execute("BEGIN IMMEDIATE")
            meeting = db.execute("SELECT * FROM meetings WHERE id=?", (meeting_id,)).fetchone()
            if meeting is None:
                return error(404, "NOT_FOUND", "meeting not found")
            rows = db.execute("SELECT * FROM audio_chunks WHERE meeting_id=? ORDER BY source,sequence_no", (meeting_id,)).fetchall()
            counts = {"mic": 0, "system": 0}
            for source in counts:
                chosen = [r for r in rows if r["source"] == source]
                if len(chosen) != body.expectedChunkCounts[source] or [r["sequence_no"] for r in chosen] != list(range(len(chosen))):
                    return error(409, "CONFLICT_CHUNKS_MISSING", "chunk count or sequence mismatch")
                for r in chosen:
                    path = state.data_dir / r["local_path"]
                    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != r["sha256"]:
                        return error(409, "CONFLICT_CHUNKS_MISSING", "chunk file missing or corrupt")
                counts[source] = len(chosen)
            # 先に確定した値を正とする（2 回目以降は更新せず、保存済みの値を読み直す）
            db.execute(f"""UPDATE meetings SET status='finalized', ended_at=?, total_audio_frames=?, updated_at=?
                WHERE id=? AND status IN ({",".join("?" * len(OPEN_STATUSES))})""",
                       (body.endedAtEpochMs, body.totalAudioFrames, int(time.time() * 1000), meeting_id, *OPEN_STATUSES))
            meeting = db.execute("SELECT * FROM meetings WHERE id=?", (meeting_id,)).fetchone()
        # コミット後に書き、meeting.json が DB より先行しないようにする。失敗しても再送で書き直せる
        assert meeting is not None
        snapshot = {"meetingId": meeting_id, "title": meeting["title"],
                    "sessionStartEpochMs": meeting["session_start_epoch_ms"],
                    "nativeSampleRate": meeting["native_sample_rate"],
                    "consentConfirmedAt": meeting["consent_confirmed_at"],
                    "endedAtEpochMs": meeting["ended_at"], "totalAudioFrames": meeting["total_audio_frames"]}
        try:
            _write_atomic(state.data_dir / "recordings" / meeting_id / "meeting.json", json.dumps(snapshot, ensure_ascii=False).encode())
        except OSError as exc:
            if exc.errno == errno.ENOSPC:
                return error(507, "INSUFFICIENT_STORAGE", "disk full")
            raise
        return {"meetingId": meeting_id, "status": "finalized", "registeredChunkCounts": counts}

    return app

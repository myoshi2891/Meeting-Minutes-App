import base64
import hashlib
import json
import struct
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from minutes_local.phase1 import create_app, start_server_state


def wav(samples=160):
    pcm = b"\0\0" * samples
    return b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack(
        "<IHHIIHH", 16, 1, 1, 16000, 32000, 2, 16
    ) + b"data" + struct.pack("<I", len(pcm)) + pcm


def meeting(mid="m-1"):
    return {"meetingId": mid, "title": "定例", "sessionStartEpochMs": 1000,
            "nativeSampleRate": 48000, "consentConfirmedAt": 900}


def put(client, mid="m-1", seq=0, data=None, token="token"):
    data = wav() if data is None else data
    meta = {"meetingId": mid, "source": "mic", "sequenceNo": seq,
            "sampleCount": (len(data) - 44) // 2, "startOffsetMs": seq * 30_000,
            "endOffsetMs": seq * 30_000 + (len(data) - 44) // 32,
            "vadScore": 0.2, "hasVoice": True}
    encoded = base64.urlsafe_b64encode(json.dumps(meta).encode()).decode().rstrip("=")
    return client.put(f"/v1/meetings/{mid}/chunks/mic/{seq}", content=data,
                      headers={"Authorization": f"Bearer {token}", "Content-Type": "audio/wav",
                               "X-Chunk-SHA256": hashlib.sha256(data).hexdigest(), "X-Chunk-Meta": encoded})


def test_health_auth_cors_and_persistent_restart(tmp_path):
    state = start_server_state(tmp_path, token="token")
    with TestClient(create_app(state)) as client:
        origin = {"Origin": "http://127.0.0.1:5173"}
        assert client.get("/v1/health").json() == {"status": "ok", "service": "minutes-local"}
        assert client.get("/v1/health", headers={"Authorization": "Bearer token"}).json()["capabilities"]["service"] == "minutes-local"
        assert client.options("/v1/meetings", headers={**origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type"}).status_code == 200
        denied = client.post("/v1/meetings", json=meeting(), headers=origin)
        assert denied.status_code == 401
        assert denied.headers["access-control-allow-origin"] == origin["Origin"]
        invalid = client.post("/v1/meetings", json={"meetingId": "bad"}, headers={**origin, "Authorization": "Bearer token"})
        assert invalid.status_code == 422
        assert invalid.json()["code"] == "VALIDATION"
        assert invalid.headers["access-control-allow-origin"] == origin["Origin"]
        assert client.post("/v1/meetings", json=meeting(), headers={**origin, "Authorization": "Bearer token"}).status_code == 201
        assert put(client).status_code == 201
    state2 = start_server_state(tmp_path, token="new-token")
    with TestClient(create_app(state2)) as client:
        assert client.get("/v1/meetings/m-1/chunks", headers={"Authorization": "Bearer token"}).status_code == 401
        listed = client.get("/v1/meetings/m-1/chunks", headers={"Authorization": "Bearer new-token"})
        assert listed.json()["chunks"][0]["sequenceNo"] == 0


def test_put_validation_idempotency_and_finalize(tmp_path):
    with TestClient(create_app(start_server_state(tmp_path, token="token"))) as client:
        auth = {"Authorization": "Bearer token"}
        assert put(client).status_code == 404
        assert client.post("/v1/meetings", json=meeting(), headers=auth).status_code == 201
        assert client.post("/v1/meetings", json=meeting(), headers=auth).status_code == 200
        assert put(client, data=b"bad").status_code == 422
        assert put(client).status_code == 201
        assert put(client).status_code == 200
        assert put(client, data=wav(161)).status_code == 409
        incomplete = client.post("/v1/meetings/m-1/finalize", json={"expectedChunkCounts": {"mic": 2, "system": 0}, "endedAtEpochMs": 2000, "totalAudioFrames": 160}, headers=auth)
        assert incomplete.status_code == 409
        assert put(client, seq=1).status_code == 201
        body = {"expectedChunkCounts": {"mic": 2, "system": 0}, "endedAtEpochMs": 2000, "totalAudioFrames": 320}
        assert client.post("/v1/meetings/m-1/finalize", json=body, headers=auth).status_code == 200
        body["endedAtEpochMs"] = 3000
        assert client.post("/v1/meetings/m-1/finalize", json=body, headers=auth).status_code == 200
        assert state_row(tmp_path)[0] == 2000


def state_row(path):
    import sqlite3
    with sqlite3.connect(path / "minutes.sqlite") as db:
        return db.execute("SELECT ended_at, total_audio_frames FROM meetings WHERE id='m-1'").fetchone()


def test_parallel_put_same_key(tmp_path):
    with TestClient(create_app(start_server_state(tmp_path, token="token"))) as client:
        client.post("/v1/meetings", json=meeting(), headers={"Authorization": "Bearer token"})
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: put(client), range(2)))
        assert sorted(r.status_code for r in results) == [200, 201]
        assert not list(tmp_path.rglob("*.part"))


def test_hash_integrity_cors_and_storage_full(tmp_path, monkeypatch):
    import errno
    from minutes_local import phase1

    with TestClient(create_app(start_server_state(tmp_path, token="token"))) as client:
        auth = {"Authorization": "Bearer token"}
        client.post("/v1/meetings", json=meeting(), headers=auth)
        bad_hash = client.put("/v1/meetings/m-1/chunks/mic/0", content=wav(), headers={
            **auth, "Content-Type": "audio/wav", "X-Chunk-SHA256": "0" * 64,
            "X-Chunk-Meta": base64.urlsafe_b64encode(json.dumps({"meetingId": "m-1", "source": "mic", "sequenceNo": 0,
                "sampleCount": 160, "startOffsetMs": 0, "endOffsetMs": 10}).encode()).decode().rstrip("=")})
        assert bad_hash.status_code == 422
        assert "access-control-allow-origin" not in client.get("/v1/health", headers={"Origin": "https://example.com"}).headers

        original = phase1._write_atomic
        monkeypatch.setattr(phase1, "_write_atomic", lambda *_: (_ for _ in ()).throw(OSError(errno.ENOSPC, "disk full")))
        assert put(client).status_code == 507
        monkeypatch.setattr(phase1, "_write_atomic", original)
        assert put(client).status_code == 201
        path = tmp_path / "recordings/m-1/mic/000000.wav"
        path.write_bytes(b"corrupt")
        body = {"expectedChunkCounts": {"mic": 1, "system": 0}, "endedAtEpochMs": 2000, "totalAudioFrames": 160}
        assert client.post("/v1/meetings/m-1/finalize", json=body, headers=auth).status_code == 409
        assert put(client).status_code == 200
        assert client.post("/v1/meetings/m-1/finalize", json=body, headers=auth).status_code == 200


def test_put_rejects_new_chunk_after_finalize_but_allows_retry_and_repair(tmp_path):
    # Arrange: seq 0 だけで確定した会議
    with TestClient(create_app(start_server_state(tmp_path, token="token"))) as client:
        auth = {"Authorization": "Bearer token"}
        client.post("/v1/meetings", json=meeting(), headers=auth)
        assert put(client).status_code == 201
        body = {"expectedChunkCounts": {"mic": 1, "system": 0}, "endedAtEpochMs": 2000, "totalAudioFrames": 160}
        assert client.post("/v1/meetings/m-1/finalize", json=body, headers=auth).status_code == 200

        # Act: 確定後に新しい連番を送る
        late = put(client, seq=1)

        # Assert: 409 で拒否し、ファイルも行も残さない
        assert late.status_code == 409
        assert late.json()["code"] == "CONFLICT_MEETING_FINALIZED"
        assert not (tmp_path / "recordings/m-1/mic/000001.wav").exists()
        listed = client.get("/v1/meetings/m-1/chunks", headers=auth).json()["chunks"]
        assert [c["sequenceNo"] for c in listed] == [0]
        # 既存 Chunk の冪等再送と破損ファイルの修復は確定後も通す
        assert put(client).status_code == 200
        (tmp_path / "recordings/m-1/mic/000000.wav").write_bytes(b"corrupt")
        assert put(client).status_code == 200
        assert put(client, mid="m-missing", seq=5).status_code == 404


def test_concurrent_finalize_keeps_first_result_in_db_and_snapshot(tmp_path, monkeypatch):
    import threading
    from minutes_local import phase1

    # Arrange: meeting.json の書き込みで 2 要求を待ち合わせ、競合を必ず起こす
    original = phase1._write_atomic
    barrier = threading.Barrier(2)
    write_lock = threading.Lock()
    snapshots = []

    def racing_write(path, data):
        if path.name == "meeting.json" and not barrier.broken:
            try:
                barrier.wait(timeout=2)
            except threading.BrokenBarrierError:
                pass
        with write_lock:
            original(path, data)
            if path.name == "meeting.json":
                snapshots.append(json.loads(data))

    with TestClient(create_app(start_server_state(tmp_path, token="token"))) as client:
        auth = {"Authorization": "Bearer token"}
        client.post("/v1/meetings", json=meeting(), headers=auth)
        assert put(client).status_code == 201
        snapshots.clear()
        monkeypatch.setattr(phase1, "_write_atomic", racing_write)

        # Act: 異なる終了時刻で同時に finalize する
        def finalize(ended_at):
            body = {"expectedChunkCounts": {"mic": 1, "system": 0}, "endedAtEpochMs": ended_at, "totalAudioFrames": ended_at}
            return client.post("/v1/meetings/m-1/finalize", json=body, headers=auth)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(finalize, [2000, 3000]))

    # Assert: DB と meeting.json はどちらも最初に確定した値だけを持つ
    assert [r.status_code for r in results] == [200, 200]
    ended_at, frames = state_row(tmp_path)
    assert ended_at in (2000, 3000) and frames == ended_at
    assert [s["endedAtEpochMs"] for s in snapshots] == [ended_at, ended_at]
    final = json.loads((tmp_path / "recordings/m-1/meeting.json").read_text())
    assert (final["endedAtEpochMs"], final["totalAudioFrames"]) == (ended_at, frames)


def test_concurrent_atomic_writes_to_same_path_do_not_share_temp_file(tmp_path, monkeypatch):
    import os
    import threading
    from minutes_local import phase1

    # Arrange: 両スレッドが一時ファイルを書き終えてから rename するよう待ち合わせる
    original_replace = os.replace
    barrier = threading.Barrier(2)

    def waiting_replace(src, dst):
        barrier.wait(timeout=2)
        original_replace(src, dst)

    monkeypatch.setattr(os, "replace", waiting_replace)
    target = tmp_path / "recordings/m-1/meeting.json"

    # Act
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(phase1._write_atomic, target, data) for data in (b"first", b"second")]
        errors = [f.exception() for f in futures]

    # Assert: どちらも成功し、一時ファイルは残らない
    assert errors == [None, None]
    assert target.read_bytes() in (b"first", b"second")
    assert not list(tmp_path.rglob("*.part"))

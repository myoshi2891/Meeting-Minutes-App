// src/storage/idb.ts
import type { AudioChunkRecord, MeetingRecord } from "../types/recording";

export const DB_NAME = "minutes-local";
export const DB_VERSION = 1;

export const STORE_MEETINGS = "meetings";
export const STORE_CHUNKS = "audio_chunks";
export const STORE_SETTINGS = "settings";

export interface SettingsRecord {
  readonly key: string;
  readonly value: unknown;
}

/** バージョンごとのマイグレーション。新バージョン追加時はこの配列に追記する。 */
type Migration = (db: IDBDatabase, tx: IDBTransaction) => void;

const MIGRATIONS: ReadonlyArray<{ readonly toVersion: number; readonly run: Migration }> = [
  {
    toVersion: 1,
    run: (db) => {
      const meetings = db.createObjectStore(STORE_MEETINGS, { keyPath: "meetingId" });
      meetings.createIndex("by_status", "status", { unique: false });

      const chunks = db.createObjectStore(STORE_CHUNKS, { keyPath: "chunkKey" });
      chunks.createIndex("by_meeting", "meta.meetingId", { unique: false });
      chunks.createIndex("by_meeting_seq", ["meta.meetingId", "meta.source", "meta.sequenceNo"], { unique: true });
      chunks.createIndex("by_status", "save.status", { unique: false });
      chunks.createIndex("by_meeting_status", ["meta.meetingId", "save.status"], { unique: false });

      db.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
    },
  },
];

export function openDatabase(indexedDbFactory: IDBFactory = indexedDB): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDbFactory.open(DB_NAME, DB_VERSION);
    // blocked で reject した後に別タブが閉じると onsuccess が来る。その接続は呼び出し元に渡らないので閉じる
    let blockedRejected = false;

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      if (tx === null) {
        reject(new Error("upgrade transaction is null"));
        return;
      }
      const oldVersion = event.oldVersion;
      for (const migration of MIGRATIONS) {
        if (migration.toVersion > oldVersion) {
          migration.run(db, tx);
        }
      }
    };

    request.onblocked = () => {
      // 別タブが旧バージョンを開いたまま。閉じるまで待つ（UI で通知）。
      blockedRejected = true;
      reject(new Error("IndexedDB upgrade blocked by another tab"));
    };

    request.onsuccess = () => {
      const db = request.result;
      if (blockedRejected) {
        // 開いたままだと、次の openDatabase のアップグレードをこの接続が塞ぐ
        db.close();
        return;
      }
      db.onversionchange = () => {
        // 別タブがアップグレードを要求した。自タブは接続を閉じて再読み込みを促す。
        db.close();
      };
      resolve(db);
    };

    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB open failed"));
    };
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IDBRequest failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IDBTransaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IDBTransaction aborted"));
  });
}

export function isQuotaExceeded(error: unknown): boolean {
  return error instanceof DOMException && error.name === "QuotaExceededError";
}

export class ChunkStore {
  constructor(private readonly db: IDBDatabase) {}

  /** put は complete を待ってから resolve する。resolve = ディスクへの永続化要求が受理された状態。 */
  async putChunk(record: AudioChunkRecord): Promise<void> {
    const tx = this.db.transaction(STORE_CHUNKS, "readwrite");
    tx.objectStore(STORE_CHUNKS).put(record);
    await transactionDone(tx);
  }

  async getChunk(chunkKey: string): Promise<AudioChunkRecord | undefined> {
    const tx = this.db.transaction(STORE_CHUNKS, "readonly");
    const result = await requestToPromise(tx.objectStore(STORE_CHUNKS).get(chunkKey));
    return isAudioChunkRecord(result) ? result : undefined;
  }

  async updateSaveState(chunkKey: string, mutate: (record: AudioChunkRecord) => void): Promise<void> {
    const tx = this.db.transaction(STORE_CHUNKS, "readwrite");
    const store = tx.objectStore(STORE_CHUNKS);
    const current = await requestToPromise(store.get(chunkKey));
    if (!isAudioChunkRecord(current)) {
      throw new Error(`chunk not found: ${chunkKey}`);
    }
    mutate(current);
    current.save.updatedAt = performance.now();
    store.put(current);
    await transactionDone(tx);
  }

  /** 会議の Chunk を sequenceNo 昇順で返す。 */
  async listByMeeting(meetingId: string, source: "mic" | "system"): Promise<AudioChunkRecord[]> {
    const tx = this.db.transaction(STORE_CHUNKS, "readonly");
    const index = tx.objectStore(STORE_CHUNKS).index("by_meeting_seq");
    const range = IDBKeyRange.bound([meetingId, source, 0], [meetingId, source, Number.MAX_SAFE_INTEGER]);
    const results = await requestToPromise(index.getAll(range));
    return results.filter(isAudioChunkRecord);
  }

  /** 復旧用：DB_REGISTERED 以外の Chunk をすべて返す。 */
  async listUnfinished(): Promise<AudioChunkRecord[]> {
    const tx = this.db.transaction(STORE_CHUNKS, "readonly");
    const index = tx.objectStore(STORE_CHUNKS).index("by_status");
    // 完了済み（DB_REGISTERED）の WAV まで読み込まないよう、索引の範囲でその前後だけを取る
    const [before, after] = await Promise.all([
      requestToPromise(index.getAll(IDBKeyRange.upperBound("DB_REGISTERED", true))),
      requestToPromise(index.getAll(IDBKeyRange.lowerBound("DB_REGISTERED", true))),
    ]);
    return [...before, ...after].filter(isAudioChunkRecord).filter((r) => r.save.status !== "DB_REGISTERED");
  }

  /** クォータ縮退（§3.4 段階1）：DB_REGISTERED の Chunk だけ Blob 本体を削除しメタデータのみ残す。未検証の Chunk は再送のため残す。 */
  async dropBlob(chunkKey: string): Promise<void> {
    await this.updateSaveState(chunkKey, (record) => {
      if (record.save.status !== "DB_REGISTERED") return;
      record.wav = null;
    });
  }

  async countByStatus(meetingId: string, status: AudioChunkRecord["save"]["status"]): Promise<number> {
    const tx = this.db.transaction(STORE_CHUNKS, "readonly");
    const index = tx.objectStore(STORE_CHUNKS).index("by_meeting_status");
    return requestToPromise(index.count(IDBKeyRange.only([meetingId, status])));
  }
}

export class MeetingStore {
  constructor(private readonly db: IDBDatabase) {}

  async put(record: MeetingRecord): Promise<void> {
    const tx = this.db.transaction(STORE_MEETINGS, "readwrite");
    tx.objectStore(STORE_MEETINGS).put(record);
    await transactionDone(tx);
  }

  async get(meetingId: string): Promise<MeetingRecord | undefined> {
    const tx = this.db.transaction(STORE_MEETINGS, "readonly");
    const result = await requestToPromise(tx.objectStore(STORE_MEETINGS).get(meetingId));
    return isMeetingRecord(result) ? result : undefined;
  }

  async listByStatus(status: MeetingRecord["status"]): Promise<MeetingRecord[]> {
    const tx = this.db.transaction(STORE_MEETINGS, "readonly");
    const results = await requestToPromise(tx.objectStore(STORE_MEETINGS).index("by_status").getAll(status));
    return results.filter(isMeetingRecord);
  }
}

export class SettingsStore {
  constructor(private readonly db: IDBDatabase) {}

  async get(key: string): Promise<unknown> {
    const tx = this.db.transaction(STORE_SETTINGS, "readonly");
    const result = await requestToPromise(tx.objectStore(STORE_SETTINGS).get(key));
    if (typeof result !== "object" || result === null || !("value" in result)) return undefined;
    return (result as SettingsRecord).value;
  }

  async set(key: string, value: unknown): Promise<void> {
    const tx = this.db.transaction(STORE_SETTINGS, "readwrite");
    const record: SettingsRecord = { key, value };
    tx.objectStore(STORE_SETTINGS).put(record);
    await transactionDone(tx);
  }
}

// ---- 型ガード（IndexedDB から読んだ値は unknown として扱う） ----

export function isAudioChunkRecord(value: unknown): value is AudioChunkRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.chunkKey === "string" && typeof v.meta === "object" && v.meta !== null && typeof v.save === "object" && v.save !== null;
}

export function isMeetingRecord(value: unknown): value is MeetingRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.meetingId === "string" && typeof v.status === "string" && typeof v.sessionClock === "object";
}

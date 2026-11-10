// エントリポイント（§31.4）。DOM の薄い層で、表示文言は src/ui/recording-view.ts が作る
import { createApp, type App, type AppEvent, type RecordingSession, type SessionController } from "./app/app";
import { assessHealth, attachAudioContextMonitor } from "./recording/recording-health-monitor";
import { openDatabase } from "./storage/idb";
import {
  backendBanner,
  CONSENT_QUESTION,
  elapsedText,
  finalizeResultText,
  LOCAL_DATA_NOTICE,
  noticeFor,
  pendingCountsText,
  storageUsageText,
  TAB_CLOSE_HELP,
  warningsFor,
} from "./ui/recording-view";
import { confirmAbandon, discardBacklogQuestion, manualRetryNeedsNotice } from "./ui/pending-actions";
import { buildStoredZip } from "./export/zip";
import type { MemoryBacklogFile } from "./recording/recording-controller";
import workletModuleUrl from "./worklet/pcm-chunker.worklet.ts?worker&url";

const BACKEND_BASE_URL = "http://127.0.0.1:43117";
const HIDDEN_RENDER_INTERVAL_MS = 1_000;
const PENDING_REFRESH_INTERVAL_MS = 5_000;
const MAX_NOTICES = 20;

function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof type)) throw new Error(`#${id} is missing`);
  return el;
}

const ui = {
  banner: element("banner", HTMLDivElement),
  warnings: element("warnings", HTMLDivElement),
  title: element("title", HTMLInputElement),
  start: element("start", HTMLButtonElement),
  stop: element("stop", HTMLButtonElement),
  elapsed: element("elapsed", HTMLSpanElement),
  storage: element("storage", HTMLSpanElement),
  exportRow: element("export-row", HTMLDivElement),
  exportButton: element("export", HTMLButtonElement),
  notices: element("notices", HTMLUListElement),
  pending: element("pending", HTMLUListElement),
  tokenForm: element("token-form", HTMLFormElement),
  token: element("token", HTMLInputElement),
  tabCloseHelp: element("tab-close-help", HTMLParagraphElement),
  localDataNotice: element("local-data-notice", HTMLParagraphElement),
};

/** 通知欄に積む。外部由来の文言が混ざりうるので textContent だけを使う */
function notify(text: string): void {
  const li = document.createElement("li");
  li.textContent = `${new Date().toLocaleTimeString()} ${text}`;
  ui.notices.prepend(li);
  while (ui.notices.children.length > MAX_NOTICES) ui.notices.lastElementChild?.remove();
}

interface Recording {
  readonly session: RecordingSession;
  readonly audioContext: AudioContext;
  readonly detachAudioMonitor: () => void;
  readonly startedAt: number;
}

let recording: Recording | null = null;
/** 停止後もメモリ待機が残っている controller。空になるまで書き出せるように保持する（§15） */
const stoppedWithBacklog = new Set<SessionController>();
let hiddenTimer: ReturnType<typeof setInterval> | null = null;

function render(app: App): void {
  const banner = backendBanner(app.monitor.state, app.health, recording !== null, app.memoryBacklogCount());
  ui.banner.hidden = banner === null;
  ui.banner.textContent = banner ?? "";

  const assessment = assessHealth(app.health, null, performance.now());
  // 録音していないときは音声フレームが来ないのが正常なので、録音の健全性の警告は出さない
  const warnings = recording === null ? warningsFor({ reasons: app.health.degradedReasons }) : warningsFor(assessment);
  ui.warnings.replaceChildren(
    ...warnings.map((text) => {
      const div = document.createElement("div");
      div.className = "warning";
      div.textContent = text;
      return div;
    }),
  );

  ui.storage.textContent = storageUsageText(app.health.storageUsageRatio);
  ui.elapsed.textContent = elapsedText(recording === null ? 0 : performance.now() - recording.startedAt);
  ui.start.hidden = recording !== null;
  ui.stop.hidden = recording === null;
  ui.title.disabled = recording !== null;
}

/** §19：表示中は requestAnimationFrame で状態を読む。hidden の間は rAF が止まるので、タイマーに切り替える（§20） */
function startRenderLoop(app: App): void {
  const frame = () => {
    render(app);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && hiddenTimer !== null) {
      clearInterval(hiddenTimer);
      hiddenTimer = null;
    }
  });
}

function onHidden(app: App): void {
  if (hiddenTimer !== null) return;
  hiddenTimer = setInterval(() => render(app), HIDDEN_RENDER_INTERVAL_MS);
}

const pendingBusy = new Set<string>();

/**
 * 表示中の確定待ちの行のボタンを押せる状態に戻す。操作の待機中に一覧が再描画されると押した行は置き換わっているので、
 * 押したときのボタンではなく会議 ID で今の行を探す（会議 ID は CSS セレクタに埋め込まない）
 */
function enablePendingRow(meetingId: string): void {
  for (const li of ui.pending.children) {
    if (!(li instanceof HTMLLIElement) || li.dataset.meetingId !== meetingId) continue;
    for (const button of li.querySelectorAll("button")) button.disabled = false;
  }
}
let pendingRefresh: Promise<void> | null = null;
let pendingRefreshRequested = false;
/**
 * 確定待ち一覧の再描画。1 本ずつ順に実行し、実行中の要求は終わった後の 1 回にまとめる。
 * 世代番号で古い結果を捨てる方式では、読み込みが更新間隔より遅いと毎回新しい要求に捨てられて一度も描画されない
 */
function refreshPending(app: App): Promise<void> {
  if (pendingRefresh !== null) {
    pendingRefreshRequested = true;
    return pendingRefresh;
  }
  const run = async (): Promise<void> => {
    try {
      do {
        pendingRefreshRequested = false;
        await renderPending(app);
      } while (pendingRefreshRequested);
    } finally {
      pendingRefresh = null;
    }
  };
  pendingRefresh = run();
  return pendingRefresh;
}

async function renderPending(app: App): Promise<void> {
  const meetings = await app.listPendingFinalize();
  const details = await Promise.all(meetings.map(async (m) => {
    let chunks: Awaited<ReturnType<typeof app.chunkStore.listByMeeting>>;
    try {
      chunks = await app.chunkStore.listByMeeting(m.meetingId, "mic");
    } catch (error) {
      // 内訳が読めなくても行（再試行・中止）は出す。IDB が読めないときこそ保持中の会議の再試行が要る
      return `内訳を読み込めませんでした（${noticeFor({ type: "error", error }) ?? ""}）`;
    }
    return pendingCountsText({
      chunks,
      audioFrameCount: m.sessionClock.audioFrameCount,
      directRegistered: app.directRegisteredCount(m.meetingId),
      memoryCount: app.memoryBacklogCount(m.meetingId),
      offIdbEndFrame: app.offIdbEndFrame(m.meetingId),
      offIdbSequenceNos: app.offIdbSequenceNos(m.meetingId),
    });
  }));
  ui.pending.replaceChildren(
    ...meetings.map((m, index) => {
      const li = document.createElement("li");
      li.dataset.meetingId = m.meetingId;
      const label = document.createElement("span");
      label.textContent = `${m.title}（${new Date(m.createdAt).toLocaleString()}） `;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "再試行";
      retry.disabled = pendingBusy.has(m.meetingId);
      retry.addEventListener("click", () => {
        // 同じ会議の操作が実行中なら、その操作の pendingBusy を書き換えない
        if (pendingBusy.has(m.meetingId)) return;
        // 再試行中は確定中止も押せないようにする（会議ロックの取り合いで「使用中」になるだけのため）
        retry.disabled = abandon.disabled = true;
        pendingBusy.add(m.meetingId);
        const before = app.getFinalizeIssue(m.meetingId);
        void app
          .retryFinalize(m.meetingId)
          .then((result) => {
            // 前回と同じ理由の失敗は自動通知が出ないので、押した結果が分かるようにここで出す
            if (!result.ok && manualRetryNeedsNotice(before, app.getFinalizeIssue(m.meetingId), result)) notify(`${m.title}: ${finalizeResultText(result)}`);
          })
          .catch((error: unknown) => notify(noticeFor({ type: "error", error }) ?? ""))
          .finally(() => { pendingBusy.delete(m.meetingId); void refreshPending(app); });
      });
      const abandon = document.createElement("button");
      abandon.type = "button";
      abandon.textContent = "確定を中止";
      abandon.disabled = pendingBusy.has(m.meetingId);
      abandon.addEventListener("click", () => {
        if (pendingBusy.has(m.meetingId)) return;
        pendingBusy.add(m.meetingId);
        abandon.disabled = retry.disabled = true;
        void confirmAbandon(m, app.memoryBacklogCount(m.meetingId), {
          confirm: (message) => window.confirm(message),
          exportWav: () => downloadWavs(app.exportMemoryBacklog(m.meetingId)),
          abandon: (id, confirmed) => app.abandonFinalize(id, confirmed),
          discardBacklog: (id) => app.discardMemoryBacklog(id, true),
        }).then((outcome) => {
          // キャンセルは状態を変えないので、一覧の再読込（IDB 読み取り）を待たずにボタンを戻す
          if (outcome !== "cancelled") return;
          pendingBusy.delete(m.meetingId);
          enablePendingRow(m.meetingId);
        }).catch((error: unknown) => {
          // 中止できなかった会議は一覧に残るので、再読込を待たずに今の行のボタンを戻す
          pendingBusy.delete(m.meetingId);
          enablePendingRow(m.meetingId);
          notify(noticeFor({ type: "error", error }) ?? "");
        }).finally(() => { pendingBusy.delete(m.meetingId); void refreshPending(app); });
      });
      const detail = document.createElement("p");
      const issue = app.getFinalizeIssue(m.meetingId);
      detail.textContent = `${details[index]}${issue === undefined ? "" : `。${finalizeResultText(issue)}`}`;
      li.append(label, retry, abandon, detail);
      return li;
    }),
  );
  if (meetings.length === 0) {
    const li = document.createElement("li");
    li.textContent = "なし";
    ui.pending.append(li);
  }
}

async function startRecording(app: App): Promise<void> {
  // §3.9：同意確認はスキップできない
  if (!window.confirm(CONSENT_QUESTION)) return;
  ui.start.disabled = true;
  let mediaStream: MediaStream;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    // §28.3：拒否は録音開始前のエラーとして表示する
    notify(error instanceof DOMException && error.name === "NotAllowedError" ? "マイクの使用が許可されていません。ブラウザの設定を確認してください" : (noticeFor({ type: "error", error }) ?? ""));
    ui.start.disabled = false;
    return;
  }
  // sampleRate は指定しない（§6）。ネイティブレートからのリサンプルは Worklet が行う
  const audioContext = new AudioContext();
  const detachAudioMonitor = attachAudioContextMonitor(audioContext, app.health);
  try {
    const session = await app.startRecording({
      audioContext,
      mediaStream,
      meetingId: crypto.randomUUID(),
      title: ui.title.value.trim() === "" ? "無題の会議" : ui.title.value.trim(),
      consentConfirmedAt: Date.now(),
      onHidden: () => onHidden(app),
    });
    recording = { session, audioContext, detachAudioMonitor, startedAt: performance.now() };
    if (app.currentSession !== session) releaseRecording(session.meetingId);
  } catch (error) {
    detachAudioMonitor();
    for (const track of mediaStream.getTracks()) track.stop();
    await audioContext.close().catch(() => undefined);
    notify(noticeFor({ type: "error", error }) ?? "");
  } finally {
    ui.start.disabled = false;
  }
}

function releaseRecording(meetingId: string): void {
  if (recording?.session.meetingId !== meetingId) return;
  const current = recording;
  recording = null;
  // 確定の完了を待たずに次の録音を始められるので、停止ボタンは録音の解放時点で戻す
  ui.stop.disabled = false;
  if (current.session.controller.memoryBacklogCount > 0) stoppedWithBacklog.add(current.session.controller);
  current.detachAudioMonitor();
  void current.audioContext.close().catch(() => undefined);
}

async function stopRecording(app: App): Promise<void> {
  if (recording === null) return;
  const current = recording;
  ui.stop.disabled = true;
  try {
    const result = await current.session.stop();
    if (!result.ok && app.getFinalizeIssue(current.session.meetingId) !== result) notify(finalizeResultText(result));
  } catch (error) {
    notify(noticeFor({ type: "error", error }) ?? "");
  } finally {
    releaseRecording(current.session.meetingId);
    await refreshPending(app);
  }
}

/**
 * §15：メモリ待機中の Chunk を利用者の手元へ書き出す（メモリ待機からは外さない）。
 * 確定を中止した会議の分は送られないので、書き出した後に保存を確かめて破棄できるようにする（中止時に破棄を見送った場合の経路）
 */
async function exportMemoryBacklog(app: App): Promise<void> {
  // 空になった controller は外す（drainMemoryBacklog でサーバーへ送れた場合など）
  for (const controller of stoppedWithBacklog) {
    if (controller.memoryBacklogCount === 0) stoppedWithBacklog.delete(controller);
  }
  const controllers = recording === null ? [...stoppedWithBacklog] : [recording.session.controller, ...stoppedWithBacklog];
  const files = controllers.flatMap((controller) => controller.exportMemoryBacklog());
  const exported = new Set(files.map((f) => f.meta.meetingId));
  // 破棄の確認は書き出しに含めた会議だけに出す。stoppedWithBacklog から漏れた controller の分も App から集めて同じ書き出しに入れる
  const discardable = app.discardableMemoryBacklog();
  for (const { meetingId } of discardable) {
    if (exported.has(meetingId)) continue;
    const extra = app.exportMemoryBacklog(meetingId);
    files.push(...extra);
    if (extra.length > 0) exported.add(meetingId);
  }
  await downloadWavs(files);
  for (const { meetingId, title, count } of discardable) {
    if (!exported.has(meetingId)) continue;
    if (window.confirm(discardBacklogQuestion(title, count))) await app.discardMemoryBacklog(meetingId, true);
  }
}

/** ダウンロードの開始後、URL を破棄するまでの猶予。すぐ破棄すると保存先の確認中に失敗することがある */
const DOWNLOAD_URL_TTL_MS = 60_000;

/**
 * WAV を 1 回のダウンロードで渡す。複数あれば無圧縮 ZIP にまとめる（Chrome は連続した自動ダウンロードを確認なしに止めることがある）。
 * 入れたファイル名を通知欄に出し、利用者が保存したファイルの中身と照らせるようにする
 */
async function downloadWavs(files: readonly MemoryBacklogFile[]): Promise<void> {
  if (files.length === 0) return;
  const single = files.length === 1 ? files[0] : undefined;
  const fileName = single?.fileName ?? `memory-backlog_${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
  const blob = single?.wav ?? await buildStoredZip(files.map((f) => ({ name: f.fileName, data: f.wav })), new Date());
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_TTL_MS);
  notify(single !== undefined ? `書き出し: ${fileName}` : `書き出し: ${fileName}（${files.length} 件: ${files.map((f) => f.fileName).join(", ")}）`);
}

function onEvent(event: AppEvent): void {
  if (event.type === "recording_stopped") releaseRecording(event.meetingId);
  const text = noticeFor(event);
  if (text !== null) notify(text);
  if (event.type === "memory_backlog_export_required") ui.exportRow.hidden = false;
}

async function main(): Promise<void> {
  ui.tabCloseHelp.textContent = TAB_CLOSE_HELP;
  ui.localDataNotice.textContent = LOCAL_DATA_NOTICE;

  let db: IDBDatabase;
  try {
    db = await openDatabase();
  } catch (error) {
    // §10：別タブが旧バージョンを開いたままだとアップグレードが塞がれる
    const blocked = error instanceof Error && error.message.includes("blocked");
    notify(blocked ? "他のタブでこのアプリを開いたままです。他のタブを閉じてから再読み込みしてください" : (noticeFor({ type: "error", error }) ?? ""));
    return;
  }

  // recovered は createApp の中（起動時の復旧）で届くため、その時点ではまだ app がない。一覧は起動後に refreshPending で出す
  let created: App | null = null;
  const app = await createApp({
    db,
    baseUrl: BACKEND_BASE_URL,
    workletModuleUrl,
    locks: navigator.locks,
    onEvent: (event) => {
      onEvent(event);
      if ((event.type === "finalized" || event.type === "finalize_pending" || event.type === "finalize_abandoned" || event.type === "recording_stopped") && created !== null) void refreshPending(created);
    },
  });
  created = app;

  ui.start.addEventListener("click", () => void startRecording(app));
  ui.stop.addEventListener("click", () => void stopRecording(app));
  ui.exportButton.addEventListener("click", () => {
    void exportMemoryBacklog(app).catch((error: unknown) => notify(noticeFor({ type: "error", error }) ?? ""));
  });
  ui.tokenForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const token = ui.token.value.trim();
    if (token === "") return;
    void app
      .setToken(token)
      .then(() => {
        ui.token.value = "";
        notify("トークンを保存しました");
      })
      .catch((error: unknown) => notify(noticeFor({ type: "error", error }) ?? ""));
  });

  startRenderLoop(app);
  await refreshPending(app);
  setInterval(() => void refreshPending(app), PENDING_REFRESH_INTERVAL_MS);
}

void main();

// エントリポイント（§31.4）。DOM の薄い層で、表示文言は src/ui/recording-view.ts が作る
import { createApp, type App, type AppEvent, type RecordingSession } from "./app/app";
import { assessHealth, attachAudioContextMonitor } from "./recording/recording-health-monitor";
import { openDatabase } from "./storage/idb";
import {
  backendBanner,
  CONSENT_QUESTION,
  elapsedText,
  finalizeResultText,
  LOCAL_DATA_NOTICE,
  noticeFor,
  storageUsageText,
  TAB_CLOSE_HELP,
  warningsFor,
} from "./ui/recording-view";
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
let hiddenTimer: ReturnType<typeof setInterval> | null = null;

function render(app: App): void {
  const banner = backendBanner(app.monitor.state, app.health);
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

async function refreshPending(app: App): Promise<void> {
  const meetings = await app.listPendingFinalize();
  ui.pending.replaceChildren(
    ...meetings.map((m) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `${m.title}（${new Date(m.createdAt).toLocaleString()}） `;
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "再試行";
      retry.addEventListener("click", () => {
        retry.disabled = true;
        void app
          .retryFinalize(m.meetingId)
          .then((result) => notify(`${m.title}: ${finalizeResultText(result)}`))
          .catch((error: unknown) => notify(noticeFor({ type: "error", error }) ?? ""))
          .finally(() => void refreshPending(app));
      });
      li.append(label, retry);
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
  } catch (error) {
    detachAudioMonitor();
    for (const track of mediaStream.getTracks()) track.stop();
    await audioContext.close().catch(() => undefined);
    notify(noticeFor({ type: "error", error }) ?? "");
  } finally {
    ui.start.disabled = false;
  }
}

async function stopRecording(app: App): Promise<void> {
  if (recording === null) return;
  const current = recording;
  ui.stop.disabled = true;
  try {
    const result = await current.session.stop();
    notify(finalizeResultText(result));
  } catch (error) {
    notify(noticeFor({ type: "error", error }) ?? "");
  } finally {
    recording = null;
    current.detachAudioMonitor();
    await current.audioContext.close().catch(() => undefined);
    ui.stop.disabled = false;
    await refreshPending(app);
  }
}

/** §15：メモリ待機中の Chunk を利用者の手元へ書き出す（メモリ待機からは外さない） */
function exportMemoryBacklog(): void {
  if (recording === null) return;
  for (const file of recording.session.controller.exportMemoryBacklog()) {
    const url = URL.createObjectURL(file.wav);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function onEvent(event: AppEvent): void {
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
      if (event.type === "finalized" && created !== null) void refreshPending(created);
    },
  });
  created = app;

  ui.start.addEventListener("click", () => void startRecording(app));
  ui.stop.addEventListener("click", () => void stopRecording(app));
  ui.exportButton.addEventListener("click", exportMemoryBacklog);
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

// src/recording/page-lifecycle.ts
import type { RecordingController } from "./recording-controller";

export interface PageLifecycleHandles {
  readonly detach: () => void;
}

/**
 * - beforeunload: 録音中は離脱確認ダイアログを要求する（表示されるかはブラウザ依存、§5）
 * - pagehide: Worklet に flush を要求し、部分 Chunk を IndexedDB へ書き込む。完了は保証されない（損失上限 30 秒）
 * - visibilitychange: hidden になったら Health の監視間隔を詰める（判定はフレーム基準のまま）
 */
export function attachPageLifecycle(controller: Pick<RecordingController, "flush">, isRecording: () => boolean, onHidden: () => void): PageLifecycleHandles {
  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!isRecording()) return;
    event.preventDefault();
    // 文言はブラウザが固定するため任意文字列でよい。空文字はブラウザによって無視される。
    event.returnValue = "recording";
  };

  const onPageHide = () => {
    if (!isRecording()) return;
    // await できない（ページは即座に破棄されうる）。IndexedDB への put 要求を発行するところまでが限界。
    void controller.flush();
  };

  const onVisibility = () => {
    if (document.visibilityState === "hidden") onHidden();
  };

  window.addEventListener("beforeunload", onBeforeUnload);
  window.addEventListener("pagehide", onPageHide);
  document.addEventListener("visibilitychange", onVisibility);

  return {
    detach: () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}

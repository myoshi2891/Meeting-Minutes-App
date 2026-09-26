import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachPageLifecycle } from "../src/recording/page-lifecycle";
import type { RecordingController } from "../src/recording/recording-controller";

// DOM ライブラリは使わず、window / document を EventTarget で差し替える（§24.1）
type FakeDocument = EventTarget & { visibilityState: DocumentVisibilityState };

/**
 * ブラウザの BeforeUnloadEvent と同じく returnValue に文字列を保持する。
 * Node の Event.returnValue は旧仕様のアクセサ（!defaultPrevented を返し、falsy の代入で preventDefault する）なので、
 * インスタンスに書き込み可能なデータプロパティを定義して上書きする。
 */
function beforeUnloadEvent(): Event {
  const event = new Event("beforeunload", { cancelable: true });
  Object.defineProperty(event, "returnValue", { value: "", writable: true });
  return event;
}

function returnValueOf(event: Event): unknown {
  return Reflect.get(event, "returnValue");
}

describe("attachPageLifecycle", () => {
  let win: EventTarget;
  let doc: FakeDocument;
  let flush: ReturnType<typeof vi.fn>;
  let controller: RecordingController;
  let recording: boolean;
  let onHidden: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    win = new EventTarget();
    doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    flush = vi.fn(async () => undefined);
    controller = { flush } as unknown as RecordingController;
    recording = true;
    onHidden = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("録音中の beforeunload は離脱確認を要求する", () => {
    // Arrange
    attachPageLifecycle(controller, () => recording, onHidden);
    const event = beforeUnloadEvent();
    // Act
    win.dispatchEvent(event);
    // Assert
    expect(event.defaultPrevented).toBe(true);
    expect(returnValueOf(event)).toBe("recording");
  });

  it("録音していなければ beforeunload で離脱確認を要求しない", () => {
    // Arrange
    recording = false;
    attachPageLifecycle(controller, () => recording, onHidden);
    const event = beforeUnloadEvent();
    // Act
    win.dispatchEvent(event);
    // Assert
    expect(event.defaultPrevented).toBe(false);
    expect(returnValueOf(event)).toBe("");
  });

  it("録音中の pagehide は Worklet に flush を要求する", () => {
    // Arrange
    attachPageLifecycle(controller, () => recording, onHidden);
    // Act
    win.dispatchEvent(new Event("pagehide"));
    // Assert
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("録音していなければ pagehide で flush しない", () => {
    // Arrange
    recording = false;
    attachPageLifecycle(controller, () => recording, onHidden);
    // Act
    win.dispatchEvent(new Event("pagehide"));
    // Assert
    expect(flush).not.toHaveBeenCalled();
  });

  it("visibilitychange で hidden になったときだけ onHidden を呼ぶ", () => {
    // Arrange
    attachPageLifecycle(controller, () => recording, onHidden);
    // Act
    doc.dispatchEvent(new Event("visibilitychange"));
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    // Assert
    expect(onHidden).toHaveBeenCalledTimes(1);
  });

  it("detach 後はどのイベントにも反応しない", () => {
    // Arrange
    const handles = attachPageLifecycle(controller, () => recording, onHidden);
    const event = beforeUnloadEvent();
    // Act
    handles.detach();
    win.dispatchEvent(event);
    win.dispatchEvent(new Event("pagehide"));
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    // Assert
    expect(event.defaultPrevented).toBe(false);
    expect(flush).not.toHaveBeenCalled();
    expect(onHidden).not.toHaveBeenCalled();
  });
});

// エントリポイント。UI は T3-c で実装する。ここでは Worklet の URL を解決してビルドに含めるだけ
import workletModuleUrl from "./worklet/pcm-chunker.worklet.ts?worker&url";

const root = document.getElementById("app");
if (root !== null) root.dataset.workletModuleUrl = workletModuleUrl;

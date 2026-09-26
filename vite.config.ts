import { defineConfig } from "vite";

// ローカル専用（§4.4）。開発サーバーはループバックにだけ bind する
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
  },
  // AudioWorklet は addModule() で ES モジュールとして読み込む（?worker&url で別エントリとして出力される）
  worker: {
    format: "es",
  },
});

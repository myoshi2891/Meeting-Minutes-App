import { defineConfig } from "vite";

// frame-ancestors は meta では無視されるため、フレーム埋め込み拒否はヘッダで付ける（§4.4）
const frameDenyHeaders = {
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

// ローカル専用（§4.4）。開発サーバーはループバックにだけ bind する
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    headers: frameDenyHeaders,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    strictPort: true,
    headers: frameDenyHeaders,
  },
  // AudioWorklet は addModule() で ES モジュールとして読み込む（?worker&url で別エントリとして出力される）
  worker: {
    format: "es",
  },
});

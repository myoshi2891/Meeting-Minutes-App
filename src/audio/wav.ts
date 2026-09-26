// src/audio/wav.ts

export const WAV_HEADER_BYTES = 44;
export const WAV_SAMPLE_RATE = 16000;
export const WAV_CHANNELS = 1;
export const WAV_BITS_PER_SAMPLE = 16;

/** PCM16 mono 16kHz の Int16Array から Standalone WAV（ヘッダ付き ArrayBuffer）を生成する。 */
export function buildStandaloneWav(pcm: Int16Array): ArrayBuffer {
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  const blockAlign = (WAV_CHANNELS * WAV_BITS_PER_SAMPLE) / 8; // 2
  const byteRate = WAV_SAMPLE_RATE * blockAlign;               // 32000

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);      // ChunkSize = 4 + (8 + 16) + (8 + dataBytes)
  writeAscii(view, 8, "WAVE");

  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);                  // Subchunk1Size (PCM)
  view.setUint16(20, 1, true);                   // AudioFormat = 1 (PCM)
  view.setUint16(22, WAV_CHANNELS, true);
  view.setUint32(24, WAV_SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, WAV_BITS_PER_SAMPLE, true);

  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  // PCM 本体。DataView 経由で LE を明示する（プラットフォームのエンディアンに依存しない）。
  let offset = WAV_HEADER_BYTES;
  for (let i = 0; i < pcm.length; i++, offset += 2) {
    view.setInt16(offset, pcm[i], true);
  }
  return buffer;
}

export interface WavHeader {
  readonly riffChunkSize: number;
  readonly audioFormat: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly byteRate: number;
  readonly blockAlign: number;
  readonly bitsPerSample: number;
  readonly dataBytes: number;
  readonly sampleCount: number;
}

export type WavParseResult =
  | { readonly ok: true; readonly header: WavHeader }
  | { readonly ok: false; readonly reason: string };

/** 44 バイトヘッダを検証しつつ解析する。Result 型で失敗理由を返す。 */
export function parseWavHeader(buffer: ArrayBuffer): WavParseResult {
  if (buffer.byteLength < WAV_HEADER_BYTES) {
    return { ok: false, reason: `too short: ${buffer.byteLength} bytes` };
  }
  const view = new DataView(buffer);
  if (readAscii(view, 0, 4) !== "RIFF") return { ok: false, reason: "missing RIFF" };
  if (readAscii(view, 8, 4) !== "WAVE") return { ok: false, reason: "missing WAVE" };
  if (readAscii(view, 12, 4) !== "fmt ") return { ok: false, reason: "missing fmt " };
  if (readAscii(view, 36, 4) !== "data") return { ok: false, reason: "missing data" };

  const header: WavHeader = {
    riffChunkSize: view.getUint32(4, true),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    dataBytes: view.getUint32(40, true),
    sampleCount: view.getUint32(40, true) / 2,
  };

  if (header.audioFormat !== 1) return { ok: false, reason: `audioFormat ${header.audioFormat} is not PCM` };
  if (header.channels !== WAV_CHANNELS) return { ok: false, reason: `channels ${header.channels}` };
  if (header.sampleRate !== WAV_SAMPLE_RATE) return { ok: false, reason: `sampleRate ${header.sampleRate}` };
  if (header.bitsPerSample !== WAV_BITS_PER_SAMPLE) return { ok: false, reason: `bits ${header.bitsPerSample}` };
  if (header.blockAlign !== 2 || header.byteRate !== 32000) return { ok: false, reason: "blockAlign/byteRate mismatch" };
  if (header.riffChunkSize !== 36 + header.dataBytes) return { ok: false, reason: "riff size mismatch" };
  if (WAV_HEADER_BYTES + header.dataBytes !== buffer.byteLength) {
    return { ok: false, reason: `data size ${header.dataBytes} != actual ${buffer.byteLength - WAV_HEADER_BYTES}` };
  }
  return { ok: true, header };
}

/** WAV から PCM 本体を Int16Array として取り出す（コピー）。 */
export function extractPcm(buffer: ArrayBuffer): Int16Array {
  const view = new DataView(buffer);
  const count = (buffer.byteLength - WAV_HEADER_BYTES) / 2;
  const pcm = new Int16Array(count);
  for (let i = 0; i < count; i++) pcm[i] = view.getInt16(WAV_HEADER_BYTES + i * 2, true);
  return pcm;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = "";
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

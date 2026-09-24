// test/chunk-standalone.test.ts
import { describe, expect, it } from "vitest";
import { buildStandaloneWav, extractPcm, parseWavHeader, WAV_HEADER_BYTES } from "../src/audio/wav";
import { ChunkStore, openDatabase } from "../src/storage/idb";
import { makeChunkRecord } from "./harness";

describe("Chunk 単体再生可能性", () => {
  it("44 バイトヘッダの全フィールドが固定仕様と一致する", () => {
    const pcm = new Int16Array(480000);
    const wav = buildStandaloneWav(pcm);
    const view = new DataView(wav);
    expect(wav.byteLength).toBe(960044);
    expect(String.fromCharCode(...new Uint8Array(wav, 0, 4))).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 960000);
    expect(String.fromCharCode(...new Uint8Array(wav, 8, 4))).toBe("WAVE");
    expect(String.fromCharCode(...new Uint8Array(wav, 12, 4))).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(String.fromCharCode(...new Uint8Array(wav, 36, 4))).toBe("data");
    expect(view.getUint32(40, true)).toBe(960000);
  });

  it("IndexedDB から読み戻した Blob を単独でパースでき、PCM がラウンドトリップする", async () => {
    const chunkStore = new ChunkStore(await openDatabase());
    const r = await makeChunkRecord("m-standalone", 7);
    await chunkStore.putChunk(r);
    const loaded = await chunkStore.getChunk(r.chunkKey);
    if (loaded === undefined || loaded.wav === null) throw new Error("chunk missing");
    const buf = await loaded.wav.arrayBuffer();
    const parsed = parseWavHeader(buf);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.header.sampleCount).toBe(480000);
    expect(parsed.header.dataBytes).toBe(buf.byteLength - WAV_HEADER_BYTES);
    const pcm = extractPcm(buf);
    expect(pcm.length).toBe(480000);
    expect(pcm[0]).toBe(7); // makeChunkRecord は seq をオフセットとして加えている
  });

  it("部分 Chunk（flush 由来）も単体で整合したヘッダを持つ", () => {
    const pcm = new Int16Array(12345);
    const wav = buildStandaloneWav(pcm);
    const parsed = parseWavHeader(wav);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.header.sampleCount).toBe(12345);
  });

  it("壊れたヘッダは Result 型で拒否される", () => {
    const wav = buildStandaloneWav(new Int16Array(10));
    new DataView(wav).setUint32(24, 44100, true); // sampleRate を書き換え
    const parsed = parseWavHeader(wav);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("sampleRate");
  });

  it("44 バイト未満のバッファは too short で拒否される", () => {
    const parsed = parseWavHeader(new ArrayBuffer(43));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("too short");
  });

  it("RIFF シグネチャが欠落していれば拒否される", () => {
    const wav = buildStandaloneWav(new Int16Array(10));
    new Uint8Array(wav)[0] = 0x58; // "XIFF"
    const parsed = parseWavHeader(wav);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("RIFF");
  });

  it("data サイズと実バイト長が食い違えば拒否される（途中で切れたファイル）", () => {
    const wav = buildStandaloneWav(new Int16Array(100));
    const truncated = wav.slice(0, wav.byteLength - 2);
    const parsed = parseWavHeader(truncated);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain("data size");
  });

  it("PCM は Little Endian で書き込まれ extractPcm でラウンドトリップする", () => {
    const pcm = Int16Array.from([0, 1, -1, 32767, -32768, 0x1234]);
    const wav = buildStandaloneWav(pcm);
    expect(new Uint8Array(wav, 44 + 5 * 2, 2)).toEqual(Uint8Array.from([0x34, 0x12]));
    expect(extractPcm(wav)).toEqual(pcm);
  });
});

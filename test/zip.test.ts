import { describe, expect, it } from "vitest";
import { buildStoredZip, crc32 } from "../src/export/zip";

/** 中央ディレクトリから名前・CRC・サイズ・ローカルヘッダ位置を読む（書き出した ZIP が展開できる形かの確認用） */
function readCentralDirectory(bytes: Uint8Array): Array<{ name: string; crc: number; size: number; offset: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.byteLength - 22;
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(p, true)).toBe(0x02014b50);
    const nameLength = view.getUint16(p + 28, true);
    entries.push({
      name: new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLength)),
      crc: view.getUint32(p + 16, true),
      size: view.getUint32(p + 24, true),
      offset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLength;
  }
  return entries;
}

describe("buildStoredZip", () => {
  it("CRC-32 は標準の値（\"123456789\" → cbf43926）", () => {
    expect(crc32(new TextEncoder().encode("123456789")).toString(16)).toBe("cbf43926");
  });

  it("全ファイルを無圧縮で 1 つの ZIP に入れ、名前・CRC・中身を取り出せる", async () => {
    // Arrange
    const files = [
      { name: "m_mic_000000.wav", data: new Blob([new Uint8Array([1, 2, 3])]) },
      { name: "m_mic_000001.wav", data: new Blob([new Uint8Array([4, 5])]) },
    ];
    // Act
    const bytes = new Uint8Array(await (await buildStoredZip(files, new Date(2026, 10, 9, 12, 0, 0))).arrayBuffer());
    // Assert
    const view = new DataView(bytes.buffer);
    const entries = readCentralDirectory(bytes);
    expect(entries.map((e) => e.name)).toEqual(["m_mic_000000.wav", "m_mic_000001.wav"]);
    for (const [i, e] of entries.entries()) {
      const original = new Uint8Array(await files[i].data.arrayBuffer());
      expect(e.size).toBe(original.byteLength);
      expect(e.crc).toBe(crc32(original));
      // ローカルヘッダの後ろに元のバイト列がそのまま入っている（method 0 = 無圧縮）
      expect(view.getUint32(e.offset, true)).toBe(0x04034b50);
      expect(view.getUint16(e.offset + 8, true)).toBe(0);
      const start = e.offset + 30 + view.getUint16(e.offset + 26, true);
      expect([...bytes.subarray(start, start + e.size)]).toEqual([...original]);
    }
  });

  it("ファイルがなければ失敗する（空の書き出しを成功と誤認させない）", async () => {
    await expect(buildStoredZip([], new Date())).rejects.toThrow();
  });
});

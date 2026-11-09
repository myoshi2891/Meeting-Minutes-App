// src/export/zip.ts
// 複数の WAV を 1 回のダウンロードで渡すための無圧縮（stored）ZIP。WAV はほぼ圧縮できないので deflate は使わない。
// 外部ライブラリを足さないため最小限の形式だけを書く（ZIP64・暗号化・コメントなし。1 ファイル 4GB 未満）

export interface ZipEntry {
  readonly name: string;
  readonly data: Blob;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS 形式の日時（ローカル時刻、2 秒単位） */
function dosDateTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export async function buildStoredZip(entries: readonly ZipEntry[], modified: Date): Promise<Blob> {
  if (entries.length === 0) throw new Error("ZIP に入れるファイルがありません");
  const { time, date } = dosDateTime(modified);
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = new Uint8Array(await entry.data.arrayBuffer());
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // 展開に必要なバージョン 2.0
    local.setUint16(6, 0x0800, true); // ファイル名は UTF-8
    local.setUint16(8, 0, true); // 無圧縮
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.byteLength, true);
    local.setUint32(22, data.byteLength, true);
    local.setUint16(26, name.byteLength, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name, data);

    const header = new Uint8Array(46 + name.byteLength);
    const cd = new DataView(header.buffer);
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.byteLength, true);
    cd.setUint32(24, data.byteLength, true);
    cd.setUint16(28, name.byteLength, true);
    cd.setUint32(42, offset, true); // 追加フィールド・コメント・ディスク番号・属性は 0 のまま
    header.set(name, 46);
    central.push(header);
    offset += 30 + name.byteLength + data.byteLength;
  }
  const centralSize = central.reduce((sum, h) => sum + h.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}

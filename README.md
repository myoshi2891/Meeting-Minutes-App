# Meeting-Minutes-App

完全ローカル処理の議事録アプリ。現在は Phase 1 の実機検証中です。

## 起動

```sh
npm ci
npm run dev
```

Chrome で http://127.0.0.1:5173/ を開きます。保存用APIサーバーは別プロセスです。

## ローカル保存サーバー（Step 1-d）

別のターミナルで以下を実行します。

```sh
uv sync --extra test
.venv/bin/python -m minutes_local
```

サーバーは `127.0.0.1:43117` のみに待ち受けます。検証データはGit管理外の `private/phase1-data/` に保存されます。起動するたび `private/phase1-data/token` の内容が新しくなるので、ブラウザのトークン欄に入力して保存してください。トークンをチャットやコミットに貼らないでください。サーバーを止めるときはそのターミナルで Ctrl+C を押します。録音とSQLiteは再起動後も残ります。

既存の Step 1-c 会議は消さずに使えます。サーバー起動後にブラウザを開き、トークンを設定すると、待機中の Chunk の再送と確定が始まります。画面で「確定待ち」が残る場合は「再試行」を押します。DevTools の Network で同一会議の `POST /v1/meetings` が `PUT /chunks/...` より先に成功し、PUTが201（再送時は200）であることを確認します。Application → IndexedDB の `audio_chunks` が全件 `DB_REGISTERED`、`meetings` が `finalized` になり、外部ホストへの通信がないことを確認します。ブラウザを閉じる前に録音停止ボタンを押してください。

サーバー側の登録数は、DevTools Network の `GET /v1/meetings/{meetingId}/chunks` 応答で確認できます。`chunks` に連番0〜10の11件があり、各 `registered` が `true` であることを確認してください。

検証後は `.venv/bin/python -m pytest -q`、`npm run typecheck`、`npm test`、`npm run build` を実行します。録音ファイルとトークンはGit管理外のまま保持します。

## Step 1-c：サーバーなしで5分録音

1. 会議タイトルを `phase1-step1c` にし、「録音開始」→ 同意確認 → マイク許可。声を入れながら5分5秒ほど録音します。この試験ではタブを表示したままにします。
2. 「録音停止」を押します。「サーバー未接続」「確定待ち」は正常です。停止するまではリロードしません。
3. DevTools の Application → IndexedDB → `minutes-local` で、`meetings` と `audio_chunks` を確認します。表示が古い場合はDevTools内の更新ボタンを使います。
4. 停止後、Consoleで以下を実行します。タイトルにかかわらず最新の会議を読み出し、検証結果とWAVのダウンロードリンクを表示します。「無題の会議」で録音済みでも録り直しは不要です。出力されたタイトル・会議ID・開始日時で対象を確認してください。IndexedDBの内容は変更しません。

```javascript
await (async () => {
  const { openDatabase, MeetingStore, ChunkStore } = await import('/src/storage/idb.ts');
  const { parseWavHeader } = await import('/src/audio/wav.ts');
  const db = await openDatabase();
  let meeting, chunks;
  try {
    const store = new MeetingStore(db);
    const candidates = (await Promise.all(
      ['recording', 'stop_requested', 'finalizing', 'finalized'].map(s => store.listByStatus(s))
    )).flat();
    meeting = candidates.sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!meeting) throw new Error('録音済みの会議がありません');
    if (meeting.status === 'recording') throw new Error('先に録音停止を押してください');
    chunks = await new ChunkStore(db).listByMeeting(meeting.meetingId, 'mic');
  } finally {
    db.close();
  }
  document.getElementById('step1c-downloads')?.remove();
  const panel = document.createElement('section');
  panel.id = 'step1c-downloads';
  const heading = document.createElement('h2');
  heading.textContent = `Step 1-c WAV：${meeting.meetingId}`;
  panel.append(heading);
  const rows = [], urls = [];
  for (const [i, c] of chunks.entries()) {
    const bytes = c.wav === null ? null : await c.wav.arrayBuffer();
    const parsed = bytes === null ? null : parseWavHeader(bytes);
    const hash = bytes === null ? null : Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
      b => b.toString(16).padStart(2, '0')
    ).join('');
    rows.push({ seq: c.meta.sequenceNo, samples: c.meta.sampleCount,
      seconds: c.meta.sampleCount / 16000, status: c.save.status,
      valid: c.meta.sequenceNo === i && parsed?.ok === true &&
        parsed.header.sampleCount === c.meta.sampleCount &&
        bytes.byteLength === c.meta.sizeBytes && hash === c.meta.sha256 });
    if (c.wav !== null) {
      const link = document.createElement('a');
      link.href = URL.createObjectURL(c.wav);
      urls.push(link.href);
      link.download = `${meeting.meetingId}_mic_${String(c.meta.sequenceNo).padStart(6, '0')}.wav`;
      link.textContent = `${c.meta.sequenceNo}: ${c.meta.sampleCount / 16000}秒 WAVを保存`;
      const line = document.createElement('p');
      line.append(link);
      panel.append(line);
    }
  }
  const cleanup = () => urls.forEach(url => URL.revokeObjectURL(url));
  window.addEventListener('pagehide', cleanup, { once: true });
  document.body.append(panel);
  console.table(rows);
  const fullChunks = rows.filter(r => r.samples === 480000).length;
  const partialChunks = rows.filter(r => r.samples > 0 && r.samples < 480000).length;
  const allValid = rows.length > 0 && rows.every(r => r.valid);
  const complete = fullChunks === 10 && partialChunks >= 1;
  console.log({ meetingId: meeting.meetingId, title: meeting.title,
    createdAt: new Date(meeting.createdAt).toLocaleString(), total: rows.length,
    fullChunks, partialChunks, allValid, complete,
    result: !complete ? 'incomplete' : allValid ? 'pass' : 'fail' });
})();
```

5. `result: 'pass'`（`complete: true` かつ `allValid: true`）、`fullChunks: 10`、連番が0から続くことを確認します。停止操作でできた30秒未満の末尾は `partialChunks` として別に数えます。`complete` は完全Chunkがちょうど10件かつ端数Chunkが1件以上あるときだけ `true` で、そうでなければ `result: 'incomplete'` です。この場合 `allValid: true` でも合格とせず、録音時間と警告を記録して原因を確認します。
6. 画面末尾の各リンクからWAVを保存し、ファイルをChromeの別タブで開いて各Chunk単独で再生できるか確認します。アプリのCSPはBlob URLのページ内メディア再生を許可していないため、ダウンロードしたWAVをブラウザの音声プレーヤーで再生します。
7. DevToolsのNetworkで送信先を確認します。`127.0.0.1:43117` の接続失敗は想定内です。外部ホストへの要求や録音中の警告があれば記録します。

画面の読み方：`BACKEND_UNAVAILABLE` はサーバー未接続による保存待ち、会議の `stop_requested` は録音停止後の確定待ちです。サーバーなしの試験ではどちらも想定どおりです。停止後の経過時間は現状 `00:00` に戻ります。バナーの「録音は継続中」は停止後にも表示される既知の表示不整合であり、録音状態は「録音開始」ボタンと会議の状態で確認します。11件という総数だけでは、完全Chunk10件＋端数1件かどうかや音声の正常性は判定できません。

報告する内容：OS・Chromeバージョン、完全Chunk数、端数Chunk数、`allValid`、全Chunkの再生可否、警告・エラー、外部通信の有無。録音データやトークンを報告へ添付する必要はありません。

## 実機確認の記録（2026-09-27）

30秒×10件＋16.115125秒×1件、連番0〜10、全件 `valid: true` / `allValid: true` を画像で確認しました。利用者はダウンロードした全11件の音声を確認済みです。Chromeでの単体再生と外部通信ゼロの実機確認は未確認として残します。次は既存会議の実サーバー送信を確認します。引き継ぎの詳細は [PROGRESS.md](PROGRESS.md) を参照してください。

## 続く結合確認（次の作業）

最小サーバーと会議登録の配線は実装済みです。以下の実機確認は未実施です。各試験の開始前にサーバーのトークンをブラウザに設定し、結果は `PROGRESS.md` に記録します。

- 通常保存・確定、サーバー5分停止中の録音継続、再起動・トークン更新後の再送。
- タブ強制終了からの復旧、別タブで録音中の会議の保護。
- 同意キャンセル、マイク権限拒否・切断、タブ切替・最小化・画面ロック。
- IDB書き込み失敗＋サーバー停止後のWAV書き出し。

サーバー停止の試験では、録音中にサーバーのターミナルで Ctrl+C を押し、5分間録音を続けてから再起動します。トークンを再入力し、滞留Chunkが連番で送られて全件 `DB_REGISTERED` になることを確認します。強制終了の試験では、録音中のタブを閉じて再度開き、保存済みChunkの再送と「確定待ち」の復旧を確認します。別タブの試験では一方で録音中に二つ目を開き、録音中の会議が確定されないことを確認します。権限・切断・画面状態の試験は警告文言と録音状態を記録します。IDB失敗＋サーバー停止の試験では停止後にWAV書き出しを行い、ファイルを手元に保持します。

60分実録音（Step 1-g）は別途実施し、通過するまでPhase 1を完了扱いにしません。

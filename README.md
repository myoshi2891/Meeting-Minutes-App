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

画面の読み方：`BACKEND_UNAVAILABLE` はサーバー未接続による保存待ち、会議の `stop_requested` は録音停止後の確定待ちです。サーバーなしの試験ではどちらも想定どおりです。停止後の経過時間は現状 `00:00` に戻ります。録音状態は「録音開始」ボタンと会議の状態で確認します。停止後のバナーに「録音は継続中」が表示された場合は不具合として報告してください。11件という総数だけでは、完全Chunk10件＋端数1件かどうかや音声の正常性は判定できません。

報告する内容：OS・Chromeバージョン、完全Chunk数、端数Chunk数、`allValid`、全Chunkの再生可否、警告・エラー、外部通信の有無。録音データやトークンを報告へ添付する必要はありません。

## 実機確認の記録（2026-09-27）

30秒×10件＋16.115125秒×1件、連番0〜10、全件 `valid: true` / `allValid: true` を画像で確認しました。利用者はダウンロードした全11件の音声を確認済みです。Chromeでの単体再生と外部通信ゼロの実機確認は未確認として残します（この時点の記録。2026-11-08 に Chrome のネイティブプレーヤーで全11件を最後までメディアエラーなく再生できたことを確認済みで、残りは音が聞こえるかの聴取確認です。下の「次の実機確認」の 3）。次は既存会議の実サーバー送信を確認します。引き継ぎの詳細は [PROGRESS.md](PROGRESS.md) を参照してください。

## 次の実機確認（2026-11-08 更新）

T4-A〜G は確認済みです。T10/T12 の修正後、実 FastAPI サーバーと合成マイクを使った Chrome で、自動確定・次の録音の停止ボタン・認証復帰・復旧文言・切断イベントによる停止・確定中止を確認しました。実マイクでの短時間録音も、36.808秒・2 Chunkの保存と手動再試行なしの確定を確認済みです（T10合格）。残りはマイクの物理切断、既存 Chunk の聴取確認、停止理由の保存確認（下の 4）、WAV 書き出しの ZIP 化の確認（下の 5）です。

**テストの実行とサーバーの再起動は、利用者の指示があるまで行いません（2026-11-08 時点で停止中）。** 指示を受けてから、次の手順で起動します。

通常の保存先 `private/phase1-data/` で上記のサーバーを起動し、以前の録音に使った Chrome プロファイルで http://127.0.0.1:5173/ を開きます。起動ごとに更新されるトークンを設定してください。検証専用サーバーと通常サーバーは同時起動できません。

1. **T10：実マイクで短時間録音（合格済み・以下は再確認用）。** タイトルを `T10-実機再確認` にして、声を入れながら35秒ほど録音し、停止します。「再試行」を押さずに確定待ちから消えることを確認します。IndexedDB の対象会議が `finalized`、Chunk が連番0・1で全件 `DB_REGISTERED` になれば合格です。停止直後だけ確定待ちになるのは正常です。残り続ける場合は画面の理由と保存先別件数を記録してください。
2. **T12-b：実マイク切断。** 切断できる外付けマイクで新しい録音を始め、数秒話してから接続を外します。「マイクが切断されたため録音を停止しました」と出て録音開始ボタンに戻り、取得済み音声が保存・確定されることを確認します。ミュートは切断の代わりにはなりません。内蔵マイクなど物理切断できない環境では未確認として残します。
3. **T4-H：既存 Chunk の聴取確認。** Chrome での再生（全11件を最後までメディアエラーなく再生）は 2026-11-08 に確認済みです（消音・16倍速だったため聴取の代わりにはしません）。残りは音が聞こえるかです。Step 1-c で保存した既存11件の WAV を Chrome の別タブで開き、各ファイルが単独で再生でき、音が聞こえることを確認します。手元にない場合は上記の読取専用 Console スクリプトで対象を取得できます。その場合、`meeting = candidates.sort((a, b) => b.createdAt - a.createdAt)[0];` の行を `meeting = await store.get('68c2f545-ff0a-4741-8f43-3b2fd46711c2');` に置き換えてください。Console スクリプトがリンクを出せるのは、IndexedDB に音声本体が残っている Chunk だけです。サーバー登録後にクォータ対策で本体が削除された Chunk はリンクが出ず、スクリプトでは取り出せません。その場合は、操作の前に表に出た欠けている連番を控えてから、サーバー側の保存ファイル `private/phase1-data/recordings/68c2f545-ff0a-4741-8f43-3b2fd46711c2/mic/<連番6桁>.wav`（例: 連番3は `000003.wav`）を Finder で開き、Chrome の新しいタブへドラッグして再生します。このファイルは移動・名前変更・上書きをせず、読むだけにしてください。中身が登録時と同じかは、ターミナルの `shasum -a 256 <ファイル>` の値が DevTools Network の `GET /v1/meetings/68c2f545-ff0a-4741-8f43-3b2fd46711c2/chunks` 応答の同じ連番の `sha256` と一致するかで確認できます。G の書き出し2件や今回の新規録音では代用しません。対象が見つからなければ Chrome プロファイルを確認します。
4. **停止理由の保存確認（作業再開後）。** 再開の指示後、手動停止の会議とマイク切断で止まった会議を1件ずつ用意します。各会議について、停止操作の**直前**に時計の時刻（秒まで）を控え、停止の通知が出た**直後**にもう一度控えてください。この 2 つの時刻の間が停止の時間帯です。マイク切断の会議では、直前の時刻は接続を外す直前に控えます。停止した直後に、DevTools の Application → IndexedDB → `minutes-local` → `meetings` で、その会議（タイトルで探します）の `meetingId` を控えてください。2件の ID は下の SQLite の確認で使います。各会議について次の3か所で、停止理由（`manual` / `mic_ended`）と検出時刻（epoch ms）の**両方**が残っていることを確認します。(1) DevTools の Application → IndexedDB → `meetings` の `stopReason` と `stopDetectedAtEpochMs`。(2) SQLite の `meetings` 表の `stop_reason` と `stop_detected_at`（例: ターミナルで `sqlite3 -readonly private/phase1-data/minutes.sqlite "SELECT id, stop_reason, stop_detected_at FROM meetings WHERE id IN ('<手動停止の会議ID>', '<マイク切断の会議ID>')"`。`<…>` は控えた2件の ID に置き換えます。最新の行ではなく ID で選ぶので、間に別の会議を登録しても対象を取り違えません。結果が2行でなければ、ID の写し間違いかサーバーに未登録です）。(3) `private/phase1-data/recordings/<会議ID>/meeting.json` の `stopReason` と `stopDetectedAtEpochMs`。検出時刻は epoch ms なので、ブラウザの Console で `new Date(<値>).toLocaleString()` を実行して時刻に直し、控えた停止の時間帯（前後に検出の遅れとして各5秒の余裕を見ます）に入っているかを確かめます。3か所の値が一致し、どちらの項目も空（`null`・欠落）でなく、検出時刻が停止の時間帯に入っていれば合格です。片方だけ空、3か所で値が違う、手動停止なのに `mic_ended`、3か所で一致していても検出時刻が停止の時間帯から外れている、などの場合は不合格として値と控えた時刻を記録します。

5. **WAV 書き出しの ZIP 化の確認（2026-11-09 の変更後）。** サーバー停止中に IDB の書き込み失敗でメモリ待機が 2 件以上残る状態（参考手順の「IDB失敗＋サーバー停止」と同じ作り方）で「WAV を書き出す」を押します。Chrome の「複数ファイルのダウンロード」の確認が出ずに ZIP が 1 つ保存されること、Finder で開けること、中のファイル名が通知欄の一覧と一致すること、各 WAV が再生できることを確認します。
6. **確定中止後の書き出しと破棄の確認（2026-11-10 の変更後）。** 5 と同じ作り方でメモリ待機が残る新規のテスト用会議を止め、「確定を中止」で最初の確認は「OK」（書き出し）、中止の確認も「OK」、最後の破棄の確認は「キャンセル」を選びます。その後「WAV を書き出す」を押し、保存されたファイル（ZIP なら中身）にその会議の WAV が入っていること、破棄の確認がその会議についてだけ出ることを確認します。確認で「OK」を押したら、バナーのメモリ内未保存の件数が 0 になり、タブを閉じるときの確認も出なくなることを確かめます。

報告は「T10の確定可否／T12-bの停止・保存可否／Hの再生できた件数（サーバー側ファイルで再生した連番があれば併記）／4の3か所の値／5のZIP（複数ダウンロード確認なしで1つ保存できたか・Finderで開けたか・ファイル名が通知欄と一致したか・再生できたWAVの件数）／6の書き出しに中止した会議のWAVが入ったか・破棄の確認がその会議だけに出たか／OS・Chrome版／警告と外部通信の有無」で十分です。録音データやトークンの共有は不要です。既存の確定待ち会議 `6a108d86…` はそのまま残します。「確定を中止」の再確認が必要なら、新規のテスト用会議だけを使います。

## 結合確認の参考手順

以下は確認済みの T4-A〜G を再実施する場合の手順です。各試験の開始前にサーバーのトークンをブラウザに設定し、結果は `PROGRESS.md` に記録します。

- 通常保存・確定、サーバー5分停止中の録音継続、再起動・トークン更新後の再送。
- タブ強制終了からの復旧、別タブで録音中の会議の保護。
- 同意キャンセル、マイク権限拒否・切断、タブ切替・最小化・画面ロック。
- IDB書き込み失敗＋サーバー停止後のWAV書き出し。

サーバー停止の試験では、録音中にサーバーのターミナルで Ctrl+C を押し、5分間録音を続けてから再起動します。トークンを再入力し、滞留Chunkが連番で送られて全件 `DB_REGISTERED` になることを確認します。強制終了の試験では、Chunkが1件以上IDBに入った後、Chromeのタスクマネージャーから録音タブのプロセスを終了し、同じURLを再度開いて、保存済みChunkの再送と「確定待ち」の復旧を確認します。通常のタブ閉じはpagehideを通るため代用しません。別タブの試験では一方で録音中に二つ目を開き、録音中の会議が確定されないことを確認します。権限・切断・画面状態の試験は警告文言と録音状態を記録します。IDB失敗＋サーバー停止の試験では停止後にWAV書き出しを行い、ファイルを手元に保持します。

60分実録音（Step 1-g）は利用者指示により保留中です（2026-11-08、再開指示待ち）。別途実施し、通過するまでPhase 1を完了扱いにしません。

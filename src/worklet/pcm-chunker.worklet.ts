// src/worklet/pcm-chunker.worklet.ts
// AudioWorkletGlobalScope で動作する。DOM / IndexedDB / fetch は使えない。
// ビルド時は別エントリとしてバンドルし、audioContext.audioWorklet.addModule() で読み込む。

// ---- AudioWorkletGlobalScope の最小宣言（lib.dom には含まれないため自前で宣言） ----
declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessorLike,
): void;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
}
interface AudioWorkletProcessorLike {
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}

// ---- 型（src/types/recording.ts と同じ定義。Worklet は別バンドルなので import せず再掲する） ----
interface VADConfig {
  readonly threshold: number;
  readonly minSpeechMs: number;
  readonly hangoverMs: number;
  readonly floorDbfs: number;
}
interface VADResult {
  readonly score: number;
  readonly hasVoice: boolean;
  readonly voicedSamples: number;
}
type WorkletCommand =
  | { readonly type: "configure"; readonly vad: VADConfig }
  | { readonly type: "start" }
  | { readonly type: "flush" }
  | { readonly type: "stop" };

const TARGET_RATE = 16000;
const SAMPLES_PER_CHUNK = 480000;
const VAD_FRAME_SAMPLES = 160; // 10ms @ 16kHz
const HEARTBEAT_INTERVAL_SAMPLES = TARGET_RATE; // 1 秒

// ---- リサンプラ：windowed-sinc FIR ローパス + 分数位相補間 ----

class SincResampler {
  private readonly ratio: number;          // 入力サンプル / 出力サンプル
  private readonly halfTaps: number;
  private readonly phases: number;
  private readonly table: Float32Array;    // [phases + 1][taps]
  private history: Float32Array;           // 直近入力（タップ幅 + 未消費分）
  private historyLen = 0;
  private position = 0;                    // 次の出力サンプルに対応する history 内の実数インデックス

  constructor(inputRate: number, outputRate: number) {
    if (inputRate <= 0 || outputRate <= 0) throw new Error("invalid sample rate");
    this.ratio = inputRate / outputRate;
    // タップ数は入力レートに比例させる（48kHz → 64、96kHz → 128）。
    this.halfTaps = Math.max(16, Math.ceil(32 * this.ratio / 3));
    this.phases = 32;
    const taps = this.halfTaps * 2;
    // カットオフ：出力ナイキスト（outputRate/2）の 0.9 倍を入力レートで正規化（cycles/sample）。
    const cutoffHz = 0.9 * Math.min(outputRate, inputRate) / 2;
    const fc = cutoffHz / inputRate;
    this.table = new Float32Array((this.phases + 1) * taps);
    for (let p = 0; p <= this.phases; p++) {
      const frac = p / this.phases;
      let sum = 0;
      for (let t = 0; t < taps; t++) {
        const n = t - this.halfTaps + 1 - frac; // 中心からの距離
        const x = 2 * Math.PI * fc * n;
        const sinc = n === 0 ? 1 : Math.sin(x) / x;
        // Blackman 窓
        const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * (t + 1 - frac)) / taps) + 0.08 * Math.cos((4 * Math.PI * (t + 1 - frac)) / taps);
        const v = 2 * fc * sinc * w;
        this.table[p * taps + t] = v;
        sum += v;
      }
      // DC ゲインを 1 に正規化
      for (let t = 0; t < taps; t++) this.table[p * taps + t] /= sum;
    }
    this.history = new Float32Array(taps + 4096);
    this.position = this.halfTaps;
  }

  /** 入力を追加し、生成できる出力サンプルをすべて返す。 */
  push(input: Float32Array): Float32Array {
    // history に追記（必要なら拡張）
    if (this.historyLen + input.length > this.history.length) {
      const grown = new Float32Array(Math.max(this.history.length * 2, this.historyLen + input.length));
      grown.set(this.history.subarray(0, this.historyLen));
      this.history = grown;
    }
    this.history.set(input, this.historyLen);
    this.historyLen += input.length;

    const taps = this.halfTaps * 2;
    const maxOutputs = Math.floor((this.historyLen - this.halfTaps - this.position) / this.ratio) + 1;
    const out = new Float32Array(Math.max(0, maxOutputs));
    let produced = 0;

    while (this.position + this.halfTaps <= this.historyLen - 1) {
      const idx = Math.floor(this.position);
      const frac = this.position - idx;
      const phaseF = frac * this.phases;
      const p0 = Math.floor(phaseF);
      const pw = phaseF - p0;
      const base0 = p0 * taps;
      const base1 = Math.min(p0 + 1, this.phases) * taps;
      const start = idx - this.halfTaps + 1;
      let acc = 0;
      for (let t = 0; t < taps; t++) {
        const s = this.history[start + t];
        const h = this.table[base0 + t] * (1 - pw) + this.table[base1 + t] * pw;
        acc += s * h;
      }
      out[produced++] = acc;
      this.position += this.ratio;
    }

    // 消費済み入力を捨て、タップ幅ぶんの履歴を残す
    const keepFrom = Math.max(0, Math.floor(this.position) - this.halfTaps);
    if (keepFrom > 0) {
      this.history.copyWithin(0, keepFrom, this.historyLen);
      this.historyLen -= keepFrom;
      this.position -= keepFrom;
    }
    return produced === out.length ? out : out.subarray(0, produced);
  }
}

// ---- VAD：10ms フレーム RMS + ハングオーバー ----

class FrameVAD {
  private config: VADConfig;
  private frameBuf = new Float32Array(VAD_FRAME_SAMPLES);
  private frameFill = 0;
  private scoreSum = 0;
  private frameCount = 0;
  private voicedSamples = 0;
  private speechRun = 0;     // 連続して threshold 以上だったサンプル数
  private hangoverLeft = 0;  // ハングオーバー残りサンプル数

  constructor(config: VADConfig) {
    this.config = config;
  }

  configure(config: VADConfig): void {
    this.config = config;
  }

  feed(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.frameBuf[this.frameFill++] = samples[i];
      if (this.frameFill === VAD_FRAME_SAMPLES) {
        this.consumeFrame();
        this.frameFill = 0;
      }
    }
  }

  private consumeFrame(): void {
    let sumSq = 0;
    for (let i = 0; i < VAD_FRAME_SAMPLES; i++) sumSq += this.frameBuf[i] * this.frameBuf[i];
    const rms = Math.sqrt(sumSq / VAD_FRAME_SAMPLES);
    const dbfs = rms > 0 ? 20 * Math.log10(rms) : this.config.floorDbfs;
    const score = Math.min(1, Math.max(0, (dbfs - this.config.floorDbfs) / (0 - this.config.floorDbfs)));
    this.scoreSum += score;
    this.frameCount++;

    const minSpeechSamples = (this.config.minSpeechMs / 1000) * TARGET_RATE;
    const hangoverSamples = (this.config.hangoverMs / 1000) * TARGET_RATE;

    if (score >= this.config.threshold) {
      this.speechRun += VAD_FRAME_SAMPLES;
      if (this.speechRun >= minSpeechSamples) {
        this.voicedSamples += VAD_FRAME_SAMPLES;
        this.hangoverLeft = hangoverSamples;
      }
    } else {
      this.speechRun = 0;
      if (this.hangoverLeft > 0) {
        this.voicedSamples += VAD_FRAME_SAMPLES;
        this.hangoverLeft = Math.max(0, this.hangoverLeft - VAD_FRAME_SAMPLES);
      }
    }
  }

  /** Chunk 境界で呼び、集計値を返してリセットする。 */
  takeResult(): VADResult {
    const minSpeechSamples = (this.config.minSpeechMs / 1000) * TARGET_RATE;
    const result: VADResult = {
      score: this.frameCount > 0 ? this.scoreSum / this.frameCount : 0,
      hasVoice: this.voicedSamples >= minSpeechSamples,
      voicedSamples: this.voicedSamples,
    };
    this.scoreSum = 0;
    this.frameCount = 0;
    this.voicedSamples = 0;
    // speechRun / hangoverLeft も Chunk 単位の集計状態として落とす。持ち越すと、直前 Chunk 末尾の
    // 発話で立った hangover（300ms）が無音だけの Chunk に voicedSamples を積み、minSpeechMs（200ms）を
    // 超えて hasVoice=true になる。無音 Chunk を STT / Live ジョブに流す誤判定は、境界をまたぐ発話の
    // 先頭 200ms を数え直す代償より高くつく。frameBuf / frameFill は 160 サンプル境界の連続性を
    // 保つためリセットしない（ここで捨てるとフレーム位相が Chunk ごとにずれる）。
    this.speechRun = 0;
    this.hangoverLeft = 0;
    return result;
  }
}

// ---- Processor 本体 ----

class PcmChunkerProcessor extends AudioWorkletProcessor implements AudioWorkletProcessorLike {
  private readonly resampler: SincResampler;
  private readonly vad: FrameVAD;
  private buffer = new Int16Array(SAMPLES_PER_CHUNK);
  private writePos = 0;
  private chunkStartFrame = 0;
  private audioFrameCount = 0;
  private nextHeartbeatAt = HEARTBEAT_INTERVAL_SAMPLES;
  private running = false;
  private stopped = false;
  private monoScratch = new Float32Array(0);

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    // sampleRate はこの AudioWorkletGlobalScope のネイティブレート。16000 とは限らない。
    this.resampler = new SincResampler(sampleRate, TARGET_RATE);
    this.vad = new FrameVAD({ threshold: 0.15, minSpeechMs: 200, hangoverMs: 300, floorDbfs: -60 });

    this.port.onmessage = (event: MessageEvent<unknown>) => {
      const cmd = event.data;
      if (!isWorkletCommand(cmd)) return;
      switch (cmd.type) {
        case "configure":
          this.vad.configure(cmd.vad);
          break;
        case "start":
          this.running = true;
          break;
        case "flush":
          this.emitChunk(true);
          this.port.postMessage({ type: "flushed", audioFrameCount: this.audioFrameCount });
          break;
        case "stop":
          this.emitChunk(true);
          this.running = false;
          this.stopped = true;
          this.port.postMessage({ type: "flushed", audioFrameCount: this.audioFrameCount });
          break;
      }
    };

    this.port.postMessage({ type: "ready", nativeSampleRate: sampleRate, renderQuantum: 128 });
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false; // false を返すと Processor は破棄される
    if (!this.running) return true;

    const input = inputs[0];
    if (input === undefined || input.length === 0 || input[0].length === 0) {
      // Mic トラック終了などで入力が来ない。heartbeat だけ送り、Processor は維持する。
      return true;
    }

    const frames = input[0].length; // 128 を仮定しない
    if (this.monoScratch.length !== frames) this.monoScratch = new Float32Array(frames);
    const mono = this.monoScratch;
    const channels = input.length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += input[c][i];
      mono[i] = sum / channels;
    }

    const resampled = this.resampler.push(mono);
    this.vad.feed(resampled);

    for (let i = 0; i < resampled.length; i++) {
      const s = Math.max(-1, Math.min(1, resampled[i]));
      this.buffer[this.writePos++] = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
      this.audioFrameCount++;
      if (this.writePos === SAMPLES_PER_CHUNK) {
        this.emitChunk(false);
      }
    }

    if (this.audioFrameCount >= this.nextHeartbeatAt) {
      this.port.postMessage({ type: "heartbeat", audioFrameCount: this.audioFrameCount, currentTime });
      this.nextHeartbeatAt += HEARTBEAT_INTERVAL_SAMPLES;
    }
    return true;
  }

  private emitChunk(partial: boolean): void {
    if (this.writePos === 0) return;
    const pcm = partial ? this.buffer.slice(0, this.writePos) : this.buffer;
    const vadResult = this.vad.takeResult();
    const startFrame = this.chunkStartFrame;
    const endFrame = startFrame + this.writePos;
    this.port.postMessage(
      {
        type: "chunk",
        pcm: pcm.buffer,
        sampleCount: this.writePos,
        startFrame,
        endFrame,
        vad: vadResult,
        partial,
      },
      [pcm.buffer],
    );
    // Transferable で所有権を移したので新しいバッファを確保する
    this.buffer = new Int16Array(SAMPLES_PER_CHUNK);
    this.writePos = 0;
    this.chunkStartFrame = endFrame;
  }
}

function isWorkletCommand(value: unknown): value is WorkletCommand {
  if (typeof value !== "object" || value === null) return false;
  const t = (value as { type?: unknown }).type;
  return t === "configure" || t === "start" || t === "flush" || t === "stop";
}

registerProcessor("pcm-chunker", PcmChunkerProcessor);

// テストから dynamic import できるようモジュールとして扱う（バンドル結果には影響しない）
export {};

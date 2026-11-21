/**
 * Records the microphone as a phone-quality WAV (8 kHz, mono, 16-bit): what Africa's Talking plays on a call.
 * Browsers record WebM or MP4 by themselves, which phone lines can't play, so the sound is taken raw and packed here.
 * About 16 KB a second: a one-minute message is under 1 MB.
 */
export class WavRecorder {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private chunks: Float32Array[] = [];
  private rate = 48000;
  startedAt = 0;

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot use the microphone.');
    try { this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }); }
    catch (e: any) {
      throw new Error(e?.name === 'NotAllowedError' ? 'The microphone is blocked. Allow it for this site (the icon by the address bar), then try again.' : 'The microphone could not start.');
    }
    this.ctx = new AudioContext();
    this.rate = this.ctx.sampleRate;
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.chunks = [];
    this.node.onaudioprocess = (e) => this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    src.connect(this.node);
    this.node.connect(this.ctx.destination);
    this.startedAt = Date.now();
  }

  get seconds() { return this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0; }

  /** Stops and returns the WAV, with its length in seconds */
  async stop(): Promise<{ blob: Blob; seconds: number }> {
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => undefined);
    const len = this.chunks.reduce((n, c) => n + c.length, 0);
    const all = new Float32Array(len);
    let o = 0;
    for (const c of this.chunks) { all.set(c, o); o += c.length; }
    this.chunks = []; this.startedAt = 0;
    const pcm = downsample(all, this.rate, 8000);
    return { blob: wav(pcm, 8000), seconds: Math.round(pcm.length / 8000) };
  }

  cancel() { void this.stop(); }
}

/** Averages the samples down to the phone rate */
function downsample(input: Float32Array, from: number, to: number): Int16Array {
  const ratio = from / to, out = new Int16Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio), b = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = a; j < b; j++) sum += input[j];
    const v = Math.max(-1, Math.min(1, sum / Math.max(1, b - a)));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return out;
}

function wav(pcm: Int16Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

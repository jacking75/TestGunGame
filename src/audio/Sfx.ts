export type SfxName =
  | 'shot'
  | 'empty'
  | 'hitBody'
  | 'hitHead'
  | 'kill'
  | 'wall'
  | 'reload'
  | 'cover'
  | 'warn'
  | 'enemyShot'
  | 'damage'
  | 'clear'
  | 'fail'
  | 'ui';

/** 임시 효과음: 외부 음원 없이 WebAudio로 합성한다. 시작 버튼(사용자 동작)에서 unlock()해야 소리가 난다. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  volume = 0.6;

  get available(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  async unlock(): Promise<boolean> {
    try {
      if (!this.ctx) {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.ctx.destination);
        const len = this.ctx.sampleRate * 0.5;
        this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state !== 'running') await this.ctx.resume();
      return this.ctx.state === 'running';
    } catch {
      return false;
    }
  }

  play(name: SfxName): void {
    if (!this.ctx || !this.master || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    switch (name) {
      case 'shot':
        this.burst(t, 0.12, 2400, 0.9);
        this.tone(t, 'square', 220, 70, 0.08, 0.25);
        break;
      case 'empty':
        this.tone(t, 'square', 1800, 1700, 0.03, 0.15);
        break;
      case 'hitBody':
        this.tone(t + 0.02, 'triangle', 660, 520, 0.08, 0.35);
        break;
      case 'hitHead':
        this.tone(t + 0.02, 'triangle', 990, 1320, 0.1, 0.4);
        break;
      case 'kill':
        this.tone(t + 0.05, 'sawtooth', 300, 80, 0.3, 0.25);
        this.burst(t + 0.05, 0.25, 900, 0.4);
        break;
      case 'wall':
        this.burst(t + 0.01, 0.05, 4000, 0.3);
        break;
      case 'reload':
        this.tone(t, 'square', 500, 500, 0.04, 0.2);
        this.tone(t + 0.09, 'square', 760, 760, 0.05, 0.2);
        break;
      case 'cover':
        this.burst(t, 0.08, 600, 0.2);
        break;
      case 'warn':
        this.tone(t, 'sine', 880, 880, 0.09, 0.3);
        this.tone(t + 0.13, 'sine', 880, 880, 0.09, 0.3);
        break;
      case 'enemyShot':
        this.burst(t, 0.15, 1200, 0.5);
        break;
      case 'damage':
        this.tone(t, 'sawtooth', 160, 60, 0.25, 0.5);
        break;
      case 'clear':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(t + i * 0.12, 'triangle', f, f, 0.18, 0.35));
        break;
      case 'fail':
        [392, 330, 262].forEach((f, i) => this.tone(t + i * 0.18, 'triangle', f, f * 0.97, 0.25, 0.35));
        break;
      case 'ui':
        this.tone(t, 'sine', 700, 900, 0.05, 0.2);
        break;
    }
  }

  private tone(t: number, type: OscillatorType, f0: number, f1: number, dur: number, gain: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.master!);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private burst(t: number, dur: number, cutoff: number, gain: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff * 0.2), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(g).connect(this.master!);
    src.start(t);
    src.stop(t + dur + 0.02);
  }
}

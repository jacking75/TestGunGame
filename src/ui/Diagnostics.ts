import type { InputFrame } from '../input/types';
import type { InputHub, SourcePreference } from '../input/InputHub';
import { IR_HEIGHT, IR_WIDTH } from '../input/wiimote/protocol';
import type { WiimoteSource } from '../input/WiimoteSource';
import { h } from './dom';

const fmt = (p: { x: number; y: number } | null) => (p ? `${p.x.toFixed(3)}, ${p.y.toFixed(3)}` : '없음');

/** 개발·지원용 입력 진단 화면(F3). 기본 게임 화면에는 표시하지 않는다. */
export class Diagnostics {
  readonly el: HTMLDivElement;
  visible = false;
  private readonly grid = h('div', { class: 'grid' });
  private readonly irCanvas = h('canvas', { width: 256, height: 192 });
  private readonly frames: number[] = [];
  private readonly pref: HTMLSelectElement;
  private reportCount = 0;
  private reportRate = 0;
  private rateTime = 0;

  constructor(
    private readonly hub: InputHub,
    private readonly wiimote: WiimoteSource,
    private readonly canvas: HTMLCanvasElement,
    private readonly calibrationInfo: () => string,
  ) {
    const pref = h(
      'select',
      {
        onchange: (e: Event) => {
          hub.preference = (e.target as HTMLSelectElement).value as SourcePreference;
        },
      },
      h('option', { value: 'auto' }, '입력: 자동'),
      h('option', { value: 'mouse' }, '입력: 마우스'),
      h('option', { value: 'wiimote' }, '입력: Wii'),
    );
    this.pref = pref;
    const smooth = h('input', {
      type: 'checkbox',
      checked: true,
      onchange: (e: Event) => {
        wiimote.smoothing = (e.target as HTMLInputElement).checked;
      },
    });
    this.el = h(
      'div',
      { id: 'diag' },
      h('h3', {}, '입력 진단 (F3로 닫기)'),
      this.grid,
      h('h3', {}, 'IR 카메라 (리모컨 시점)'),
      this.irCanvas,
      h('div', { class: 'controls' }, pref, h('label', {}, smooth, ' 평활화')),
    );
    this.el.style.display = 'none';
  }

  toggle(force?: boolean): void {
    this.visible = force ?? !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
  }

  update(dt: number, frame: InputFrame): void {
    this.frames.push(dt * 1000);
    if (this.frames.length > 240) this.frames.shift();
    const dev = this.wiimote.device;
    this.rateTime += dt;
    if (this.rateTime >= 1) {
      const n = dev?.reportCount ?? 0;
      this.reportRate = (n - this.reportCount) / this.rateTime;
      this.reportCount = n;
      this.rateTime = 0;
    }
    if (!this.visible) return;
    if (this.pref.value !== this.hub.preference) this.pref.value = this.hub.preference;

    const sorted = [...this.frames].sort((a, b) => a - b);
    const avg = this.frames.reduce((s, v) => s + v, 0) / Math.max(1, this.frames.length);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const r = this.canvas.getBoundingClientRect();
    const ir = this.wiimote.ir;

    const rows: [string, string][] = [
      ['선택 입력', `${frame.source ?? '-'} (${this.hub.preference})`],
      ['원본 좌표', fmt(frame.rawAim)],
      ['최종 좌표', fmt(frame.aim)],
      ['버튼', `발사 ${frame.fireHeld ? '●' : '○'}  엄폐 ${frame.coverHeld ? '●' : '○'}`],
      ['게임 영역', `${Math.round(r.width)}×${Math.round(r.height)} @${window.devicePixelRatio}x`],
      ['전체 화면', document.fullscreenElement ? '예' : '아니오'],
      ['프레임', `평균 ${avg.toFixed(1)}ms · 95% ${p95.toFixed(1)}ms`],
      ['보정', this.calibrationInfo()],
      ['Wii 상태', dev ? `${dev.state} · ${dev.model}` : '연결 안 됨'],
    ];
    if (dev) {
      rows.push(
        ['배터리', dev.batteryLevel === null ? '확인 중' : `${Math.round(dev.batteryLevel * 100)}%${dev.batteryLow ? ' (부족)' : ''}`],
        ['보고 빈도', `${this.reportRate.toFixed(0)}Hz`],
        ['IR 추적', `${ir.tracking} · 점 ${ir.dotCount}개 · 비틀림 ${((ir.roll * 180) / Math.PI).toFixed(0)}°`],
        ['IR 감도', dev.sensitivityName],
        ['평활화 전', fmt(this.wiimote.unfilteredAim)],
      );
    }
    this.grid.replaceChildren(...rows.flatMap(([k, v]) => [h('span', {}, k), h('span', {}, v)]));
    this.drawIr();
  }

  private drawIr(): void {
    const g = this.irCanvas.getContext('2d')!;
    const w = this.irCanvas.width;
    const ht = this.irCanvas.height;
    g.clearRect(0, 0, w, ht);
    g.strokeStyle = '#222';
    g.strokeRect(w / 2, 0, 0, ht);
    g.strokeRect(0, ht / 2, w, 0);
    const dots = this.wiimote.device?.dots ?? [];
    for (const d of dots) {
      // 리모컨 카메라 화면을 사용자 시점으로 보이도록 좌우 반전
      const x = (1 - d.x / IR_WIDTH) * w;
      const y = (d.y / IR_HEIGHT) * ht;
      g.fillStyle = '#ffeb3b';
      g.beginPath();
      g.arc(x, y, 3 + d.size, 0, Math.PI * 2);
      g.fill();
    }
    if (this.wiimote.ir.tracking !== 'none') {
      g.strokeStyle = '#19e3e3';
      g.beginPath();
      g.arc(this.wiimote.ir.x * w, this.wiimote.ir.y * ht, 8, 0, Math.PI * 2);
      g.stroke();
    }
  }
}

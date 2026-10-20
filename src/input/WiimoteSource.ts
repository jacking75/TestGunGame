import type { Point } from '../calibration/homography';
import { OneEuroFilter } from './OneEuroFilter';
import type { Action, InputSource } from './types';
import { IrPointer, type IrPointerResult } from './wiimote/IrPointer';
import { NO_BUTTONS, type WiimoteButtons } from './wiimote/protocol';
import type { WiimoteDevice, WiimoteReport } from './wiimote/WiimoteDevice';
import type { WiimoteManager } from './wiimote/WiimoteManager';

/** 건 외장 기준 버튼 의미. 방아쇠는 B를 누른다. */
const BUTTON_ACTIONS: Record<Action, (b: WiimoteButtons) => boolean> = {
  fire: (b) => b.b,
  cover: (b) => b.a,
  pause: (b) => b.plus || b.minus || b.home,
};

const ACTIVITY_MOVE = 0.004;

/**
 * Wii 리모컨 입력. 원본 좌표는 IR 카메라 기준 0~1(좌우 반전·비틀림 보정 후)이다.
 * 마우스 변환을 거치지 않으므로 IR 추적 상태와 연결 상태를 게임이 직접 안다.
 */
export class WiimoteSource implements InputSource {
  readonly id = 'wiimote' as const;
  rawAim: Point | null = null;
  /** 평활화 전 좌표(진단 화면 비교용) */
  unfilteredAim: Point | null = null;
  ir: IrPointerResult = { tracking: 'none', x: 0.5, y: 0.5, roll: 0, dotCount: 0 };
  lastActivity = 0;
  move: Point = { x: 0, y: 0 };
  smoothing = true;

  private pointer = new IrPointer();
  private fx = new OneEuroFilter();
  private fy = new OneEuroFilter();
  private buttons: WiimoteButtons = NO_BUTTONS;
  private presses: Record<Action, (Point | null)[]> = { fire: [], cover: [], pause: [] };
  private lastTime = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(readonly manager: WiimoteManager) {
    manager.onDevice((d) => this.attach(d));
  }

  get connected(): boolean {
    return this.manager.device?.state === 'ready';
  }

  get device(): WiimoteDevice | null {
    return this.manager.device;
  }

  isHeld(action: Action): boolean {
    return this.connected && BUTTON_ACTIONS[action](this.buttons);
  }

  takePresses(action: Action): (Point | null)[] {
    const p = this.presses[action];
    this.presses[action] = [];
    return p;
  }

  reset(): void {
    this.presses = { fire: [], cover: [], pause: [] };
  }

  private attach(device: WiimoteDevice | null): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.buttons = NO_BUTTONS;
    this.rawAim = null;
    this.unfilteredAim = null;
    this.pointer.reset();
    this.fx.reset();
    this.fy.reset();
    this.reset();
    if (device) {
      this.unsubscribe = device.onReport(this.handleReport);
      this.lastActivity = performance.now();
    }
  }

  private handleReport = (r: WiimoteReport): void => {
    const dt = this.lastTime ? (r.time - this.lastTime) / 1000 : 0;
    this.lastTime = r.time;

    this.ir = this.pointer.update(r.dots);
    if (this.ir.tracking === 'none') {
      this.rawAim = null;
      this.unfilteredAim = null;
      this.fx.reset();
      this.fy.reset();
    } else {
      const prev = this.rawAim;
      this.unfilteredAim = { x: this.ir.x, y: this.ir.y };
      this.rawAim = this.smoothing
        ? { x: this.fx.filter(this.ir.x, dt), y: this.fy.filter(this.ir.y, dt) }
        : this.unfilteredAim;
      if (!prev || Math.hypot(this.rawAim.x - prev.x, this.rawAim.y - prev.y) > ACTIVITY_MOVE) {
        this.lastActivity = r.time;
      }
    }

    const before = this.buttons;
    this.buttons = r.buttons;
    for (const action of Object.keys(BUTTON_ACTIONS) as Action[]) {
      const test = BUTTON_ACTIONS[action];
      if (test(r.buttons) && !test(before)) {
        this.presses[action].push(this.rawAim ? { ...this.rawAim } : null);
        this.lastActivity = r.time;
      }
    }
    const b = r.buttons;
    this.move = { x: (b.right ? 1 : 0) - (b.left ? 1 : 0), y: (b.up ? 1 : 0) - (b.down ? 1 : 0) };
  };
}

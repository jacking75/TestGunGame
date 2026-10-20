import type { Point } from '../calibration/homography';
import type { Action, InputSource } from './types';

const KEY_ACTIONS: Record<string, Action> = {
  Space: 'cover',
  Escape: 'pause',
  KeyP: 'pause',
};

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

/**
 * 개발·대체 입력: 마우스 위치 = 조준, 왼쪽 버튼 = 발사, Space 또는 오른쪽 버튼 = 엄폐, Esc/P = 일시정지.
 * 원본 좌표는 게임 영역(target) 기준 0~1이다.
 */
export class MouseKeyboardSource implements InputSource {
  readonly id = 'mouse' as const;
  rawAim: Point | null = null;
  lastActivity = 0;
  /** true인 동안 Space 스크롤·오른쪽 클릭 메뉴 등 브라우저 기본 동작을 막는다. */
  captureGameKeys = false;

  private held = new Set<Action>();
  private presses: Record<Action, (Point | null)[]> = { fire: [], cover: [], pause: [] };
  private moveKeys = new Set<string>();
  private clientPos: { x: number; y: number } | null = null;

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('pointermove', this.onPointerMove, { passive: true });
    window.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    document.documentElement.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('contextmenu', (e) => {
      if (this.captureGameKeys) e.preventDefault();
    });
  }

  get move(): Point {
    let x = 0;
    let z = 0;
    for (const k of this.moveKeys) {
      const v = MOVE_KEYS[k];
      x += v[0];
      z += v[1];
    }
    return { x: Math.sign(x), y: Math.sign(z) };
  }

  isHeld(action: Action): boolean {
    return this.held.has(action);
  }

  takePresses(action: Action): (Point | null)[] {
    const p = this.presses[action];
    this.presses[action] = [];
    return p;
  }

  reset(): void {
    this.held.clear();
    this.moveKeys.clear();
    this.presses = { fire: [], cover: [], pause: [] };
  }

  /** 화면 좌표를 게임 영역 기준 0~1 좌표로 바꾼다. 영역 밖이면 null. */
  private toRaw(clientX: number, clientY: number): Point | null {
    const r = this.target.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const x = (clientX - r.left) / r.width;
    const y = (clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
    this.clientPos = { x: e.clientX, y: e.clientY };
    this.rawAim = this.toRaw(e.clientX, e.clientY);
    this.lastActivity = performance.now();
  };

  private onPointerLeave = (): void => {
    this.clientPos = null;
    this.rawAim = null;
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.rawAim = this.toRaw(e.clientX, e.clientY);
    this.lastActivity = performance.now();
    if (e.button === 0) {
      this.held.add('fire');
      this.presses.fire.push(this.rawAim);
    } else if (e.button === 2) {
      this.held.add('cover');
      this.presses.cover.push(this.rawAim);
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.button === 0) this.held.delete('fire');
    else if (e.button === 2) this.held.delete('cover');
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    const action = KEY_ACTIONS[e.code];
    if (MOVE_KEYS[e.code]) {
      if (this.captureGameKeys) e.preventDefault();
      if (!e.repeat) this.moveKeys.add(e.code);
      return;
    }
    if (!action) return;
    if (this.captureGameKeys && e.code === 'Space') e.preventDefault();
    // 자동 반복 keydown은 새 눌림이 아니다(포커스 복귀 후 고착 방지).
    if (e.repeat) return;
    this.lastActivity = performance.now();
    this.held.add(action);
    this.presses[action].push(this.clientPos ? this.toRaw(this.clientPos.x, this.clientPos.y) : null);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.moveKeys.delete(e.code);
    const action = KEY_ACTIONS[e.code];
    if (action) this.held.delete(action);
  };
}

import type { Point } from './homography';

/** 정확도 측정 지점(화면 비율). 센서바가 리모컨 시야를 벗어나지 않도록 가장자리 20% 안쪽까지만 둔다. */
export const ACCURACY_TARGETS: readonly Point[] = [0.2, 0.5, 0.8].flatMap((y) => [0.2, 0.5, 0.8].map((x) => ({ x, y })));
export const SHOTS_PER_TARGET = 3;
/** 초기 합격 기준(구현 계획 11절): 오차 90백분위가 화면 짧은 변의 3% 이하 */
export const ACCURACY_LIMIT = 0.03;

export interface AccuracyShot {
  target: number;
  aim: Point | null;
  /** 목표 중심과의 거리 ÷ 화면 짧은 변. 조준 신호가 없으면 null */
  error: number | null;
}

export interface AccuracySummary {
  shots: number;
  noSignal: number;
  /** 지점마다 신호가 있는 발사가 한 번이라도 있었는지 */
  reached: boolean[];
  p50: number | null;
  p90: number | null;
  max: number | null;
  perTarget: { p90: number | null; noSignal: number }[];
  pass: boolean;
}

/** 9지점 × 3발 정지 조준 시험. 발사 순간의 게임 화면 좌표와 목표 중심의 차이를 모은다. */
export class AccuracyTest {
  readonly shots: AccuracyShot[] = [];
  index = 0;

  constructor(
    readonly screen: { width: number; height: number },
    readonly crosshair: boolean,
    /** 표적 하나에 쏠 발수 */
    readonly shotsPerTarget = SHOTS_PER_TARGET,
  ) {}

  get done(): boolean {
    return this.index >= ACCURACY_TARGETS.length;
  }

  get target(): Point {
    return ACCURACY_TARGETS[Math.min(this.index, ACCURACY_TARGETS.length - 1)];
  }

  get shotsAtTarget(): number {
    return this.shots.filter((s) => s.target === this.index).length;
  }

  shoot(aim: Point | null): AccuracyShot | null {
    if (this.done) return null;
    const t = ACCURACY_TARGETS[this.index];
    const { width, height } = this.screen;
    const error = aim ? Math.hypot((aim.x - t.x) * width, (aim.y - t.y) * height) / Math.min(width, height) : null;
    const shot = { target: this.index, aim: aim && { ...aim }, error };
    this.shots.push(shot);
    if (this.shotsAtTarget >= this.shotsPerTarget) this.index++;
    return shot;
  }

  summary(): AccuracySummary {
    const errors = this.shots.flatMap((s) => (s.error === null ? [] : [s.error]));
    const perTarget = ACCURACY_TARGETS.map((_, i) => {
      const at = this.shots.filter((s) => s.target === i);
      return { p90: percentile(at.flatMap((s) => (s.error === null ? [] : [s.error])), 0.9), noSignal: at.filter((s) => s.error === null).length };
    });
    const reached = ACCURACY_TARGETS.map((_, i) => this.shots.some((s) => s.target === i && s.error !== null));
    const p90 = percentile(errors, 0.9);
    return {
      shots: this.shots.length,
      noSignal: this.shots.length - errors.length,
      reached,
      p50: percentile(errors, 0.5),
      p90,
      max: errors.length ? Math.max(...errors) : null,
      perTarget,
      pass: this.done && reached.every(Boolean) && p90 !== null && p90 <= ACCURACY_LIMIT,
    };
  }
}

/** 방아쇠 반복 시험: 당김 1회당 1발인지, 길게 눌러도 1발인지 확인한다. */
export class TriggerTest {
  static readonly GOAL = 10;
  /** 이 시간 이상 누르고 있으면 길게 누르기로 본다(ms) */
  static readonly LONG_PRESS = 1500;
  /** 이보다 짧은 간격으로 연달아 들어온 눌림은 접점 떨림(중복 입력)으로 의심한다(ms) */
  static readonly BOUNCE = 50;

  readonly presses: number[] = [];
  longPresses = 0;
  /** 길게 누르는 동안 추가로 들어온 눌림 수(0이어야 한다) */
  longPressExtra = 0;
  private holdStart: number | null = null;
  private countAtHold = 0;

  get count(): number {
    return this.presses.length;
  }

  get bounces(): number {
    let n = 0;
    for (let i = 1; i < this.presses.length; i++) if (this.presses[i] - this.presses[i - 1] < TriggerTest.BOUNCE) n++;
    return n;
  }

  /** @param pressed 이번 프레임에 새로 눌린 횟수 @param held 지금 누르고 있는지 */
  update(time: number, pressed: number, held: boolean): void {
    for (let i = 0; i < pressed; i++) this.presses.push(time);
    if (held && this.holdStart === null) {
      this.holdStart = time;
      this.countAtHold = this.presses.length;
    } else if (!held && this.holdStart !== null) {
      if (time - this.holdStart >= TriggerTest.LONG_PRESS) {
        this.longPresses++;
        this.longPressExtra += this.presses.length - this.countAtHold - pressed;
      }
      this.holdStart = null;
    }
  }
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)];
}

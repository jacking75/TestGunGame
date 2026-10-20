import { IR_HEIGHT, IR_WIDTH, type IrDot } from './protocol';

export type IrTracking = 'none' | 'single' | 'pair';

export interface IrPointerResult {
  /** 'none'이면 조준 좌표를 신뢰할 수 없다. */
  tracking: IrTracking;
  /** 카메라 기준 정규화 좌표(0~1). 리모컨을 오른쪽으로 돌리면 x가 커지도록 좌우를 뒤집었다. */
  x: number;
  y: number;
  /** 두 점 사이 각도(라디안). 리모컨을 비튼 정도. */
  roll: number;
  dotCount: number;
}

const CX = IR_WIDTH / 2;
const CY = IR_HEIGHT / 2;

/**
 * 센서바 두 점에서 조준 좌표를 만든다.
 * - 두 점: 중점을 쓰고, 두 점이 이루는 각도만큼 반대로 돌려 리모컨 비틀림을 보정한다.
 * - 한 점: 직전 두 점의 간격으로 사라진 점을 추정한다(화면 가장자리에서 한 점이 시야 밖으로 나가는 경우).
 * - 점이 3개 이상(반사광): 직전 간격과 가장 비슷한 쌍을 고른다.
 */
export class IrPointer {
  private lastLeft: IrDot | null = null;
  private lastRight: IrDot | null = null;
  private lastRoll = 0;

  reset(): void {
    this.lastLeft = null;
    this.lastRight = null;
    this.lastRoll = 0;
  }

  update(dots: readonly IrDot[]): IrPointerResult {
    if (dots.length >= 2) {
      const [a, b] = this.pickPair(dots);
      const left = a.x <= b.x ? a : b;
      const right = left === a ? b : a;
      this.lastLeft = left;
      this.lastRight = right;
      const roll = Math.atan2(right.y - left.y, right.x - left.x);
      this.lastRoll = roll;
      return this.result('pair', (left.x + right.x) / 2, (left.y + right.y) / 2, roll, dots.length);
    }

    if (dots.length === 1 && this.lastLeft && this.lastRight) {
      const d = dots[0];
      const hx = (this.lastRight.x - this.lastLeft.x) / 2;
      const hy = (this.lastRight.y - this.lastLeft.y) / 2;
      const distL = (d.x - this.lastLeft.x) ** 2 + (d.y - this.lastLeft.y) ** 2;
      const distR = (d.x - this.lastRight.x) ** 2 + (d.y - this.lastRight.y) ** 2;
      const isLeft = distL <= distR;
      const mx = isLeft ? d.x + hx : d.x - hx;
      const my = isLeft ? d.y + hy : d.y - hy;
      // 다음 프레임 추정을 위해 보이는 점 위치를 갱신한다.
      if (isLeft) {
        this.lastLeft = d;
        this.lastRight = { x: d.x + hx * 2, y: d.y + hy * 2, size: 0 };
      } else {
        this.lastRight = d;
        this.lastLeft = { x: d.x - hx * 2, y: d.y - hy * 2, size: 0 };
      }
      return this.result('single', mx, my, this.lastRoll, 1);
    }

    if (dots.length === 0) this.reset();
    return { tracking: 'none', x: 0.5, y: 0.5, roll: 0, dotCount: dots.length };
  }

  private pickPair(dots: readonly IrDot[]): [IrDot, IrDot] {
    if (dots.length === 2) return [dots[0], dots[1]];
    const prevGap =
      this.lastLeft && this.lastRight
        ? Math.hypot(this.lastRight.x - this.lastLeft.x, this.lastRight.y - this.lastLeft.y)
        : null;
    let best: [IrDot, IrDot] = [dots[0], dots[1]];
    let bestScore = Infinity;
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        const gap = Math.hypot(dots[j].x - dots[i].x, dots[j].y - dots[i].y);
        // 직전 간격이 없으면 큰 점(가까운 LED) 쌍을 우선한다.
        const score = prevGap !== null ? Math.abs(gap - prevGap) : -(dots[i].size + dots[j].size);
        if (score < bestScore) {
          bestScore = score;
          best = [dots[i], dots[j]];
        }
      }
    }
    return best;
  }

  private result(tracking: IrTracking, mx: number, my: number, roll: number, dotCount: number): IrPointerResult {
    // 비틀림 보정: 카메라 중심을 기준으로 -roll 회전
    const cos = Math.cos(-roll);
    const sin = Math.sin(-roll);
    const dx = mx - CX;
    const dy = my - CY;
    const rx = CX + dx * cos - dy * sin;
    const ry = CY + dx * sin + dy * cos;
    return { tracking, x: 1 - rx / IR_WIDTH, y: ry / IR_HEIGHT, roll, dotCount };
  }
}

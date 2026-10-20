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
  /** 카메라가 본 원래 점 개수(묶기 전) */
  dotCount: number;
}

const CX = IR_WIDTH / 2;
const CY = IR_HEIGHT / 2;
/** 같은 끝의 LED로 볼 최소 거리(px). 가까이서는 한쪽 끝의 LED 여러 개가 따로 보인다. */
const MIN_CLUSTER_GAP = 60;
/** 전체 점 퍼짐 대비 같은 끝으로 볼 비율 */
const CLUSTER_RATIO = 0.3;

/**
 * 가까운 점을 하나로 묶는다. 센서바 한쪽 끝은 LED 여러 개라 가까운 거리에서는 점 2~3개로 보인다.
 * 묶음 중심은 점 크기로 가중 평균한다.
 */
export function clusterDots(dots: readonly IrDot[]): IrDot[] {
  if (dots.length <= 1) return [...dots];
  let spread = 0;
  for (let i = 0; i < dots.length; i++)
    for (let j = i + 1; j < dots.length; j++)
      spread = Math.max(spread, Math.hypot(dots[j].x - dots[i].x, dots[j].y - dots[i].y));
  const limit = Math.max(MIN_CLUSTER_GAP, spread * CLUSTER_RATIO);

  // 단일 연결 묶기: 가까운 점끼리 같은 묶음
  const group = dots.map((_, i) => i);
  const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i])));
  for (let i = 0; i < dots.length; i++)
    for (let j = i + 1; j < dots.length; j++)
      if (Math.hypot(dots[j].x - dots[i].x, dots[j].y - dots[i].y) < limit) group[root(i)] = root(j);

  const sums = new Map<number, { x: number; y: number; w: number; size: number }>();
  dots.forEach((d, i) => {
    const r = root(i);
    const w = d.size + 1;
    const s = sums.get(r) ?? { x: 0, y: 0, w: 0, size: 0 };
    s.x += d.x * w;
    s.y += d.y * w;
    s.w += w;
    s.size = Math.max(s.size, d.size);
    sums.set(r, s);
  });
  return [...sums.values()].map((s) => ({ x: s.x / s.w, y: s.y / s.w, size: s.size }));
}

/**
 * 센서바 두 끝에서 조준 좌표를 만든다.
 * - 두 끝: 중점을 쓰고, 두 끝이 이루는 각도만큼 반대로 돌려 리모컨 비틀림을 보정한다.
 * - 한 끝: 기억해 둔 두 끝 간격으로 사라진 끝을 추정한다. 사라진 끝은 카메라 화면 밖으로 나간 쪽이다.
 * - 묶음이 3개 이상(반사광): 기억한 간격과 가장 비슷한 쌍을 고른다.
 */
export class IrPointer {
  /** 왼쪽 끝 → 오른쪽 끝 벡터(카메라 좌표). 신호가 잠깐 끊겨도 유지한다. */
  private gap: { x: number; y: number } | null = null;
  private lastRoll = 0;

  reset(): void {
    this.gap = null;
    this.lastRoll = 0;
  }

  update(dots: readonly IrDot[]): IrPointerResult {
    const ends = clusterDots(dots);

    if (ends.length >= 2) {
      const [a, b] = this.pickPair(ends);
      const left = a.x <= b.x ? a : b;
      const right = left === a ? b : a;
      this.gap = { x: right.x - left.x, y: right.y - left.y };
      const roll = Math.atan2(this.gap.y, this.gap.x);
      this.lastRoll = roll;
      return this.result('pair', (left.x + right.x) / 2, (left.y + right.y) / 2, roll, dots.length);
    }

    if (ends.length === 1 && this.gap) {
      const d = ends[0];
      const h = { x: this.gap.x / 2, y: this.gap.y / 2 };
      // 보이는 끝이 왼쪽 끝이면 오른쪽 끝은 d + gap, 오른쪽 끝이면 왼쪽 끝은 d - gap.
      // 둘 중 카메라 화면 밖으로 더 멀리 나간 쪽이 사라진 끝이다.
      const outside = (x: number, y: number) =>
        Math.max(0, -x, x - IR_WIDTH) + Math.max(0, -y, y - IR_HEIGHT);
      const visibleIsLeft = outside(d.x + this.gap.x, d.y + this.gap.y) >= outside(d.x - this.gap.x, d.y - this.gap.y);
      const mx = visibleIsLeft ? d.x + h.x : d.x - h.x;
      const my = visibleIsLeft ? d.y + h.y : d.y - h.y;
      return this.result('single', mx, my, this.lastRoll, dots.length);
    }

    return { tracking: 'none', x: 0.5, y: 0.5, roll: 0, dotCount: dots.length };
  }

  private pickPair(ends: readonly IrDot[]): [IrDot, IrDot] {
    if (ends.length === 2) return [ends[0], ends[1]];
    const prevGap = this.gap ? Math.hypot(this.gap.x, this.gap.y) : null;
    let best: [IrDot, IrDot] = [ends[0], ends[1]];
    let bestScore = Infinity;
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const gap = Math.hypot(ends[j].x - ends[i].x, ends[j].y - ends[i].y);
        // 기억한 간격이 없으면 가장 멀리 떨어진 쌍(센서바 양 끝)을 고른다.
        const score = prevGap !== null ? Math.abs(gap - prevGap) : -gap;
        if (score < bestScore) {
          bestScore = score;
          best = [ends[i], ends[j]];
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

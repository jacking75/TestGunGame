import { applyHomography, computeHomography, isConvexQuad, type Homography, type Point } from './homography';

/** 목표점을 화면 가장자리에서 들인 비율. 너무 바깥이면 센서바가 리모컨 카메라 시야를 벗어나기 쉽다. */
const INSET = 0.18;

/** 좌상 → 우상 → 우하 → 좌하 순서로 변환을 구하고, 중앙은 오차 검사에만 쓴다. */
export const CALIBRATION_TARGETS: readonly Point[] = [
  { x: INSET, y: INSET },
  { x: 1 - INSET, y: INSET },
  { x: 1 - INSET, y: 1 - INSET },
  { x: INSET, y: 1 - INSET },
  { x: 0.5, y: 0.5 },
];

export const CALIBRATION_LIMITS = {
  /** 방아쇠를 당긴 뒤 표본을 모으는 시간(초) */
  collectSeconds: 0.45,
  minSamples: 8,
  /** 표본 흔들림 허용치(원본 좌표 단위) */
  maxSpread: 0.03,
  /** 모서리 표본끼리 최소 간격(원본 좌표 단위). 이보다 가까우면 커서가 화면 끝에서 잘린 것이다. */
  minCornerGap: 0.05,
  /** 중앙 확인점 허용 오차(화면 짧은 변 대비) */
  maxCenterError: 0.05,
};

export type CalibrationPhase = 'aim' | 'collect' | 'done' | 'failed';

export interface CalibrationOutcome {
  matrix: Homography;
  centerError: number;
}

/**
 * 보정 절차의 순수 로직. 화면 표시와 입력 장치를 모른다.
 * update()에 매 프레임 원본 조준 좌표와 방아쇠 눌림을 넣는다.
 */
export class CalibrationSession {
  phase: CalibrationPhase = 'aim';
  index = 0;
  message = '';
  outcome: CalibrationOutcome | null = null;
  readonly measured: Point[] = [];
  private samples: Point[] = [];
  private collectTime = 0;

  constructor(private readonly aspect: { width: number; height: number }) {}

  get target(): Point {
    return CALIBRATION_TARGETS[Math.min(this.index, CALIBRATION_TARGETS.length - 1)];
  }

  get progress(): number {
    return this.phase === 'collect' ? Math.min(1, this.collectTime / CALIBRATION_LIMITS.collectSeconds) : 0;
  }

  update(dt: number, raw: Point | null, triggerPressed: boolean): void {
    if (this.phase === 'aim') {
      if (!triggerPressed) return;
      if (!raw) {
        this.message = '조준 신호가 없습니다. 센서바를 향해 다시 겨냥하세요.';
        return;
      }
      this.phase = 'collect';
      this.samples = [];
      this.collectTime = 0;
      this.message = '';
    }
    if (this.phase !== 'collect') return;

    this.collectTime += dt;
    if (raw) this.samples.push({ ...raw });
    if (this.collectTime < CALIBRATION_LIMITS.collectSeconds) return;

    const point = this.finishPoint();
    if (!point) {
      this.phase = 'aim';
      return;
    }
    this.measured[this.index] = point;
    this.index++;
    this.phase = 'aim';
    if (this.index === 4) this.checkCorners();
    else if (this.index === 5) this.finish();
  }

  /** 현재 지점만 다시 측정한다. */
  retryPoint(): void {
    this.phase = 'aim';
    this.samples = [];
  }

  restart(): void {
    this.phase = 'aim';
    this.index = 0;
    this.measured.length = 0;
    this.outcome = null;
    this.message = '';
  }

  private finishPoint(): Point | null {
    if (this.samples.length < CALIBRATION_LIMITS.minSamples) {
      this.message = '조준 신호가 자주 끊깁니다. 센서바를 향한 채 방아쇠를 당겨 잠시 유지하세요.';
      return null;
    }
    const { mean, spread } = robustMean(this.samples);
    if (spread > CALIBRATION_LIMITS.maxSpread) {
      this.message = '조준이 흔들렸습니다. 같은 자세로 고정한 채 다시 쏘세요.';
      return null;
    }
    return mean;
  }

  private checkCorners(): void {
    const c = this.measured.slice(0, 4);
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        if (Math.hypot(c[i].x - c[j].x, c[i].y - c[j].y) < CALIBRATION_LIMITS.minCornerGap) {
          this.fail('두 모서리의 입력이 거의 같습니다. 화면 끝까지 조준이 닿지 않습니다. 거리·센서바 위치를 바꿔 다시 시도하세요.');
          return;
        }
      }
    }
    if (!isConvexQuad(c)) {
      this.fail('모서리 순서가 맞지 않습니다. 표시된 점을 순서대로 겨냥해 다시 시도하세요.');
    }
  }

  private finish(): void {
    const h = computeHomography(this.measured.slice(0, 4), CALIBRATION_TARGETS.slice(0, 4));
    if (!h) {
      this.fail('보정 값을 계산할 수 없습니다. 다시 시도하세요.');
      return;
    }
    const center = applyHomography(h, this.measured[4].x, this.measured[4].y);
    const t = CALIBRATION_TARGETS[4];
    const short = Math.min(this.aspect.width, this.aspect.height);
    const err = Math.hypot((center.x - t.x) * this.aspect.width, (center.y - t.y) * this.aspect.height) / short;
    if (err > CALIBRATION_LIMITS.maxCenterError) {
      this.fail(`중앙 확인 오차가 큽니다(${(err * 100).toFixed(1)}%). 자세를 고정하고 다시 시도하세요.`);
      return;
    }
    this.outcome = { matrix: h, centerError: err };
    this.phase = 'done';
  }

  private fail(message: string): void {
    this.message = message;
    this.phase = 'failed';
  }
}

/** 중앙값에서 먼 30%를 버린 평균과 남은 표본의 흔들림(표준편차) */
export function robustMean(samples: readonly Point[]): { mean: Point; spread: number } {
  const med = { x: median(samples.map((s) => s.x)), y: median(samples.map((s) => s.y)) };
  const sorted = [...samples].sort(
    (a, b) => Math.hypot(a.x - med.x, a.y - med.y) - Math.hypot(b.x - med.x, b.y - med.y),
  );
  const kept = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.7)));
  const mean = {
    x: kept.reduce((s, p) => s + p.x, 0) / kept.length,
    y: kept.reduce((s, p) => s + p.y, 0) / kept.length,
  };
  const spread = Math.sqrt(kept.reduce((s, p) => s + (p.x - mean.x) ** 2 + (p.y - mean.y) ** 2, 0) / kept.length);
  return { mean, spread };
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 보정 도중 조준점 표시용 중간 매핑. 측정이 끝난 점으로 기본 매핑을 차례로 바로잡는다.
 * 0점: 기본 매핑 · 1점: 위치 이동 · 2점(위쪽 두 모서리): 가로 배율 · 3점 이상: 아핀 변환(기울기·세로 배율 포함)
 */
export function provisionalAim(measured: readonly Point[], raw: Point, base: (p: Point) => Point): Point {
  const n = Math.min(measured.length, 4);
  const b = base(raw);
  if (n === 0) return b;
  const m = measured.slice(0, n).map(base);
  const t = CALIBRATION_TARGETS;
  if (n === 1) return { x: b.x + (t[0].x - m[0].x), y: b.y + (t[0].y - m[0].y) };
  if (n === 2) {
    const dx = m[1].x - m[0].x;
    const sx = Math.abs(dx) > 1e-6 ? (t[1].x - t[0].x) / dx : 1;
    return { x: t[0].x + (b.x - m[0].x) * sx, y: b.y + (t[0].y - m[0].y) };
  }
  // 세 점(m0,m1,m2 → t0,t1,t2)으로 아핀 변환: q = t0 + A·(p − m0)
  const [u1, u2] = [
    { x: m[1].x - m[0].x, y: m[1].y - m[0].y },
    { x: m[2].x - m[0].x, y: m[2].y - m[0].y },
  ];
  const [v1, v2] = [
    { x: t[1].x - t[0].x, y: t[1].y - t[0].y },
    { x: t[2].x - t[0].x, y: t[2].y - t[0].y },
  ];
  const det = u1.x * u2.y - u2.x * u1.y;
  if (Math.abs(det) < 1e-9) return b;
  // A = V · U⁻¹
  const inv = { a: u2.y / det, b: -u2.x / det, c: -u1.y / det, d: u1.x / det };
  const A = {
    a: v1.x * inv.a + v2.x * inv.c,
    b: v1.x * inv.b + v2.x * inv.d,
    c: v1.y * inv.a + v2.y * inv.c,
    d: v1.y * inv.b + v2.y * inv.d,
  };
  const p = { x: b.x - m[0].x, y: b.y - m[0].y };
  return { x: t[0].x + A.a * p.x + A.b * p.y, y: t[0].y + A.c * p.x + A.d * p.y };
}

import { describe, expect, it } from 'vitest';
import { CALIBRATION_TARGETS, CalibrationSession } from '../src/calibration/CalibrationSession';
import { applyHomography, computeHomography } from '../src/calibration/homography';

type P = { x: number; y: number };

/** 목표점마다 방아쇠를 당기고 충분히 표본을 넣는다. */
function runSession(toRaw: (t: P) => P) {
  const s = new CalibrationSession({ width: 1920, height: 1080 });
  for (let i = 0; i < 5 && s.phase !== 'failed'; i++) {
    const raw = toRaw(CALIBRATION_TARGETS[i]);
    s.update(1 / 60, raw, true);
    for (let k = 0; k < 40 && s.index === i && s.phase === 'collect'; k++) s.update(1 / 60, raw, false);
  }
  return s;
}

describe('조준 보정', () => {
  it('원근 변환은 네 모서리를 정확히 옮긴다', () => {
    const src = [{ x: 0.2, y: 0.1 }, { x: 0.9, y: 0.2 }, { x: 0.8, y: 0.9 }, { x: 0.1, y: 0.8 }];
    const dst = CALIBRATION_TARGETS.slice(0, 4);
    const h = computeHomography(src, dst)!;
    src.forEach((p, i) => {
      const q = applyHomography(h, p.x, p.y);
      expect(q.x).toBeCloseTo(dst[i].x, 9);
      expect(q.y).toBeCloseTo(dst[i].y, 9);
    });
  });

  it('상하가 뒤집히고 축소된 입력도 보정 후 화면 좌표와 일치한다', () => {
    const toRaw = (t: P) => ({ x: 0.3 + t.x * 0.4, y: 0.7 - t.y * 0.35 });
    const s = runSession(toRaw);
    expect(s.phase).toBe('done');
    const q = applyHomography(s.outcome!.matrix, toRaw({ x: 0.3, y: 0.6 }).x, toRaw({ x: 0.3, y: 0.6 }).y);
    expect(q.x).toBeCloseTo(0.3, 6);
    expect(q.y).toBeCloseTo(0.6, 6);
  });

  it('화면 끝에서 커서가 잘려 모서리 입력이 겹치면 실패한다', () => {
    // 오른쪽 두 모서리가 같은 좌표로 포화된 경우
    const s = runSession((t) => ({ x: Math.min(t.x, 0.5), y: t.y < 0.5 ? 0.1 : 0.9 }));
    expect(s.phase).toBe('failed');
  });

  it('중앙 확인점이 크게 어긋나면 실패한다', () => {
    const s = runSession((t) => (t.x === 0.5 && t.y === 0.5 ? { x: 0.65, y: 0.5 } : t));
    expect(s.phase).toBe('failed');
  });

  it('조준 신호가 없으면 표본을 받지 않고 같은 지점에 머문다', () => {
    const s = new CalibrationSession({ width: 1920, height: 1080 });
    s.update(1 / 60, null, true);
    expect(s.phase).toBe('aim');
    expect(s.index).toBe(0);
  });
});

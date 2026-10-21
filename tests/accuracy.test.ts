import { describe, expect, it } from 'vitest';
import { ACCURACY_TARGETS, AccuracyTest, SHOTS_PER_TARGET, TriggerTest } from '../src/calibration/AccuracyTest';

describe('정확도 측정', () => {
  it('오차는 화면 짧은 변 기준 비율이다(가로 1% 이동 = 1920/1080의 1.78%)', () => {
    const t = new AccuracyTest({ width: 1920, height: 1080 }, true);
    const shot = t.shoot({ x: ACCURACY_TARGETS[0].x + 0.01, y: ACCURACY_TARGETS[0].y })!;
    expect(shot.error).toBeCloseTo(19.2 / 1080, 6);
  });

  it('9지점 × 10발 후 끝나고, 신호 없음이 있는 지점은 도달로 치지 않는다', () => {
    const t = new AccuracyTest({ width: 1920, height: 1080 }, false);
    ACCURACY_TARGETS.forEach((p, i) => {
      for (let k = 0; k < SHOTS_PER_TARGET; k++) t.shoot(i === 8 ? null : { x: p.x + 0.005, y: p.y });
    });
    expect(t.done).toBe(true);
    expect(t.shoot({ x: 0.5, y: 0.5 })).toBeNull();
    const s = t.summary();
    expect(s.shots).toBe(90);
    expect(s.noSignal).toBe(10);
    expect(s.reached.filter(Boolean)).toHaveLength(8);
    expect(s.pass).toBe(false);
  });

  it('모든 지점에서 오차가 기준 이하이면 통과, 10% 넘는 큰 오차가 많으면 미달', () => {
    const good = new AccuracyTest({ width: 1920, height: 1080 }, true);
    const bad = new AccuracyTest({ width: 1920, height: 1080 }, true);
    for (const p of ACCURACY_TARGETS)
      for (let k = 0; k < SHOTS_PER_TARGET; k++) {
        good.shoot({ x: p.x + 0.004, y: p.y - 0.004 });
        bad.shoot({ x: p.x + (k < 2 ? 0.05 : 0), y: p.y });
      }
    expect(good.summary().pass).toBe(true);
    expect(bad.summary().p90).toBeGreaterThan(0.03);
    expect(bad.summary().pass).toBe(false);
  });
});

describe('방아쇠 시험', () => {
  it('길게 누르면 1회로 세고 누르는 동안 추가 발사가 없으면 0이다', () => {
    const t = new TriggerTest();
    t.update(0, 1, true);
    for (let ms = 16; ms < 2000; ms += 16) t.update(ms, 0, true);
    t.update(2000, 0, false);
    expect(t.count).toBe(1);
    expect(t.longPresses).toBe(1);
    expect(t.longPressExtra).toBe(0);
  });

  it('누르고 있는 동안 들어온 중복 눌림과 50ms 안 연속 입력을 찾아낸다', () => {
    const t = new TriggerTest();
    t.update(0, 1, true);
    t.update(20, 1, true); // 떨림
    t.update(1600, 0, true);
    t.update(1700, 0, false);
    expect(t.longPressExtra).toBe(1);
    expect(t.bounces).toBe(1);
  });
});

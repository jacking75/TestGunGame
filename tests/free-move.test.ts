import { describe, expect, it } from 'vitest';
import { FREE_MOVE, GAME } from '../src/game/config';
import { GameSession, type HitResolver } from '../src/game/GameSession';
import type { InputFrame } from '../src/input/types';
import { FREE_RANGE } from '../src/stage/freeRange';
import { STAGE1 } from '../src/stage/stage1';

const DT = 1 / 60;
const AIM = { x: 0.5, y: 0.5 };

function frame(over: Partial<InputFrame> = {}): InputFrame {
  return {
    source: 'wiimote',
    aim: AIM,
    rawAim: AIM,
    firePresses: [],
    fireHeld: false,
    coverHeld: false,
    pausePressed: false,
    move: { x: 0, y: 0 },
    ...over,
  };
}

function run(s: GameSession, seconds: number, f: () => InputFrame = () => frame(), resolve: HitResolver = () => ({ kind: 'none' })) {
  const events = [];
  for (let t = 0; t < seconds; t += DT) events.push(...s.step(DT, f(), resolve));
  return events;
}

const free = () => new GameSession(FREE_RANGE, 1, 'free');

describe('자유 이동 시험장(T13)', () => {
  it('첫 프레임에 표적 5개를 세우고, 표적은 공격하지 않으며 시간도 줄지 않는다', () => {
    const s = free();
    const events = run(s, 30);
    expect(s.enemies.size).toBe(5);
    expect(events.some((e) => e.type === 'enemyWarn' || e.type === 'enemyFire')).toBe(false);
    expect(s.hp).toBe(GAME.playerHp);
    expect(s.timeLeft).toBe(GAME.timeLimit);
    expect(s.finished).toBe(false);
  });

  it('4방향 이동: 위 = 전진(-z), 아래 = 후진, 좌우 = 옆걸음, 놓으면 멈춘다', () => {
    const s = free();
    run(s, 0.5, () => frame({ move: { x: 0, y: 1 } }));
    expect(s.offset.z).toBeCloseTo(-FREE_MOVE.speed * 0.5, 1);
    const z = s.offset.z;
    run(s, 0.5);
    expect(s.offset.z).toBe(z);
    run(s, 0.5, () => frame({ move: { x: 0, y: -1 } }));
    expect(s.offset.z).toBeCloseTo(0, 1);
    run(s, 0.5, () => frame({ move: { x: 1, y: 0 } }));
    expect(s.offset.x).toBeCloseTo(FREE_MOVE.speed * 0.5, 1);
    run(s, 0.5, () => frame({ move: { x: -1, y: 0 } }));
    expect(s.offset.x).toBeCloseTo(0, 1);
  });

  it('대각선은 빨라지지 않는다', () => {
    const s = free();
    run(s, 0.5, () => frame({ move: { x: 1, y: 1 } }));
    expect(Math.hypot(s.offset.x, s.offset.z)).toBeCloseTo(FREE_MOVE.speed * 0.5, 1);
  });

  it('구역 끝과 상자에서 멈춘다', () => {
    const s = free();
    run(s, 10, () => frame({ move: { x: 1, y: 0 } }));
    expect(s.offset.x).toBeLessThanOrEqual(FREE_MOVE.halfX);
    expect(s.offset.x).toBeGreaterThan(FREE_MOVE.halfX - 0.1);
    // 왼쪽 앞 상자(x -2.2, z -1.6, 1×1): 시작점에서 x -2.2로 옆걸음한 뒤 전진하면 상자 앞에서 멈춘다.
    const t = free();
    run(t, 1.1, () => frame({ move: { x: -1, y: 0 } }));
    expect(t.offset.x).toBeCloseTo(-2.2, 1);
    run(t, 3, () => frame({ move: { x: 0, y: 1 } }));
    expect(t.offset.z).toBeCloseTo(-1.6 + 0.5 + FREE_MOVE.radius, 1);
  });

  it('엄폐 중에는 움직이지 않고 0.8초 뒤 6발로 장전된다', () => {
    const s = free();
    run(s, 0.1);
    s.weapon.tryFire(true);
    run(s, GAME.reloadHold + 0.1, () => frame({ coverHeld: true, move: { x: 0, y: 1 } }));
    expect(s.offset.z).toBe(0);
    expect(s.weapon.ammo).toBe(GAME.magazine);
  });

  it('이동하면서 쏴도 명중하고, 모두 쓰러뜨리면 다시 선다', () => {
    const s = free();
    run(s, 1);
    const ids = () => [...s.enemies.values()].filter((e) => e.alive).map((e) => e.id);
    let events: ReturnType<typeof run> = [];
    for (let i = 0; i < 6 && ids().length; i++) {
      const id = ids()[0];
      if (s.weapon.ammo === 0) run(s, GAME.reloadHold + 0.1, () => frame({ coverHeld: true }));
      events = events.concat(
        run(s, DT, () => frame({ move: { x: 1, y: 0 }, firePresses: [{ source: 'wiimote', aim: AIM }] }), () => ({ kind: 'enemy', enemyId: id, part: 'head', point: [0, 0, 0] })),
      );
    }
    expect(events.filter((e) => e.type === 'hit').length).toBe(5);
    expect(s.offset.x).toBeGreaterThan(0);
    run(s, FREE_MOVE.respawn + GAME.enemyDying + 0.2);
    expect(ids().length).toBe(5);
  });

  it('표적 초기화와 시작 위치 복귀', () => {
    const s = free();
    run(s, 1, () => frame({ move: { x: 1, y: 1 } }));
    s.returnToStart();
    expect(s.offset).toEqual({ x: 0, z: 0 });
    s.enemies.clear();
    s.resetTargets();
    run(s, DT);
    expect(s.enemies.size).toBe(5);
  });

  it('레일 모드는 이동 입력을 무시한다', () => {
    const s = new GameSession(STAGE1, 1);
    const before = s.view;
    run(s, 0.5, () => frame({ move: { x: 1, y: 1 } }));
    expect(s.offset).toEqual({ x: 0, z: 0 });
    expect(s.view).toEqual(before);
  });
});

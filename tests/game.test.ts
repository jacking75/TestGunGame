import { describe, expect, it } from 'vitest';
import { GAME } from '../src/game/config';
import { GameSession, type HitResolver, type HitResult } from '../src/game/GameSession';
import { InputHub } from '../src/input/InputHub';
import type { Action, InputFrame, InputSource } from '../src/input/types';
import { STAGE1 } from '../src/stage/stage1';
import type { StageDef } from '../src/stage/types';

const DT = 1 / 60;
const AIM = { x: 0.5, y: 0.5 };

function frame(over: Partial<InputFrame> = {}): InputFrame {
  return {
    source: 'mouse',
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
const fire = (n = 1) => frame({ firePresses: Array.from({ length: n }, () => ({ source: 'mouse' as const, aim: AIM })) });

/** 적 하나짜리 시험 스테이지 */
function oneEnemyStage(firstAttack = 5): StageDef {
  return {
    id: 't',
    name: 't',
    geometry: [],
    points: [{ id: 'A', name: 'A', eye: [0, 1.6, 0], look: [0, 1.6, -10], waves: [{ enemies: [{ x: 0, z: -10, firstAttack, cooldown: [3, 3] }] }] }],
    travels: [],
  };
}

function run(s: GameSession, seconds: number, f: () => InputFrame = () => frame(), resolve: HitResolver = () => ({ kind: 'none' })) {
  const events = [];
  for (let t = 0; t < seconds; t += DT) events.push(...s.step(DT, f(), resolve));
  return events;
}

/** 첫 웨이브가 나타날 때까지 진행한다 */
function untilEnemies(s: GameSession) {
  for (let i = 0; i < 600 && s.enemies.size === 0; i++) s.step(DT, frame(), () => ({ kind: 'none' }));
}

const hitFirst = (part: 'head' | 'body') => (s: GameSession): HitResolver => () => {
  const e = [...s.enemies.values()].find((x) => x.alive);
  return e ? ({ kind: 'enemy', enemyId: e.id, part, point: [0, 0, 0] } satisfies HitResult) : { kind: 'none' };
};

describe('무기·엄폐 규칙', () => {
  it('눌림 1회에 1발이며 누르고 있어도 추가 발사하지 않는다', () => {
    const s = new GameSession(oneEnemyStage());
    untilEnemies(s);
    s.step(DT, fire(), () => ({ kind: 'none' }));
    run(s, 0.5, () => frame({ fireHeld: true }));
    expect(s.weapon.ammo).toBe(GAME.magazine - 1);
    expect(s.stats.shots).toBe(1);
  });

  it('빈 탄창에서는 발사·명중이 생기지 않는다', () => {
    const s = new GameSession(oneEnemyStage(100));
    untilEnemies(s);
    for (let i = 0; i < GAME.magazine; i++) s.step(DT, fire(), () => ({ kind: 'none' }));
    const ev = s.step(DT, fire(), hitFirst('head')(s));
    expect(ev.some((e) => e.type === 'empty')).toBe(true);
    expect(s.stats.shots).toBe(GAME.magazine);
    expect(s.stats.hits).toBe(0);
  });

  it('엄폐 중에는 쏠 수 없고 0.8초 유지 시 한 번만 장전한다', () => {
    const s = new GameSession(oneEnemyStage(100));
    untilEnemies(s);
    s.step(DT, fire(3), () => ({ kind: 'none' }));
    const blocked = s.step(DT, frame({ coverHeld: true, firePresses: [{ source: 'mouse', aim: AIM }] }), () => ({ kind: 'none' }));
    expect(blocked.some((e) => e.type === 'blocked')).toBe(true);
    expect(s.weapon.ammo).toBe(3);
    const ev = run(s, 2, () => frame({ coverHeld: true }));
    expect(ev.filter((e) => e.type === 'reloaded')).toHaveLength(1);
    expect(s.weapon.ammo).toBe(GAME.magazine);
  });

  it('0.8초 전에 엄폐를 풀면 장전되지 않는다', () => {
    const s = new GameSession(oneEnemyStage(100));
    untilEnemies(s);
    s.step(DT, fire(2), () => ({ kind: 'none' }));
    run(s, 0.6, () => frame({ coverHeld: true }));
    run(s, 0.1);
    run(s, 0.6, () => frame({ coverHeld: true }));
    expect(s.weapon.ammo).toBe(GAME.magazine - 2);
  });
});

describe('적 공격과 피해', () => {
  it('공격 자세면 피해를 받고, 엄폐 중이면 막는다', () => {
    const exposed = new GameSession(oneEnemyStage(2));
    run(exposed, 5);
    expect(exposed.hp).toBe(GAME.playerHp - 1);

    const covered = new GameSession(oneEnemyStage(2));
    run(covered, 5, () => frame({ coverHeld: true }));
    expect(covered.hp).toBe(GAME.playerHp);
  });

  it('공격 직전 같은 프레임에 처치하면 그 공격은 취소된다', () => {
    const s = new GameSession(oneEnemyStage(2));
    untilEnemies(s);
    const enemy = [...s.enemies.values()][0];
    // 발사 직전까지 진행
    while (!(enemy.state === 'warning' && enemy.stateTime + DT >= GAME.enemyWarning)) s.step(DT, frame(), () => ({ kind: 'none' }));
    const ev = s.step(DT, fire(), hitFirst('head')(s));
    expect(ev.some((e) => e.type === 'enemyFire')).toBe(false);
    expect(s.hp).toBe(GAME.playerHp);
  });

  it('몸통은 2발, 머리는 1발로 처치한다', () => {
    const body = new GameSession(oneEnemyStage(100));
    untilEnemies(body);
    body.step(DT, fire(), hitFirst('body')(body));
    expect(body.stats.kills).toBe(0);
    body.step(DT, fire(), hitFirst('body')(body));
    expect(body.stats.kills).toBe(1);
    expect(body.stats.score).toBe(GAME.scoreBody * 2);

    const head = new GameSession(oneEnemyStage(100));
    untilEnemies(head);
    head.step(DT, fire(), hitFirst('head')(head));
    expect(head.stats.kills).toBe(1);
    expect(head.stats.headshots).toBe(1);
  });

  it('벽에 맞으면 적에게 명중하지 않는다', () => {
    const s = new GameSession(oneEnemyStage(100));
    untilEnemies(s);
    const ev = s.step(DT, fire(), () => ({ kind: 'world', point: [0, 1, -5], normal: [0, 0, 1] }));
    expect(ev.some((e) => e.type === 'worldHit')).toBe(true);
    expect(s.stats.hits).toBe(0);
  });
});

describe('1스테이지 진행', () => {
  it('A 3명·B 6명·C 6명이 정확히 한 번씩 등장하고 클리어는 한 번만 발생한다', () => {
    const s = new GameSession(STAGE1, 7);
    expect(s.totalEnemies).toBe(15);
    const spawned = new Set<number>();
    const perPoint = [0, 0, 0];
    let cleared = 0;
    let reloading = false;
    for (let i = 0; i < 60 * 600 && !s.finished; i++) {
      for (const e of s.enemies.values()) {
        if (!spawned.has(e.id)) {
          spawned.add(e.id);
          perPoint[s.pointIndex]++;
        }
      }
      // 탄이 떨어지면 장전될 때까지 엄폐하고, 그 외에는 보이는 적의 머리를 쏜다.
      if (s.weapon.ammo === 0) reloading = true;
      const alive = [...s.enemies.values()].some((e) => e.alive);
      const f = reloading ? frame({ coverHeld: true }) : alive ? fire() : frame();
      const ev = s.step(DT, f, hitFirst('head')(s));
      if (ev.some((e) => e.type === 'reloaded')) reloading = false;
      cleared += ev.filter((e) => e.type === 'cleared').length;
    }
    for (let i = 0; i < 120; i++) cleared += s.step(DT, fire(), hitFirst('head')(s)).filter((e) => e.type === 'cleared').length;
    expect(s.phase).toBe('cleared');
    expect(perPoint).toEqual([3, 6, 6]);
    expect(cleared).toBe(1);
  });

  it('이동 중에는 제한 시간이 줄지 않고 피해도 없다', () => {
    const s = new GameSession(STAGE1, 3);
    for (let i = 0; i < 60 * 120 && s.phase !== 'travel'; i++) {
      const alive = [...s.enemies.values()].some((e) => e.alive);
      s.step(DT, alive ? fire() : frame(), hitFirst('head')(s));
    }
    expect(s.phase).toBe('travel');
    const time = s.timeLeft;
    const hp = s.hp;
    const ev = run(s, 1, () => fire());
    expect(s.timeLeft).toBe(time);
    expect(s.hp).toBe(hp);
    expect(ev.every((e) => e.type === 'blocked' || e.type === 'travelStart')).toBe(true);
  });

  it('제한 시간이 0이 되면 실패한다', () => {
    const s = new GameSession(oneEnemyStage(1000));
    run(s, GAME.timeLimit + 2, () => frame({ coverHeld: true }));
    expect(s.phase).toBe('failed');
    expect(s.failReason).toBe('time');
  });
});

describe('입력 고착 방지', () => {
  class FakeSource implements InputSource {
    readonly id = 'mouse' as const;
    rawAim = AIM;
    lastActivity = 1;
    move = { x: 0, y: 0 };
    held = new Set<Action>();
    isHeld(a: Action) {
      return this.held.has(a);
    }
    takePresses() {
      return [];
    }
    reset() {}
  }

  it('reset 이전부터 누르고 있던 엄폐는 한 번 놓기 전까지 무시한다', () => {
    const src = new FakeSource();
    const hub = new InputHub([src], (_s, raw) => raw);
    src.held.add('cover');
    expect(hub.poll().coverHeld).toBe(true);
    hub.reset(); // 포커스 상실 후 복귀
    expect(hub.poll().coverHeld).toBe(false);
    src.held.delete('cover');
    hub.poll();
    src.held.add('cover');
    expect(hub.poll().coverHeld).toBe(true);
  });
});

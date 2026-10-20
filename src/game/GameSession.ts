import { Enemy, type HitPart } from '../actors/Enemy';
import type { Point } from '../calibration/homography';
import type { InputFrame } from '../input/types';
import type { StageDef, Vec3 } from '../stage/types';
import { GAME } from './config';
import { Cover } from './Cover';
import { createRandom } from './random';
import { Weapon } from './Weapon';

export type HitResult =
  | { kind: 'enemy'; enemyId: number; part: HitPart; point: Vec3 }
  | { kind: 'world'; point: Vec3; normal: Vec3 }
  | { kind: 'none' };

/** 화면 좌표(0~1)에서 광선을 쏴 가장 앞의 충돌체를 돌려준다. 렌더러가 구현한다. */
export type HitResolver = (aim: Point) => HitResult;

export type Phase = 'combat' | 'waveGap' | 'travel' | 'cleared' | 'failed';
export type FailReason = 'hp' | 'time';

export type GameEvent =
  | { type: 'shot'; aim: Point }
  | { type: 'empty' }
  | { type: 'blocked'; reason: 'cover' | 'travel' | 'noAim' }
  | { type: 'hit'; enemyId: number; part: HitPart; killed: boolean; point: Vec3; aim: Point }
  | { type: 'worldHit'; point: Vec3; normal: Vec3 }
  | { type: 'coverStart' }
  | { type: 'coverEnd' }
  | { type: 'reloaded' }
  | { type: 'enemyWarn'; enemyId: number }
  | { type: 'enemyFire'; enemyId: number; blocked: boolean }
  | { type: 'damaged'; hp: number }
  | { type: 'waveStart'; point: number; wave: number }
  | { type: 'travelStart'; to: number }
  | { type: 'arrived'; point: number }
  | { type: 'cleared' }
  | { type: 'failed'; reason: FailReason };

export interface GameStats {
  shots: number;
  hits: number;
  kills: number;
  headshots: number;
  damageTaken: number;
  playTime: number;
  score: number;
}

export interface CameraView {
  eye: Vec3;
  look: Vec3;
}

/**
 * 한 판의 규칙 진행. 렌더링·입력 장치와 분리되어 있다.
 * 한 프레임의 처리 순서는 고정: 시간 → 엄폐 → 플레이어 발사(명중·처치) → 적 공격 → 웨이브 진행 → 종료 판정.
 * 그래서 같은 프레임에 처치된 적의 공격은 항상 취소된다.
 */
export class GameSession {
  phase: Phase = 'waveGap';
  hp: number = GAME.playerHp;
  timeLeft: number = GAME.timeLimit;
  readonly weapon = new Weapon();
  readonly cover = new Cover();
  readonly stats: GameStats = { shots: 0, hits: 0, kills: 0, headshots: 0, damageTaken: 0, playTime: 0, score: 0 };
  readonly enemies = new Map<number, Enemy>();
  pointIndex = 0;
  waveIndex = 0;
  failReason: FailReason | null = null;

  private phaseTime = 0;
  private nextEnemyId = 1;
  private readonly random: () => number;

  constructor(
    readonly stage: StageDef,
    seed = 1,
  ) {
    this.random = createRandom(seed);
  }

  get finished(): boolean {
    return this.phase === 'cleared' || this.phase === 'failed';
  }

  get canFire(): boolean {
    return (this.phase === 'combat' || this.phase === 'waveGap') && !this.cover.active;
  }

  get totalEnemies(): number {
    return this.stage.points.reduce((n, p) => n + p.waves.reduce((m, w) => m + w.enemies.length, 0), 0);
  }

  get travelProgress(): number {
    return this.phase === 'travel' ? Math.min(1, this.phaseTime / this.stage.travels[this.pointIndex].duration) : 0;
  }

  /** 현재 카메라가 있어야 할 위치(엄폐 자세 낮춤은 렌더러의 연출이다) */
  get view(): CameraView {
    const p = this.stage.points[this.pointIndex];
    if (this.phase !== 'travel') return { eye: p.eye, look: p.look };
    const next = this.stage.points[this.pointIndex + 1];
    const t = smoothstep(this.travelProgress);
    const path = [p.eye, ...this.stage.travels[this.pointIndex].via, next.eye];
    return { eye: alongPath(path, t), look: lerp3(p.look, next.look, t) };
  }

  step(dt: number, input: InputFrame, resolveHit: HitResolver): GameEvent[] {
    const events: GameEvent[] = [];
    if (this.finished) return events;

    this.stats.playTime += dt;
    this.phaseTime += dt;
    const fighting = this.phase === 'combat' || this.phase === 'waveGap';
    if (fighting) this.timeLeft = Math.max(0, this.timeLeft - dt);

    // 1) 엄폐: 누른 순간부터 보호. 이동 중에는 엄폐하지 않는다.
    const cover = this.cover.update(input.coverHeld && fighting, dt);
    if (cover.started) events.push({ type: 'coverStart' });
    if (cover.ended) events.push({ type: 'coverEnd' });
    if (cover.reloaded) {
      this.weapon.refill();
      events.push({ type: 'reloaded' });
    }

    // 2) 플레이어 발사
    for (const press of input.firePresses) this.fire(press.aim, resolveHit, events);

    // 3) 적 진행과 공격. 이동 중에는 적이 공격하지 않는다.
    for (const enemy of this.enemies.values()) {
      const r = enemy.step(dt, fighting);
      if (r.warned) events.push({ type: 'enemyWarn', enemyId: enemy.id });
      if (r.fired) {
        const blocked = this.cover.active;
        events.push({ type: 'enemyFire', enemyId: enemy.id, blocked });
        if (!blocked) {
          this.hp = Math.max(0, this.hp - 1);
          this.stats.damageTaken++;
          events.push({ type: 'damaged', hp: this.hp });
        }
      }
      if (enemy.state === 'dead') this.enemies.delete(enemy.id);
    }

    // 4) 웨이브·이동
    this.advance(events);

    // 5) 종료 판정: 클리어가 먼저 확정되면 실패로 바꾸지 않는다.
    if (!this.finished) {
      if (this.hp <= 0) this.fail('hp', events);
      else if (this.timeLeft <= 0) this.fail('time', events);
    }
    return events;
  }

  private fire(aim: Point | null, resolveHit: HitResolver, events: GameEvent[]): void {
    if (this.phase === 'travel') {
      events.push({ type: 'blocked', reason: 'travel' });
      return;
    }
    if (this.cover.active) {
      events.push({ type: 'blocked', reason: 'cover' });
      return;
    }
    if (!aim) {
      events.push({ type: 'blocked', reason: 'noAim' });
      return;
    }
    const r = this.weapon.tryFire(true);
    if (r === 'empty') {
      events.push({ type: 'empty' });
      return;
    }
    this.stats.shots++;
    events.push({ type: 'shot', aim });

    const hit = resolveHit(aim);
    if (hit.kind === 'enemy') {
      const enemy = this.enemies.get(hit.enemyId);
      if (!enemy || !enemy.alive) return;
      const killed = enemy.hit(hit.part);
      this.stats.hits++;
      this.stats.score += hit.part === 'head' ? GAME.scoreHead : GAME.scoreBody;
      if (hit.part === 'head') this.stats.headshots++;
      if (killed) this.stats.kills++;
      events.push({ type: 'hit', enemyId: enemy.id, part: hit.part, killed, point: hit.point, aim });
    } else if (hit.kind === 'world') {
      events.push({ type: 'worldHit', point: hit.point, normal: hit.normal });
    }
  }

  private advance(events: GameEvent[]): void {
    const point = this.stage.points[this.pointIndex];
    switch (this.phase) {
      case 'waveGap':
        if (this.phaseTime >= GAME.waveGap) {
          this.spawnWave();
          this.setPhase('combat');
          events.push({ type: 'waveStart', point: this.pointIndex, wave: this.waveIndex });
        }
        break;
      case 'combat': {
        const remaining = [...this.enemies.values()].some((e) => e.alive);
        if (remaining) break;
        if (this.waveIndex + 1 < point.waves.length) {
          this.waveIndex++;
          this.setPhase('waveGap');
        } else if (this.pointIndex + 1 < this.stage.points.length) {
          this.cover.reset();
          this.setPhase('travel');
          events.push({ type: 'travelStart', to: this.pointIndex + 1 });
        } else {
          this.setPhase('cleared');
          events.push({ type: 'cleared' });
        }
        break;
      }
      case 'travel':
        if (this.phaseTime >= this.stage.travels[this.pointIndex].duration) {
          this.pointIndex++;
          this.waveIndex = 0;
          this.setPhase('waveGap');
          events.push({ type: 'arrived', point: this.pointIndex });
        }
        break;
      default:
        break;
    }
  }

  private spawnWave(): void {
    const wave = this.stage.points[this.pointIndex].waves[this.waveIndex];
    for (const def of wave.enemies) {
      const e = new Enemy(this.nextEnemyId++, def, this.random);
      this.enemies.set(e.id, e);
    }
  }

  private fail(reason: FailReason, events: GameEvent[]): void {
    this.failReason = reason;
    this.setPhase('failed');
    events.push({ type: 'failed', reason });
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.phaseTime = 0;
  }
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 꺾은선 경로에서 전체 길이 비율 t 위치 */
function alongPath(path: readonly Vec3[], t: number): Vec3 {
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const l = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]);
    lens.push(l);
    total += l;
  }
  let d = t * total;
  for (let i = 0; i < lens.length; i++) {
    if (d <= lens[i] || i === lens.length - 1) return lerp3(path[i], path[i + 1], lens[i] === 0 ? 1 : Math.min(1, d / lens[i]));
    d -= lens[i];
  }
  return path[path.length - 1];
}

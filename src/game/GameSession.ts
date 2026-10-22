import { Enemy, type HitPart } from '../actors/Enemy';
import type { Point } from '../calibration/homography';
import type { InputFrame } from '../input/types';
import type { StageDef, Vec3 } from '../stage/types';
import { FREE_MOVE, GAME } from './config';
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
/** rail: A→B→C 자동 이동 스테이지. free: 십자 버튼으로 움직이는 자유 이동 시험장(T13) */
export type GameMode = 'rail' | 'free';

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
  /** 자유 이동 시험장에서 시작 위치로부터 움직인 거리(x 오른쪽, z 뒤쪽) */
  offset = { x: 0, z: 0 };
  /** 마지막 프레임에 실제로 적용한 이동 입력(화면 표시용) */
  lastMove: Point = { x: 0, y: 0 };

  private phaseTime = 0;
  private nextEnemyId = 1;
  private readonly random: () => number;

  constructor(
    readonly stage: StageDef,
    seed = 1,
    readonly mode: GameMode = 'rail',
  ) {
    this.random = createRandom(seed);
    // 시험장은 기다리지 않고 첫 프레임에 표적을 세운다.
    if (mode === 'free') this.phaseTime = FREE_MOVE.respawn;
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
    if (this.mode === 'free') {
      // 옆걸음·앞뒤 이동만 하고 시선 방향은 처음 전방 그대로 둔다.
      const { x, z } = this.offset;
      return { eye: [p.eye[0] + x, p.eye[1], p.eye[2] + z], look: [p.look[0] + x, p.look[1], p.look[2] + z] };
    }
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
    if (fighting && this.mode === 'rail') this.timeLeft = Math.max(0, this.timeLeft - dt);

    // 1) 엄폐: 누른 순간부터 보호. 이동 중에는 엄폐하지 않는다.
    const cover = this.cover.update(input.coverHeld && fighting, dt);
    if (cover.started) events.push({ type: 'coverStart' });
    if (cover.ended) events.push({ type: 'coverEnd' });
    if (cover.reloaded) {
      this.weapon.refill();
      events.push({ type: 'reloaded' });
    }

    // 1-1) 자유 이동: 엄폐 중에는 움직이지 않는다.
    this.lastMove = this.mode === 'free' && fighting && !this.cover.active ? input.move : { x: 0, y: 0 };
    if (this.mode === 'free') this.walk(this.lastMove, dt);

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
    if (this.mode === 'free') this.advanceFree(events);
    else this.advance(events);

    // 5) 종료 판정: 클리어가 먼저 확정되면 실패로 바꾸지 않는다. 자유 이동 시험장은 끝나지 않는다.
    if (!this.finished && this.mode === 'rail') {
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

  /** 자유 이동: 표적을 모두 쓰러뜨리면 잠시 뒤 다시 세운다. 적은 공격하지 않는 표적이다. */
  private advanceFree(events: GameEvent[]): void {
    if (this.phase === 'waveGap') {
      if (this.phaseTime < FREE_MOVE.respawn) return;
      this.enemies.clear();
      this.spawnWave();
      this.setPhase('combat');
      events.push({ type: 'waveStart', point: 0, wave: 0 });
    } else if (this.phase === 'combat' && ![...this.enemies.values()].some((e) => e.alive)) {
      this.setPhase('waveGap');
    }
  }

  /** 자유 이동: 표적을 바로 다시 세운다. */
  resetTargets(): void {
    if (this.mode !== 'free') return;
    this.enemies.clear();
    this.setPhase('waveGap');
    this.phaseTime = FREE_MOVE.respawn;
  }

  /** 자유 이동: 시작 위치로 돌아간다. */
  returnToStart(): void {
    this.offset = { x: 0, z: 0 };
  }

  /** 십자 버튼(위 = 전진, 좌우 = 옆걸음)으로 평면 이동. 대각선은 빨라지지 않고, 벽·상자·구역 끝에서 멈춘다. */
  private walk(move: Point, dt: number): void {
    const len = Math.hypot(move.x, move.y);
    if (len === 0) return;
    const step = (FREE_MOVE.speed * dt) / len;
    const dx = move.x * step;
    const dz = -move.y * step;
    // 축마다 따로 막아서 벽에 비스듬히 닿아도 벽을 따라 미끄러지게 한다.
    const nx = clamp(this.offset.x + dx, -FREE_MOVE.halfX, FREE_MOVE.halfX);
    if (!this.blocked(nx, this.offset.z)) this.offset.x = nx;
    const nz = clamp(this.offset.z + dz, -FREE_MOVE.halfZ, FREE_MOVE.halfZ);
    if (!this.blocked(this.offset.x, nz)) this.offset.z = nz;
  }

  private blocked(ox: number, oz: number): boolean {
    const eye = this.stage.points[0].eye;
    const x = eye[0] + ox;
    const z = eye[2] + oz;
    const r = FREE_MOVE.radius;
    return this.stage.geometry.some(
      (b) =>
        b.kind !== 'floor' &&
        Math.abs(x - b.center[0]) < b.size[0] / 2 + r &&
        Math.abs(z - b.center[2]) < b.size[2] / 2 + r,
    );
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
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

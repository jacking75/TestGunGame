import { GAME } from '../game/config';
import type { EnemyDef } from '../stage/types';

export type EnemyState = 'appearing' | 'idle' | 'warning' | 'cooldown' | 'dying' | 'dead';
export type HitPart = 'head' | 'body';

export interface EnemyStepResult {
  warned: boolean;
  fired: boolean;
}

/**
 * 훈련 로봇 한 대의 상태: 등장 → 준비 → 공격 예고 → 발사 → 대기 → 예고 …
 * 처치되면 예약된 공격은 즉시 취소된다.
 */
export class Enemy {
  state: EnemyState = 'appearing';
  stateTime = 0;
  x: number;
  readonly z: number;
  bodyHits = 0;
  /** 최근 피격 연출용(초) */
  flash = 0;
  private dir = 1;
  private untilWarning: number;

  constructor(
    readonly id: number,
    readonly def: EnemyDef,
    private readonly random: () => number,
  ) {
    this.x = def.x;
    this.z = def.z;
    this.untilWarning = Math.max(GAME.enemyMinFirstAttack, def.firstAttack);
  }

  get alive(): boolean {
    return this.state !== 'dying' && this.state !== 'dead';
  }

  /** 등장 연출 진행도(0~1) */
  get appearProgress(): number {
    return this.state === 'appearing' ? Math.min(1, this.stateTime / GAME.enemyAppear) : 1;
  }

  get warningProgress(): number {
    return this.state === 'warning' ? Math.min(1, this.stateTime / GAME.enemyWarning) : 0;
  }

  /** @param combat false면 공격 진행을 멈춘다(이동 중). 처치 연출은 계속 진행한다. */
  step(dt: number, combat = true): EnemyStepResult {
    const out: EnemyStepResult = { warned: false, fired: false };
    this.flash = Math.max(0, this.flash - dt);
    if (!combat && this.alive) return out;
    this.stateTime += dt;

    if (this.alive && this.state !== 'appearing' && this.def.patrol) this.patrol(dt);

    switch (this.state) {
      case 'appearing':
        if (this.stateTime >= GAME.enemyAppear) this.enter('idle');
        break;
      case 'idle':
      case 'cooldown':
        this.untilWarning -= dt;
        if (this.untilWarning <= 0) {
          this.enter('warning');
          out.warned = true;
        }
        break;
      case 'warning':
        if (this.stateTime >= GAME.enemyWarning) {
          out.fired = true;
          const [lo, hi] = this.def.cooldown;
          this.untilWarning = lo + (hi - lo) * this.random();
          this.enter('cooldown');
        }
        break;
      case 'dying':
        if (this.stateTime >= GAME.enemyDying) this.enter('dead');
        break;
      case 'dead':
        break;
    }
    return out;
  }

  /** @returns 이 명중으로 처치되었는지 */
  hit(part: HitPart): boolean {
    if (!this.alive) return false;
    this.flash = 0.12;
    if (part === 'body') this.bodyHits++;
    if (part === 'head' || this.bodyHits >= GAME.enemyBodyHits) {
      this.enter('dying');
      return true;
    }
    return false;
  }

  private enter(state: EnemyState): void {
    this.state = state;
    this.stateTime = 0;
  }

  private patrol(dt: number): void {
    const p = this.def.patrol!;
    const lo = Math.min(p.from, p.to);
    const hi = Math.max(p.from, p.to);
    this.x += this.dir * p.speed * dt;
    if (this.x > hi) {
      this.x = hi - (this.x - hi);
      this.dir = -1;
    } else if (this.x < lo) {
      this.x = lo + (lo - this.x);
      this.dir = 1;
    }
  }
}

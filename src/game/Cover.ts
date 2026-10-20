import { GAME } from './config';

/**
 * 엄폐 상태. 버튼을 누른 순간부터 보호되고, 계속 0.8초 유지하면 한 번 장전한다.
 * 0.8초 전에 놓으면 장전이 취소되고 남은 탄약을 유지한다.
 */
export class Cover {
  active = false;
  heldTime = 0;
  reloadedThisHold = false;

  /** @returns 이번 프레임에 장전이 끝났으면 true */
  update(held: boolean, dt: number): { started: boolean; ended: boolean; reloaded: boolean } {
    const started = held && !this.active;
    const ended = !held && this.active;
    this.active = held;
    if (!held) {
      this.heldTime = 0;
      this.reloadedThisHold = false;
      return { started, ended, reloaded: false };
    }
    this.heldTime += dt;
    if (!this.reloadedThisHold && this.heldTime >= GAME.reloadHold) {
      this.reloadedThisHold = true;
      return { started, ended, reloaded: true };
    }
    return { started, ended, reloaded: false };
  }

  get reloadProgress(): number {
    if (!this.active) return 0;
    return this.reloadedThisHold ? 1 : Math.min(1, this.heldTime / GAME.reloadHold);
  }

  reset(): void {
    this.active = false;
    this.heldTime = 0;
    this.reloadedThisHold = false;
  }
}

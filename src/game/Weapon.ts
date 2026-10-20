import { GAME } from './config';

export type FireResult = 'fired' | 'empty' | 'blocked';

/** 반자동 권총: 눌림 1회당 1발, 탄창 6발, 예비 탄약 무제한 */
export class Weapon {
  ammo: number = GAME.magazine;
  readonly capacity: number = GAME.magazine;

  tryFire(allowed: boolean): FireResult {
    if (!allowed) return 'blocked';
    if (this.ammo <= 0) return 'empty';
    this.ammo--;
    return 'fired';
  }

  refill(): void {
    this.ammo = this.capacity;
  }
}

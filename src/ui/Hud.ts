import { GAME } from '../game/config';
import type { GameSession } from '../game/GameSession';
import { formatTime, h } from './dom';

/** 전투 화면 정보: 상단 체력·시간·점수, 하단 탄약·자세·남은 적, 중앙 안내 */
export class Hud {
  readonly el: HTMLDivElement;
  private hp: HTMLElement[] = [];
  private ammo: HTMLElement[] = [];
  private readonly ammoText = h('span');
  private readonly time = h('div', { class: 'time' });
  private readonly score = h('div', { class: 'score' });
  private readonly stance = h('div', { class: 'stance' });
  private readonly stanceText = h('div');
  private readonly bar = h('b');
  private readonly enemies = h('div', { class: 'enemies' });
  private readonly toastEl = h('div', { class: 'toast' });
  private readonly notice = h('div', { class: 'notice' });
  private readonly vignette = h('div', { class: 'vignette' });
  private toastTimer = 0;
  private vignetteTimer = 0;

  constructor() {
    const hpBox = h('div', { class: 'hp' });
    for (let i = 0; i < GAME.playerHp; i++) {
      const pip = h('i');
      this.hp.push(pip);
      hpBox.append(pip);
    }
    const ammoBox = h('div', { class: 'ammo' });
    for (let i = 0; i < GAME.magazine; i++) {
      const b = h('i');
      this.ammo.push(b);
      ammoBox.append(b);
    }
    ammoBox.append(this.ammoText);
    this.stance.append(this.stanceText, h('div', { class: 'bar' }, this.bar));

    this.el = h(
      'div',
      { id: 'hud', class: 'layer' },
      this.vignette,
      h('div', { class: 'top' }, hpBox, this.time, this.score),
      h('div', { class: 'bottom' }, ammoBox, this.stance, this.enemies),
      this.toastEl,
      this.notice,
    );
    this.el.style.pointerEvents = 'none';
    this.el.querySelectorAll<HTMLElement>('*').forEach((e) => (e.style.pointerEvents = 'none'));
    this.show(false);
  }

  show(visible: boolean): void {
    this.el.style.display = visible ? 'block' : 'none';
  }

  update(dt: number, s: GameSession, aimLost: boolean): void {
    this.hp.forEach((p, i) => p.classList.toggle('lost', i >= s.hp));
    this.ammo.forEach((b, i) => b.classList.toggle('spent', i >= s.weapon.ammo));
    this.ammoText.textContent = `${s.weapon.ammo}/${s.weapon.capacity}`;
    this.time.innerHTML = `${formatTime(s.timeLeft)}<small>남은 시간</small>`;
    this.time.classList.toggle('low', s.timeLeft <= 30);
    this.score.innerHTML = `${s.stats.score.toLocaleString('ko-KR')}<small>점수</small>`;

    const remaining = s.totalEnemies - s.stats.kills;
    const point = s.stage.points[s.pointIndex];
    this.enemies.innerHTML = `${point.name}<br>남은 적 ${remaining}/${s.totalEnemies}`;

    const covered = s.cover.active;
    this.stance.classList.toggle('cover', covered);
    if (s.phase === 'travel') {
      this.stanceText.textContent = '이동 중';
      this.bar.style.width = `${s.travelProgress * 100}%`;
    } else if (covered) {
      const done = s.cover.reloadProgress >= 1;
      this.stanceText.textContent = done ? '엄폐 중 · 장전 완료' : '엄폐 중 · 재장전 중';
      this.bar.style.width = `${s.cover.reloadProgress * 100}%`;
    } else {
      this.stanceText.textContent = '공격';
      this.bar.style.width = '0%';
    }

    this.notice.textContent = aimLost
      ? '조준 신호 없음 — 총을 화면(센서바) 쪽으로 향하세요'
      : s.weapon.ammo === 0 && !covered
        ? '탄창이 비었습니다 — 엄폐 버튼을 누르고 있으면 재장전'
        : '';

    this.toastTimer -= dt;
    if (this.toastTimer <= 0) this.toastEl.classList.remove('show');
    this.vignetteTimer -= dt;
    if (this.vignetteTimer <= 0) this.vignette.classList.remove('show');
  }

  toast(text: string, seconds = 1.4, warn = false): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.toggle('warn', warn);
    this.toastEl.classList.add('show');
    this.toastTimer = seconds;
  }

  damage(): void {
    this.vignette.classList.add('show');
    this.vignetteTimer = 0.18;
  }
}

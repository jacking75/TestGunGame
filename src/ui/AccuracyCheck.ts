import { ACCURACY_LIMIT, ACCURACY_TARGETS, AccuracyTest, SHOTS_PER_TARGET, TriggerTest, type AccuracySummary } from '../calibration/AccuracyTest';
import type { FirePress, InputFrame, InputSourceId } from '../input/types';
import type { WiimoteSource } from '../input/WiimoteSource';
import { h } from './dom';

type Phase = 'intro' | 'aim' | 'aimResult' | 'trigger' | 'triggerResult' | 'loss';

export interface AccuracyCheckDeps {
  wiimote: WiimoteSource;
  /** 측정에 쓰는 입력 장치 */
  source: InputSourceId;
  /** 보정 상태 한 줄 */
  calibration: string;
  screen: () => { width: number; height: number };
  log: (kind: string, data: Record<string, unknown>) => void;
  exit: () => void;
  sound: (name: 'shot' | 'reload' | 'ui') => void;
}

const pct = (v: number | null) => (v === null ? '-' : `${(v * 100).toFixed(2)}%`);

/**
 * 실물 정확도 측정(구현 계획 T11): ① 9지점 정지 조준 ② 방아쇠 30회·길게 누르기 ③ 센서바 가림·전원 끄기·재연결.
 * 결과는 화면에 보여 주고 기록 파일(hw-check.log)에도 남긴다.
 */
export class AccuracyCheck {
  readonly el = h('div', { id: 'accuracy' });
  phase: Phase = 'intro';
  private test: AccuracyTest | null = null;
  private trigger: TriggerTest | null = null;
  private results: { crosshair: boolean; summary: AccuracySummary }[] = [];
  private coverWasHeld = false;
  private readonly targetEl = h('div', { class: 'target' });
  private readonly status = h('div', { class: 'info' });
  private readonly events: string[] = [];
  private loss = { coveredSince: 0, lostAt: 0, connected: true, tracking: 'none' as string, startedAt: 0 };

  constructor(private readonly deps: AccuracyCheckDeps) {
    this.showIntro();
  }

  /** true면 방아쇠로 화면 버튼을 누른다(측정 중에는 false) */
  get menuMode(): boolean {
    return this.phase !== 'aim' && this.phase !== 'trigger';
  }

  get showCrosshair(): boolean {
    return this.phase === 'aim' ? this.test!.crosshair : this.phase === 'loss' || this.menuMode;
  }

  private get trig(): string {
    return this.deps.source === 'wiimote' ? '방아쇠' : '왼쪽 버튼';
  }

  private get coverName(): string {
    return this.deps.source === 'wiimote' ? `엄폐 버튼(${this.deps.wiimote.buttonMap.cover.toUpperCase()})` : 'Space';
  }

  /** @param presses 측정 장치의 발사 눌림(게임 화면 좌표) */
  update(frame: InputFrame, presses: FirePress[]): void {
    const now = performance.now();
    const coverPressed = frame.coverHeld && !this.coverWasHeld;
    this.coverWasHeld = frame.coverHeld;

    if (this.phase === 'aim') {
      const t = this.test!;
      for (const p of presses) {
        const shot = t.shoot(p.aim);
        this.deps.sound('shot');
        this.deps.log('accuracy-shot', { crosshair: t.crosshair, target: shot?.target, aim: shot?.aim, error: shot?.error });
        if (t.done) break;
      }
      if (t.done) this.finishAim();
      else this.renderAim();
    } else if (this.phase === 'trigger') {
      this.trigger!.update(now, presses.length, frame.fireHeld);
      if (coverPressed) this.finishTrigger();
      else this.renderTrigger();
    } else if (this.phase === 'loss') {
      this.updateLoss(now);
    }
  }

  // ───────── 화면 ─────────

  private screen(...children: (Node | string | null)[]): void {
    this.el.replaceChildren(h('div', { class: 'panel accuracy' }, ...children));
  }

  private buttons(...items: [string, () => void, boolean?][]): HTMLElement {
    return h(
      'div',
      { class: 'buttons' },
      ...items.map(([label, fn, primary]) => h('button', { class: primary ? 'primary' : '', onclick: fn, 'data-default': primary ?? false }, label)),
    );
  }

  private showIntro(): void {
    this.phase = 'intro';
    this.screen(
      h('h2', {}, '정확도 측정'),
      h('p', { class: 'sub' }, `입력 장치: ${this.deps.source === 'wiimote' ? 'Wii 총' : '마우스'} · 보정: ${this.deps.calibration}`),
      h(
        'ol',
        {},
        h('li', {}, `조준: 화면 9곳의 표적을 차례로 ${SHOTS_PER_TARGET}발씩 쏩니다. 평소 플레이 자리·자세에서 표적 중심을 겨냥하세요.`),
        h('li', {}, `방아쇠: ${TriggerTest.GOAL}번 당기고, 한 번은 2초 동안 당긴 채로 유지합니다.`),
        h('li', {}, '연결: 센서바 가림, 리모컨 건전지 빼기·다시 넣기를 시험합니다.'),
      ),
      h('p', { class: 'sub' }, '결과는 화면과 기록 파일(hw-check.log)에 남습니다.'),
      this.buttons(['조준점 보며 측정', () => this.startAim(true), true], ['가늠쇠만으로 측정', () => this.startAim(false)], ['방아쇠 시험', () => this.startTrigger()], ['연결 시험', () => this.startLoss()], ['메뉴로', () => this.deps.exit()]),
    );
  }

  private startAim(crosshair: boolean): void {
    this.phase = 'aim';
    this.test = new AccuracyTest(this.deps.screen(), crosshair);
    this.deps.log('accuracy-start', { crosshair, source: this.deps.source, screen: this.test.screen });
    this.el.replaceChildren(this.targetEl, this.status);
    this.renderAim();
  }

  private renderAim(): void {
    const t = this.test!;
    this.targetEl.style.left = `${t.target.x * 100}%`;
    this.targetEl.style.top = `${t.target.y * 100}%`;
    const last = t.shots[t.shots.length - 1];
    this.status.replaceChildren(
      h('b', {}, `표적 ${t.index + 1}/${ACCURACY_TARGETS.length} · ${t.shotsAtTarget}/${SHOTS_PER_TARGET}발`),
      h('div', {}, `${t.crosshair ? '조준점을 표적 중심에 맞추고' : '총의 가늠쇠로 표적 중심을 겨냥하고'} ${this.trig}을(를) 당기세요. 한 발마다 다시 겨냥합니다.`),
      h('div', { class: 'msg' }, last ? (last.error === null ? '조준 신호 없음 — 센서바가 보이게 하세요' : `직전 오차 ${pct(last.error)}`) : ''),
    );
  }

  private finishAim(): void {
    const t = this.test!;
    const s = t.summary();
    this.results.push({ crosshair: t.crosshair, summary: s });
    this.deps.log('accuracy-result', { crosshair: t.crosshair, source: this.deps.source, screen: t.screen, limit: ACCURACY_LIMIT, ...s });
    this.deps.sound('reload');
    this.phase = 'aimResult';
    const rows = ACCURACY_TARGETS.map((p, i) =>
      h('tr', {}, h('td', {}, `${i + 1} (${p.x}, ${p.y})`), h('td', {}, pct(s.perTarget[i].p90)), h('td', {}, String(s.perTarget[i].noSignal))),
    );
    this.screen(
      h('h2', { class: s.pass ? 'ok' : 'bad' }, `${t.crosshair ? '조준점 보며' : '가늠쇠만으로'} — ${s.pass ? '통과' : '기준 미달'}`),
      h('p', { class: 'sub' }, `오차 90백분위 ${pct(s.p90)} (기준 ${pct(ACCURACY_LIMIT)} 이하) · 중앙값 ${pct(s.p50)} · 최대 ${pct(s.max)} · 신호 없음 ${s.noSignal}발 · 도달 ${s.reached.filter(Boolean).length}/9`),
      h('table', { class: 'controls' }, h('tr', {}, h('th', {}, '표적'), h('th', {}, '오차 90%'), h('th', {}, '신호 없음')), ...rows),
      this.buttons(
        ['다음: 방아쇠 시험', () => this.startTrigger(), true],
        [t.crosshair ? '가늠쇠만으로 측정' : '조준점 보며 측정', () => this.startAim(!t.crosshair)],
        ['다시 측정', () => this.startAim(t.crosshair)],
        ['메뉴로', () => this.deps.exit()],
      ),
    );
  }

  private startTrigger(): void {
    this.phase = 'trigger';
    this.trigger = new TriggerTest();
    this.coverWasHeld = true; // 이미 누르고 있던 엄폐 버튼으로 바로 끝나지 않게 한다
    this.el.replaceChildren(this.status);
    this.renderTrigger();
  }

  private renderTrigger(): void {
    const t = this.trigger!;
    this.status.replaceChildren(
      h('b', {}, '방아쇠 시험'),
      h('div', { class: 'count' }, String(t.count)),
      h('div', {}, `${this.trig}을(를) 직접 세면서 정확히 ${TriggerTest.GOAL}번 당기세요. 그다음 한 번은 2초 이상 당긴 채로 있다가 놓으세요.`),
      h('div', {}, `끝나면 ${this.coverName}을(를) 누르세요.`),
      h('div', { class: 'msg' }, t.longPresses ? `길게 누르기 ${t.longPresses}회 확인 (추가 발사 ${t.longPressExtra})` : ''),
    );
  }

  private finishTrigger(): void {
    const t = this.trigger!;
    const expected = TriggerTest.GOAL + 1;
    const pass = t.count === expected && t.longPresses >= 1 && t.longPressExtra === 0 && t.bounces === 0;
    this.deps.log('trigger-result', { source: this.deps.source, count: t.count, expected, longPresses: t.longPresses, longPressExtra: t.longPressExtra, bounces: t.bounces, pass });
    this.phase = 'triggerResult';
    this.screen(
      h('h2', { class: pass ? 'ok' : 'bad' }, pass ? '방아쇠 시험 통과' : '방아쇠 시험 — 확인 필요'),
      h(
        'p',
        { class: 'sub' },
        `인식된 당김 ${t.count}회 (기대 ${expected}회 = ${TriggerTest.GOAL}회 + 길게 1회) · 길게 누르기 ${t.longPresses}회, 그동안 추가 발사 ${t.longPressExtra} · ${TriggerTest.BOUNCE}ms 안 연속 입력 ${t.bounces}회`,
      ),
      h('p', { class: 'sub' }, '직접 센 횟수와 다르면 세는 도중 놓친 것인지 다시 시험해 확인하세요.'),
      this.buttons(['다음: 연결 시험', () => this.startLoss(), true], ['다시', () => this.startTrigger()], ['메뉴로', () => this.deps.exit()]),
    );
  }

  // ───────── 연결 시험 ─────────

  private startLoss(): void {
    this.phase = 'loss';
    this.events.length = 0;
    const w = this.deps.wiimote;
    this.loss = { coveredSince: 0, lostAt: 0, connected: w.connected, tracking: w.ir.tracking, startedAt: performance.now() };
    this.addEvent(`시작 — 연결 ${w.connected ? '됨' : '안 됨'}, 센서바 ${trackingName(w.ir.tracking)}`);
    this.renderLoss();
  }

  private addEvent(text: string): void {
    const sec = ((performance.now() - this.loss.startedAt) / 1000).toFixed(1);
    this.events.push(`${sec}초 · ${text}`);
    this.deps.log('loss-event', { text, sec: Number(sec) });
  }

  private updateLoss(now: number): void {
    const w = this.deps.wiimote;
    const connected = w.connected;
    const tracking = connected ? w.ir.tracking : 'none';
    let changed = false;
    if (connected !== this.loss.connected) {
      if (!connected) {
        this.loss.lostAt = now;
        this.addEvent('리모컨 연결 끊김 감지');
      } else {
        this.addEvent(`리모컨 다시 연결됨 (끊김 후 ${((now - this.loss.lostAt) / 1000).toFixed(1)}초)`);
      }
      this.loss.connected = connected;
      changed = true;
    }
    if (connected && tracking !== this.loss.tracking) {
      if (tracking === 'none') this.loss.coveredSince = now;
      const after = this.loss.tracking === 'none' && this.loss.coveredSince ? ` (신호 없음 ${((now - this.loss.coveredSince) / 1000).toFixed(1)}초 후)` : '';
      this.addEvent(`센서바 ${trackingName(tracking)}${tracking === 'none' ? ' — 조준점 회색, 발사 막힘' : after}`);
      this.loss.tracking = tracking;
      changed = true;
    }
    if (changed || this.el.childElementCount === 0) this.renderLoss();
  }

  private renderLoss(): void {
    const covered = this.events.some((e) => e.includes('센서바 신호 없음'));
    const restored = covered && this.events.some((e) => e.includes('센서바 두 점') && e.includes('신호 없음'));
    const lost = this.events.some((e) => e.includes('끊김 감지'));
    const back = this.events.some((e) => e.includes('다시 연결됨'));
    const step = (done: boolean, text: string) => h('li', { class: done ? 'done' : '' }, `${done ? '✔ ' : ''}${text}`);
    this.screen(
      h('h2', {}, '연결 시험'),
      h(
        'ol',
        {},
        step(covered && restored, '손으로 센서바를 3초 가렸다가 치우세요. 조준점이 회색으로 바뀌고 발사가 막혀야 합니다.'),
        step(lost, '리모컨의 건전지를 빼세요(전원 버튼으로는 꺼지지 않음).'),
        step(back, '건전지를 다시 넣고 아무 버튼이나 누르세요. 자동으로 다시 연결되어야 합니다.'),
      ),
      h('div', { class: 'events' }, ...this.events.slice(-10).map((e) => h('div', {}, e))),
      this.buttons(['완료', () => this.finishLoss(), true], ['메뉴로', () => this.deps.exit()]),
    );
  }

  private finishLoss(): void {
    this.deps.log('loss-result', { events: [...this.events] });
    this.deps.exit();
  }
}

function trackingName(t: string): string {
  return t === 'pair' ? '두 점 감지' : t === 'single' ? '한 점만 감지' : '신호 없음';
}

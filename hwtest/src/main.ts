import './style.css';
import { ACCURACY_LIMIT, ACCURACY_TARGETS, AccuracyTest, SHOTS_PER_TARGET, TriggerTest, type AccuracySummary } from '../../src/calibration/AccuracyTest';
import { CALIBRATION_TARGETS, CalibrationSession, provisionalAim } from '../../src/calibration/CalibrationSession';
import { applyHomography, type Homography, type Point } from '../../src/calibration/homography';
import { host } from '../../src/platform/host';
import { h } from '../../src/ui/dom';
import { SimPad, WiiPad, type Pad } from './pad';

/**
 * Wii 총 실물 검증 앱. 게임과 별개로, 사람이 외울 것 없이 화면 지시를 하나씩 따라 하면 끝나도록 만든다.
 * 각 단계는 장치 상태를 감지해 스스로 넘어가고, 결과는 기록 파일과 결과 JSON에 남긴다.
 * 단계: 연결 → 센서바 → 보정 → 조준 → 방아쇠 → 엄폐 버튼 → 센서바 가림 → 창 전환 → 결과
 */

const SIM = new URLSearchParams(location.search).has('sim');
/** 보정 전 기본 매핑 배율(게임과 같은 근사값) */
const DEFAULT_GAIN = 2.2;
const OFFSCREEN_MARGIN = 0.03;
/** 통과 표시를 보여 준 뒤 다음 단계로 넘어가기까지(초) */
const ADVANCE_DELAY = 1.6;
/** 결과 숫자를 읽을 시간을 주는 단계(초) */
const RESULT_DELAY = 3.5;
const TRIGGER_HOLD_MS = TriggerTest.LONG_PRESS;
const COVER_HOLD = 0.8;
const BLOCK_HOLD = 1.0;

type StepId = 'connect' | 'sensor' | 'calibrate' | 'aim' | 'trigger' | 'cover' | 'block' | 'focus' | 'done';
const STEPS: { id: StepId; name: string }[] = [
  { id: 'connect', name: '연결' },
  { id: 'sensor', name: '센서바' },
  { id: 'calibrate', name: '보정' },
  { id: 'aim', name: '조준' },
  { id: 'trigger', name: '방아쇠' },
  { id: 'cover', name: '엄폐 버튼' },
  { id: 'block', name: '센서바 가림' },
  { id: 'focus', name: '창 전환' },
  { id: 'done', name: '결과' },
];

interface ItemResult {
  pass: boolean;
  text: string;
  data: Record<string, unknown>;
}

// ───────── 기록 ─────────

let logPath = '';
function log(kind: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), local: localTime(), kind, sim: SIM || undefined, ...data });
  if (host) void host.call('log.append', { line }).catch(() => undefined);
  else console.log(line);
}

function localTime(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ───────── 소리(짧은 삑) ─────────

let audio: AudioContext | null = null;
function beep(freq: number, ms = 70): void {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = freq;
    g.gain.value = 0.08;
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + ms / 1000);
  } catch {
    // 소리가 안 나도 검증은 계속한다.
  }
}

// ───────── 화면 ─────────

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(2)}%`);

const ui = {
  steps: h('ol', { class: 'steps' }),
  title: h('h1', {}),
  sub: h('p', { class: 'sub' }),
  meter: h('div', { class: 'meter' }),
  flash: h('div', { class: 'flash' }),
  target: h('div', { class: 'target' }),
  cross: h('div', { class: 'cross' }, h('div', { class: 'ring' }), h('div', { class: 'dot' })),
  result: h('div', { class: 'result' }),
  foot: h('div', { class: 'foot' }),
};
document.getElementById('app')!.append(
  h('header', {}, h('div', { class: 'brand' }, 'Wii 총 검증'), ui.steps),
  h('section', { class: 'say' }, ui.title, ui.sub, ui.meter),
  ui.target,
  ui.result,
  ui.flash,
  ui.cross,
  ui.foot,
);

function say(title: string, sub = '', meter = ''): void {
  if (ui.title.textContent !== title) ui.title.textContent = title;
  if (ui.sub.textContent !== sub) ui.sub.textContent = sub;
  if (ui.meter.textContent !== meter) ui.meter.textContent = meter;
}

function showTarget(p: Point | null, small = false): void {
  ui.target.style.display = p ? 'block' : 'none';
  ui.target.classList.toggle('small', small);
  if (p) {
    ui.target.style.left = `${p.x * 100}%`;
    ui.target.style.top = `${p.y * 100}%`;
  }
}

let lastCross: Point | null = null;
function showCross(p: Point | null, visible: boolean): void {
  ui.cross.style.display = visible && (p || lastCross) ? 'block' : 'none';
  ui.cross.classList.toggle('lost', !p);
  if (p) lastCross = p;
  const at = p ?? lastCross;
  if (at) ui.cross.style.transform = `translate(${at.x * window.innerWidth}px, ${at.y * window.innerHeight}px)`;
}

function flash(text: string, ok: boolean): void {
  ui.flash.textContent = text;
  ui.flash.className = `flash show ${ok ? 'ok' : 'bad'}`;
  beep(ok ? 880 : 220, ok ? 140 : 300);
}

// ───────── 진행기 ─────────

class Runner {
  private index = 0;
  private stepTime = 0;
  private passedAt: number | null = null;
  private advanceAfter = ADVANCE_DELAY;
  private homeWasHeld = false;
  private matrix: Homography | null = null;
  readonly results: Partial<Record<StepId, ItemResult>> = {};
  private s: Record<string, unknown> = {};
  private calib: CalibrationSession | null = null;
  private accuracy: AccuracyTest | null = null;
  private trigger: TriggerTest | null = null;
  private startedAt = localTime();
  private saved = '';

  constructor(private readonly pad: Pad) {
    window.addEventListener('blur', () => this.onFocus(false));
    window.addEventListener('focus', () => this.onFocus(true));
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyR' && !e.repeat) this.enter(this.index);
    });
    this.enter(0);
  }

  get step(): StepId {
    return STEPS[this.index].id;
  }

  private enter(i: number): void {
    this.index = i;
    this.stepTime = 0;
    this.passedAt = null;
    this.advanceAfter = ADVANCE_DELAY;
    this.s = {};
    this.calib = null;
    this.accuracy = null;
    this.trigger = null;
    ui.flash.className = 'flash';
    ui.result.replaceChildren();
    showTarget(null);
    this.pad.takeFires();
    ui.steps.replaceChildren(
      ...STEPS.map((st, k) =>
        h('li', { class: k < i ? (this.results[st.id]?.pass === false ? 'bad' : 'done') : k === i ? 'now' : '' }, `${k + 1}. ${st.name}`),
      ),
    );
    ui.foot.textContent =
      this.step === 'done' ? (logPath ? `기록: ${logPath}` : '') : '막히면 리모컨 HOME 버튼 → 이 단계를 처음부터 다시 합니다';
    log('step', { step: this.step });
    if (this.step === 'done') this.finishAll();
  }

  /** 단계 결과를 남기고 잠시 보여 준 뒤 다음 단계로 간다. */
  private pass(r: ItemResult, delay = ADVANCE_DELAY): void {
    if (this.passedAt !== null) return;
    this.results[this.step] = r;
    log('step-result', { step: this.step, pass: r.pass, text: r.text, ...r.data });
    flash(`${r.pass ? '✓ 통과' : '✗ 기준 미달'} — ${r.text}`, r.pass);
    this.passedAt = this.stepTime;
    this.advanceAfter = delay;
  }

  update(dt: number): void {
    const pad = this.pad;
    pad.update(dt);
    this.stepTime += dt;
    const fires = pad.takeFires();

    const home = pad.homeHeld;
    if (home && !this.homeWasHeld && this.step !== 'connect' && this.step !== 'done') {
      this.homeWasHeld = home;
      log('step-retry', { step: this.step });
      this.enter(this.index);
      return;
    }
    this.homeWasHeld = home;

    if (this.passedAt !== null) {
      showCross(this.aim(), this.step === 'aim' || this.step === 'calibrate');
      if (this.stepTime - this.passedAt >= this.advanceAfter) this.enter(this.index + 1);
      return;
    }
    // 연결이 끊기면 연결 단계부터 다시 하지 않고, 이 단계에서 다시 연결을 기다린다.
    if (!pad.connected && this.step !== 'connect' && this.step !== 'done') {
      say('리모컨 연결이 끊겼습니다', '리모컨의 아무 버튼이나 누르세요. 다시 연결되면 이 단계를 처음부터 합니다.', pad.status);
      showCross(null, false);
      this.s.reconnect = true;
      return;
    }
    if (this.s.reconnect) {
      this.enter(this.index);
      return;
    }

    switch (this.step) {
      case 'connect':
        return this.updateConnect();
      case 'sensor':
        return this.updateSensor(dt);
      case 'calibrate':
        return this.updateCalibrate(dt, fires);
      case 'aim':
        return this.updateAim(fires);
      case 'trigger':
        return this.updateTrigger(fires);
      case 'cover':
        return this.updateCover(dt, fires);
      case 'block':
        return this.updateBlock(dt);
      case 'focus':
        return this.updateFocus(fires);
      default:
        showCross(null, false);
    }
  }

  // ───── 좌표 ─────

  private map(raw: Point | null): Point | null {
    if (!raw) return null;
    const p = this.matrix ? applyHomography(this.matrix, raw.x, raw.y) : { x: 0.5 + (raw.x - 0.5) * DEFAULT_GAIN, y: 0.5 + (raw.y - 0.5) * DEFAULT_GAIN };
    const m = OFFSCREEN_MARGIN;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < -m || p.x > 1 + m || p.y < -m || p.y > 1 + m) return null;
    return { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
  }

  private aim(): Point | null {
    return this.map(this.pad.raw);
  }

  // ───── 1. 연결 ─────

  private updateConnect(): void {
    const pad = this.pad;
    showCross(null, false);
    // 배터리 값은 연결 직후 첫 상태 보고에 들어오므로 잠시 기다려 결과에 함께 남긴다.
    if (pad.connected && (pad.info.includes('배터리') || this.stepTime > 2 || SIM)) {
      this.pass({ pass: true, text: `연결됨 · ${pad.info}`, data: { info: pad.info } });
      return;
    }
    say('리모컨의 아무 버튼이나 누르세요', '처음 쓰는 리모컨이면 배터리 칸 안의 빨간 SYNC 버튼을 누르세요.', pad.status);
  }

  // ───── 2. 센서바 ─────

  private updateSensor(dt: number): void {
    const pad = this.pad;
    showCross(null, false);
    const stable = (this.s.stable as number | undefined) ?? 0;
    const next = pad.tracking === 'pair' ? stable + dt : 0;
    this.s.stable = next;
    if (next >= 1) {
      this.pass({ pass: true, text: '센서바 두 점 감지', data: { reportsPerSec: pad.reportsPerSec } });
      return;
    }
    const hint =
      this.stepTime > 6 && pad.dotCount === 0
        ? '점이 보이지 않습니다. 센서바 USB 전원과 위치(화면 위·아래 가운데)를 확인하세요.'
        : '평소 플레이하는 자리에 서서 총을 화면 가운데로 향하세요.';
    say('총을 화면 쪽으로 겨누세요', hint, `센서바 점 ${pad.dotCount}개`);
  }

  // ───── 3. 보정 ─────

  private updateCalibrate(dt: number, fires: (Point | null)[]): void {
    const pad = this.pad;
    const screen = { width: window.innerWidth, height: window.innerHeight };
    this.calib ??= new CalibrationSession(screen);
    const c = this.calib;
    if (c.phase === 'failed') {
      showTarget(null);
      say('보정을 다시 합니다', c.message, '방아쇠를 당기면 처음부터 다시 시작합니다');
      if (fires.length) c.restart();
      showCross(null, false);
      return;
    }
    c.update(dt, pad.raw, fires.length > 0);
    if (c.phase === 'done' && c.outcome) {
      this.matrix = c.outcome.matrix;
      showTarget(null);
      const ok = c.outcome.centerError <= 0.05;
      this.pass({ pass: ok, text: `중앙 확인 오차 ${(c.outcome.centerError * 100).toFixed(1)}%`, data: { centerError: c.outcome.centerError, screen } });
      return;
    }
    showTarget(c.target);
    const raw = pad.raw;
    const shown = raw ? provisionalAim(c.measured, raw, (p) => ({ x: 0.5 + (p.x - 0.5) * DEFAULT_GAIN, y: 0.5 + (p.y - 0.5) * DEFAULT_GAIN })) : null;
    showCross(shown && { x: Math.min(1, Math.max(0, shown.x)), y: Math.min(1, Math.max(0, shown.y)) }, true);
    say(
      `노란 표적 가운데를 겨누고 방아쇠를 당기세요 (${Math.min(c.index + 1, CALIBRATION_TARGETS.length)}/${CALIBRATION_TARGETS.length})`,
      c.phase === 'collect' ? '그대로 멈추세요…' : c.message || '당긴 뒤 0.5초 동안 총을 움직이지 마세요. 조준점이 표적과 어긋나 있어도 괜찮습니다.',
      '',
    );
  }

  // ───── 4. 조준 정확도 ─────

  private updateAim(fires: (Point | null)[]): void {
    this.accuracy ??= new AccuracyTest({ width: window.innerWidth, height: window.innerHeight }, true);
    const t = this.accuracy;
    for (const raw of fires) {
      const shot = t.shoot(this.map(raw));
      beep(shot?.error === null ? 220 : 660, 40);
      log('accuracy-shot', { target: shot?.target, aim: shot?.aim, error: shot?.error });
      if (t.done) break;
    }
    showCross(this.aim(), true);
    if (t.done) {
      showTarget(null);
      const s = t.summary();
      log('accuracy-result', { limit: ACCURACY_LIMIT, screen: t.screen, ...s });
      this.showAimTable(s);
      say('조준 결과 — 표적 자리마다 오차를 표시합니다', '잠시 뒤 다음 단계로 넘어갑니다.', '');
      this.pass(
        { pass: s.pass, text: `오차 90% ${pct(s.p90)} (기준 ${pct(ACCURACY_LIMIT)} 이하) · 도달 ${s.reached.filter(Boolean).length}/9`, data: { p50: s.p50, p90: s.p90, max: s.max, noSignal: s.noSignal, shots: s.shots } },
        RESULT_DELAY,
      );
      return;
    }
    showTarget(t.target, true);
    const last = t.shots[t.shots.length - 1];
    say(
      `조준점을 표적 가운데에 맞추고 쏘세요 (표적 ${t.index + 1}/9 · ${t.shotsAtTarget}/${SHOTS_PER_TARGET}발)`,
      '한 발마다 다시 겨냥합니다. 평소 플레이하는 자세 그대로 하세요.',
      last ? (last.error === null ? '조준 신호 없음 — 센서바가 보이게 하세요' : `직전 오차 ${pct(last.error)}`) : '',
    );
  }

  private showAimTable(s: AccuracySummary): void {
    ui.result.replaceChildren(
      h(
        'div',
        { class: 'grid' },
        ...ACCURACY_TARGETS.map((p, i) => {
          const e = s.perTarget[i].p90;
          const cell = h('div', { class: e !== null && e <= ACCURACY_LIMIT ? 'ok' : 'bad' }, pct(e));
          cell.style.left = `${p.x * 100}%`;
          cell.style.top = `${p.y * 100}%`;
          return cell;
        }),
      ),
    );
  }

  // ───── 5. 방아쇠 ─────

  private updateTrigger(fires: (Point | null)[]): void {
    const pad = this.pad;
    showCross(null, false);
    const now = performance.now();
    const goal = TriggerTest.GOAL;
    // 횟수(10번)와 길게 당기기를 따로 센다. 10번째를 길게 당겨도 길게 당기기로 치지 않는다.
    this.trigger ??= new TriggerTest();
    const count = this.trigger;
    for (let i = 0; i < fires.length; i++) beep(520, 40);
    if (!this.s.hold) {
      count.update(now, fires.length, pad.fireHeld);
      if (count.count < goal || pad.fireHeld) {
        say(`방아쇠를 ${goal}번 당기세요`, '한 번씩 끝까지 당겼다가 놓습니다. 화면 숫자가 1씩 올라가야 합니다.', `${Math.min(count.count, goal)} / ${goal}`);
        return;
      }
      this.s.hold = new TriggerTest();
      beep(880, 120);
      return;
    }
    const hold = this.s.hold as TriggerTest;
    hold.update(now, fires.length, pad.fireHeld);
    if (pad.fireHeld) {
      this.s.holdStart ??= now;
      const held = (now - (this.s.holdStart as number)) / 1000;
      say('그대로 유지하세요…', held >= TRIGGER_HOLD_MS / 1000 + 0.5 ? '이제 놓으세요.' : '2초 동안 당긴 채로 있습니다.', `${held.toFixed(1)}초`);
      return;
    }
    this.s.holdStart = undefined;
    if (hold.count > 0 && hold.longPresses === 0) {
      // 짧게 당겼다: 길게 당기기만 다시 받는다.
      this.s.hold = new TriggerTest();
      this.s.shortTries = ((this.s.shortTries as number | undefined) ?? 0) + 1;
    }
    if (hold.longPresses >= 1) {
      const pass = count.count === goal && count.bounces === 0 && hold.count === 1 && hold.longPressExtra === 0;
      const text = pass
        ? `${goal}번 모두 1회씩 인식 · 2초 길게 당겨도 1발`
        : `인식 ${count.count}회(기대 ${goal}회) · 50ms 안 연속 ${count.bounces} · 길게 당기는 동안 추가 ${hold.longPressExtra}`;
      const data = { count: count.count, expected: goal, bounces: count.bounces, longPressExtra: hold.longPressExtra, holdPresses: hold.count, pass };
      log('trigger-result', data);
      this.pass({ pass, text, data });
      return;
    }
    say('이번에는 방아쇠를 당긴 채로 2초 동안 유지하다가 놓으세요', '', this.s.shortTries ? '너무 짧았습니다. 다시 길게 당기세요.' : '');
  }

  // ───── 6. 엄폐 버튼 ─────

  private updateCover(dt: number, fires: (Point | null)[]): void {
    const pad = this.pad;
    showCross(null, false);
    this.s.fires = ((this.s.fires as number | undefined) ?? 0) + fires.length;
    const held = (this.s.held as number | undefined) ?? 0;
    if (pad.coverHeld) {
      this.s.held = held + dt;
      say('그대로 누르고 있으세요…', held + dt >= 1 ? '이제 놓으세요.' : '', `${(held + dt).toFixed(1)}초`);
      return;
    }
    if (held >= COVER_HOLD) {
      const firesDuring = this.s.fires as number;
      this.pass({ pass: firesDuring === 0, text: `엄폐 버튼 ${held.toFixed(1)}초 유지·해제 감지${firesDuring ? ` · 방아쇠 ${firesDuring}회 섞임` : ''}`, data: { heldSeconds: held, firesDuring } });
      return;
    }
    this.s.held = 0;
    say('엄폐 버튼(A)을 1초 동안 누르고 있다가 놓으세요', '총 손잡이 쪽 A 버튼입니다. 방아쇠는 당기지 않습니다.', held > 0 ? '너무 짧았습니다. 다시 길게 누르세요.' : '');
  }

  // ───── 7. 센서바 가림 ─────

  private updateBlock(dt: number): void {
    const pad = this.pad;
    showCross(this.aim(), true);
    if (!this.s.covered) {
      const t = pad.tracking === 'none' ? ((this.s.none as number | undefined) ?? 0) + dt : 0;
      this.s.none = t;
      if (t >= BLOCK_HOLD) {
        this.s.covered = true;
        this.s.coveredAt = performance.now() - t * 1000;
        beep(660, 80);
      }
      say('손으로 센서바를 가리세요', '화면 위(또는 아래)의 센서바 앞을 손바닥으로 덮습니다. 조준점이 회색 점선으로 바뀌어야 합니다.', `센서바 점 ${pad.dotCount}개`);
      return;
    }
    if (pad.tracking === 'pair') {
      const sec = (performance.now() - (this.s.coveredAt as number)) / 1000;
      this.pass({ pass: true, text: `가리면 신호 없음, 치우면 다시 조준됨 (가린 시간 ${sec.toFixed(1)}초)`, data: { coveredSeconds: sec } });
      return;
    }
    say('이제 손을 치우세요', '조준점이 다시 파란색으로 돌아와야 합니다.', pad.tracking === 'single' ? '한 점만 보입니다' : '신호 없음');
  }

  // ───── 8. 창 전환(포커스 상실) ─────

  private onFocus(focused: boolean): void {
    if (this.step !== 'focus' || this.passedAt !== null) return;
    if (!focused) {
      this.s.blurred = true;
      this.s.fireHeldAtBlur = this.pad.fireHeld;
      this.s.blurAt = performance.now();
      log('blur', { fireHeld: this.pad.fireHeld });
    } else if (this.s.blurred) {
      this.s.returned = true;
      this.s.fireHeldOnReturn = this.pad.fireHeld;
      this.s.awaySeconds = (performance.now() - (this.s.blurAt as number)) / 1000;
      this.pad.takeFires();
      log('focus', { fireHeld: this.pad.fireHeld, awaySeconds: this.s.awaySeconds });
    }
  }

  private updateFocus(fires: (Point | null)[]): void {
    const pad = this.pad;
    showCross(null, false);
    if (!this.s.blurred) {
      say(
        '방아쇠를 당긴 채로 키보드 Alt+Tab을 눌러 다른 창으로 가세요',
        '다른 창으로 가면 방아쇠를 놓고, 다시 Alt+Tab으로 이 창에 돌아오세요.',
        pad.fireHeld ? '방아쇠 당김 감지 — 이제 Alt+Tab' : '',
      );
      return;
    }
    if (!this.s.returned) {
      say('다시 Alt+Tab으로 이 창에 돌아오세요', '방아쇠는 놓은 상태로 돌아옵니다.', '');
      return;
    }
    if (!this.s.shotAt) {
      if (fires.length) {
        this.s.shotAt = performance.now();
        this.s.shots = fires.length;
        beep(520, 40);
      } else {
        say('돌아왔습니다. 방아쇠를 한 번만 당기세요', '창을 오가도 방아쇠가 정상인지 확인합니다.', pad.fireHeld ? '방아쇠를 아직 당기고 있습니다 — 놓았다가 한 번 당기세요' : '');
      }
      return;
    }
    this.s.shots = (this.s.shots as number) + fires.length;
    if (performance.now() - (this.s.shotAt as number) < 600) return;
    const shots = this.s.shots as number;
    const pass = shots === 1 && this.s.fireHeldAtBlur === true;
    const text = pass
      ? `창을 오간 뒤에도 방아쇠 1회 = 1발 (다른 창에 ${(this.s.awaySeconds as number).toFixed(1)}초)`
      : this.s.fireHeldAtBlur !== true
        ? '창을 바꿀 때 방아쇠를 당기고 있지 않았습니다(HOME으로 다시)'
        : `돌아온 뒤 한 번 당김에 ${shots}발 인식`;
    this.pass({ pass, text, data: { fireHeldAtBlur: this.s.fireHeldAtBlur, fireHeldOnReturn: this.s.fireHeldOnReturn, shots, awaySeconds: this.s.awaySeconds } });
  }

  // ───── 9. 결과 ─────

  private finishAll(): void {
    showCross(null, false);
    showTarget(null);
    const items = STEPS.filter((s) => s.id !== 'done');
    const all = items.every((s) => this.results[s.id]?.pass);
    say(all ? '검증 끝 — 모두 통과했습니다' : '검증 끝 — 기준 미달 항목이 있습니다', '이 창은 닫아도 됩니다. 결과는 파일로 저장했습니다.', '');
    beep(all ? 990 : 330, 300);
    ui.result.replaceChildren(
      h(
        'table',
        { class: 'summary' },
        ...items.map((s) => {
          const r = this.results[s.id];
          return h('tr', { class: r?.pass ? 'ok' : 'bad' }, h('td', {}, r?.pass ? '✓' : '✗'), h('th', {}, s.name), h('td', {}, r?.text ?? '-'));
        }),
      ),
    );
    const report = { app: 'WiiHwTest', sim: SIM, startedAt: this.startedAt, finishedAt: localTime(), allPass: all, results: this.results };
    log('hwtest-result', report);
    if (host && !this.saved)
      void host.call<string>('result.save', { json: JSON.stringify(report, null, 2) }).then((file) => {
        this.saved = file;
        ui.foot.textContent = `결과: ${file}${logPath ? ` · 기록: ${logPath}` : ''}`;
      });
  }
}

// ───────── 시작 ─────────

const pad: Pad = SIM ? new SimPad() : new WiiPad(log);
const runner = new Runner(pad);
(window as unknown as { __hwtest: unknown }).__hwtest = { runner, pad };

void host
  ?.call<{ closedGame: number; logPath: string }>('host.info')
  .then((info) => {
    logPath = info.logPath;
    log('start', { closedGame: info.closedGame, ua: navigator.userAgent, screen: { width: window.innerWidth, height: window.innerHeight } });
  })
  .catch(() => undefined);

// 1초마다 장치 상태 요약(판정 근거·문제 추적용)
setInterval(() => {
  if (!pad.connected) return;
  log('status', { step: runner.step, info: pad.info, reportsPerSec: pad.reportsPerSec, tracking: pad.tracking, dots: pad.dotCount, raw: pad.raw });
}, 1000);

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  runner.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

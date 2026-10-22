import './style.css';
import { ACCURACY_LIMIT, ACCURACY_TARGETS, AccuracyTest, SHOTS_PER_TARGET, TriggerTest, type AccuracySummary } from '../../src/calibration/AccuracyTest';
import { CALIBRATION_TARGETS, CalibrationSession, provisionalAim } from '../../src/calibration/CalibrationSession';
import { applyHomography, type Homography, type Point } from '../../src/calibration/homography';
import type { WiimoteButtons } from '../../src/input/wiimote/protocol';
import { host } from '../../src/platform/host';
import { h } from '../../src/ui/dom';
import { SimPad, WiiPad, type Pad, type RecordedReport } from './pad';

/**
 * Wii 총 실물 검증 앱. 게임과 별개로, 사람이 외울 것 없이 화면 지시를 하나씩 따라 하면 남은 실물 확인이 모두 끝나도록 만든다.
 * 각 단계는 장치 상태를 감지해 스스로 넘어가고, 결과는 결과 JSON·기록 파일에, 리모컨 입력 전체는 녹화 파일에 남긴다.
 * 녹화 파일은 이후 게임 자동 검증에서 실물 입력으로 재생한다(실물 테스트를 다시 하지 않기 위해).
 */

const SIM = new URLSearchParams(location.search).has('sim');
/** 보정 전 기본 매핑 배율(게임과 같은 근사값) */
const DEFAULT_GAIN = 2.2;
const OFFSCREEN_MARGIN = 0.03;
/** 통과 표시를 보여 준 뒤 다음 단계로 넘어가기까지(초) */
const ADVANCE_DELAY = 1.6;
/** 결과 숫자를 읽을 시간을 주는 단계(초) */
const RESULT_DELAY = 3.5;
/** HOME을 이 시간 이상 누르면 지금 단계를 처음부터 다시 한다(짧게 누르면 일시정지 버튼 시험) */
const RETRY_HOLD = 1.5;
const COVER_HOLD = 0.8;
const BLOCK_HOLD = 1.0;
/** 게임과 같은 규칙: 탄창 6발, 엄폐 0.8초 유지 시 장전 */
const MAGAZINE = 6;
const RELOAD_TIME = 0.8;
const PLAY_TARGETS = 12;
const PLAY_PAUSE_AT = 6;
/** 표적 반지름(화면 짧은 변 대비) */
const HIT_RADIUS = 0.045;
/** 자유 이동 완료 기준(구현 계획 17절): 이동 버튼을 유지하며 표적마다 10회 */
const MOVE_HITS = 10;
/** 1·2 버튼(선택)을 누를 기회를 주는 시간(초) */
const OPTIONAL_WAIT = 3;
/** 비틀기: 양쪽으로 이 각도 이상 비틀면 끝, 조준점 이동 허용치 */
const ROLL_NEED = (15 * Math.PI) / 180;
const ROLL_SHIFT_LIMIT = 0.04;

type StepId =
  | 'connect'
  | 'feedback'
  | 'sensor'
  | 'calibrate'
  | 'aim'
  | 'sight'
  | 'posture'
  | 'trigger'
  | 'buttons'
  | 'block'
  | 'roll'
  | 'move'
  | 'play'
  | 'focus'
  | 'power'
  | 'done';

const STEPS: { id: StepId; name: string }[] = [
  { id: 'connect', name: '연결' },
  { id: 'feedback', name: 'LED·진동·소리' },
  { id: 'sensor', name: '센서바' },
  { id: 'calibrate', name: '보정' },
  { id: 'aim', name: '조준(조준점)' },
  { id: 'sight', name: '조준(가늠쇠)' },
  { id: 'posture', name: '조준(한 걸음 뒤)' },
  { id: 'trigger', name: '방아쇠' },
  { id: 'buttons', name: '버튼' },
  { id: 'block', name: '센서바 가림' },
  { id: 'roll', name: '비틀기' },
  { id: 'move', name: '이동하며 사격' },
  { id: 'play', name: '실전 사격' },
  { id: 'focus', name: '창 전환' },
  { id: 'power', name: '전원·재연결' },
  { id: 'done', name: '결과' },
];

interface ItemResult {
  pass: boolean;
  text: string;
  data: Record<string, unknown>;
}

// ───────── 기록·녹화 ─────────

let logPath = '';
let recordPath = '';
function log(kind: string, data: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), local: localTime(), kind, sim: SIM || undefined, ...data });
  if (host) void host.call('log.append', { line }).catch(() => undefined);
  else console.log(line);
}

/** 녹화 버퍼. 1초마다 파일에 붙인다. 단계 표시·사건 줄도 같은 파일에 시간순으로 넣는다. */
const recBuffer: string[] = [];
function record(r: RecordedReport): void {
  recBuffer.push(JSON.stringify(r));
}
function recordMark(kind: string, data: Record<string, unknown> = {}): void {
  recBuffer.push(JSON.stringify({ t: Math.round(performance.now() * 10) / 10, mark: kind, ...data }));
}
function flushRecord(): void {
  if (!recBuffer.length || !host) return;
  const text = recBuffer.join('\n') + '\n';
  recBuffer.length = 0;
  void host.call('rec.append', { text }).catch(() => undefined);
}
setInterval(flushRecord, 1000);

function localTime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
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
    // 소리가 안 나도 검증은 계속한다(소리 확인 단계에서 사람이 판정한다).
  }
}

// ───────── 화면 ─────────

const pct = (v: number | null | undefined) => (v === null || v === undefined ? '-' : `${(v * 100).toFixed(2)}%`);
const deg = (r: number) => `${Math.round((r * 180) / Math.PI)}°`;

const ui = {
  steps: h('ol', { class: 'steps' }),
  title: h('h1', {}),
  sub: h('p', { class: 'sub' }),
  meter: h('div', { class: 'meter' }),
  flash: h('div', { class: 'flash' }),
  targets: h('div', { class: 'targets' }),
  cross: h('div', { class: 'cross' }, h('div', { class: 'ring' }), h('div', { class: 'dot' })),
  result: h('div', { class: 'result' }),
  answer: h('div', { class: 'answer' }, h('span', { class: 'yes' }, '예 = 방아쇠'), h('span', { class: 'no' }, '아니요 = A 버튼')),
  foot: h('div', { class: 'foot' }),
};
document.getElementById('app')!.append(
  h('header', {}, h('div', { class: 'brand' }, 'Wii 총 검증'), ui.steps),
  h('section', { class: 'say' }, ui.title, ui.sub, ui.meter),
  ui.targets,
  ui.result,
  ui.answer,
  ui.flash,
  ui.cross,
  ui.foot,
);

function say(title: string, sub = '', meter = ''): void {
  if (ui.title.textContent !== title) ui.title.textContent = title;
  if (ui.sub.textContent !== sub) ui.sub.textContent = sub;
  if (ui.meter.textContent !== meter) ui.meter.textContent = meter;
}

/** 표적들을 그린다. kind: big(보정) · small(정확도) · play(실전·이동) */
function showTargets(list: { p: Point; kind?: 'big' | 'small' | 'play' }[]): void {
  while (ui.targets.childElementCount < list.length) ui.targets.append(h('div', { class: 'target' }));
  [...ui.targets.children].forEach((el, i) => {
    const e = el as HTMLElement;
    const t = list[i];
    e.style.display = t ? 'block' : 'none';
    if (!t) return;
    e.className = `target ${t.kind ?? 'big'}`;
    e.style.left = `${t.p.x * 100}%`;
    e.style.top = `${t.p.y * 100}%`;
  });
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

/** 화면 좌표 사이 거리 ÷ 화면 짧은 변 */
function screenDist(a: Point, b: Point): number {
  const w = window.innerWidth;
  const hgt = window.innerHeight;
  return Math.hypot((a.x - b.x) * w, (a.y - b.y) * hgt) / Math.min(w, hgt);
}

/** 재현 가능한 의사 난수(실전 표적 위치) */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// ───────── 진행기 ─────────

type Answer = 'yes' | 'no';

class Runner {
  private index = 0;
  private stepTime = 0;
  private passedAt: number | null = null;
  private advanceAfter = ADVANCE_DELAY;
  private homeHeldFor = 0;
  private prev: WiimoteButtons;
  private matrix: Homography | null = null;
  readonly results: Partial<Record<StepId, ItemResult>> = {};
  /** 단계별 임시 상태. 단계에 들어갈 때마다 비운다. */
  private s: Record<string, unknown> = {};
  private calib: CalibrationSession | null = null;
  private accuracy: AccuracyTest | null = null;
  private trigger: TriggerTest | null = null;
  private readonly startedAt = localTime();
  private readonly startedMs = performance.now();
  private disconnects = 0;
  private saved = '';

  constructor(private readonly pad: Pad) {
    this.prev = pad.buttons;
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
    ui.answer.classList.remove('show');
    showTargets([]);
    this.pad.takeFires();
    ui.steps.replaceChildren(
      ...STEPS.map((st, k) =>
        h('li', { class: k < i ? (this.results[st.id]?.pass === false ? 'bad' : 'done') : k === i ? 'now' : '' }, `${k + 1}. ${st.name}`),
      ),
    );
    ui.foot.textContent =
      this.step === 'done' ? '' : `막히면 리모컨 HOME 버튼을 ${RETRY_HOLD}초 동안 누르세요 → 이 단계를 처음부터 다시 합니다`;
    log('step', { step: this.step });
    recordMark('step', { step: this.step });
    if (this.step === 'done') this.finishAll();
  }

  /** 단계 결과를 남기고 잠시 보여 준 뒤 다음 단계로 간다. */
  private pass(r: ItemResult, delay = ADVANCE_DELAY): void {
    if (this.passedAt !== null) return;
    this.results[this.step] = r;
    log('step-result', { step: this.step, pass: r.pass, text: r.text, ...r.data });
    recordMark('step-result', { step: this.step, pass: r.pass });
    ui.answer.classList.remove('show');
    flash(`${r.pass ? '✓ 통과' : '✗ 기준 미달'} — ${r.text}`, r.pass);
    this.passedAt = this.stepTime;
    this.advanceAfter = delay;
  }

  /** 이번 프레임에 새로 눌린 버튼 */
  private pressed(b: WiimoteButtons, name: keyof WiimoteButtons): boolean {
    return b[name] && !this.prev[name];
  }

  update(dt: number): void {
    const pad = this.pad;
    pad.update(dt);
    this.stepTime += dt;
    const fires = pad.takeFires();
    const b = pad.buttons;
    try {
      this.frame(dt, fires, b);
    } finally {
      this.prev = b;
    }
  }

  private frame(dt: number, fires: (Point | null)[], b: WiimoteButtons): void {
    const pad = this.pad;
    // HOME 길게: 지금 단계 다시
    this.homeHeldFor = b.home ? this.homeHeldFor + dt : 0;
    if (this.homeHeldFor >= RETRY_HOLD && this.step !== 'connect' && this.step !== 'done') {
      this.homeHeldFor = -999; // 놓을 때까지 다시 걸리지 않게
      log('step-retry', { step: this.step });
      recordMark('step-retry', { step: this.step });
      this.enter(this.index);
      return;
    }

    if (this.passedAt !== null) {
      showCross(this.aim(), ['aim', 'calibrate', 'posture', 'roll', 'move', 'play'].includes(this.step));
      if (this.stepTime - this.passedAt >= this.advanceAfter) this.enter(this.index + 1);
      return;
    }
    // 연결이 끊기면 이 단계에서 다시 연결을 기다린다(전원 시험 단계는 끊김 자체를 잰다).
    if (!pad.connected && !['connect', 'power', 'done'].includes(this.step)) {
      if (!this.s.reconnect) {
        this.disconnects++;
        log('unexpected-disconnect', { step: this.step });
        recordMark('disconnect', { step: this.step });
      }
      say('리모컨 연결이 끊겼습니다', '리모컨의 아무 버튼이나 누르세요. 다시 연결되면 이 단계를 처음부터 합니다.', pad.status);
      showCross(null, false);
      showTargets([]);
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
      case 'feedback':
        return this.updateFeedback(fires, b);
      case 'sensor':
        return this.updateSensor(dt);
      case 'calibrate':
        return this.updateCalibrate(dt, fires);
      case 'aim':
        return this.updateAccuracy(fires, true, SHOTS_PER_TARGET, '조준점을 표적 가운데에 맞추고 쏘세요', '평소 플레이하는 자세 그대로, 한 발마다 다시 겨냥합니다.');
      case 'sight':
        return this.updateAccuracy(fires, false, SHOTS_PER_TARGET, '이번에는 조준점 없이 총의 가늠쇠로 표적 가운데를 겨누고 쏘세요', '화면에 조준점이 나오지 않습니다. 총 위의 가늠쇠만 봅니다.');
      case 'posture':
        return this.updatePosture(fires);
      case 'trigger':
        return this.updateTrigger(fires);
      case 'buttons':
        return this.updateButtons(dt, fires, b);
      case 'block':
        return this.updateBlock(dt, fires);
      case 'roll':
        return this.updateRoll();
      case 'move':
        return this.updateMove(fires, b);
      case 'play':
        return this.updatePlay(dt, fires, b);
      case 'focus':
        return this.updateFocus(fires);
      case 'power':
        return this.updatePower();
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

  /** 예·아니요 질문: 방아쇠 = 예, A = 아니요 */
  private ask(fires: (Point | null)[], b: WiimoteButtons): Answer | null {
    ui.answer.classList.add('show');
    if (fires.length) return 'yes';
    if (this.pressed(b, 'a')) return 'no';
    return null;
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
    say('리모컨의 아무 버튼이나 누르세요', '처음 쓰는 리모컨이면 배터리 칸 안의 빨간 SYNC 버튼을 누르세요. 이 검증은 약 12분 걸립니다.', pad.status);
  }

  // ───── 2. LED·진동·소리(사람이 판정) ─────

  private updateFeedback(fires: (Point | null)[], b: WiimoteButtons): void {
    showCross(null, false);
    const answers = (this.s.answers as Record<string, Answer> | undefined) ?? {};
    this.s.answers = answers;
    const questions: { key: string; title: string; sub: string; repeat?: () => void }[] = [
      { key: 'led', title: '리모컨 아래쪽 LED 4개 중 맨 왼쪽 1개만 켜져 있나요?', sub: '파란 불빛 4개 중 하나만 켜져 있으면 “예”입니다.' },
      { key: 'rumble', title: '리모컨이 진동하나요?', sub: '2초마다 짧게 진동시킵니다.', repeat: () => this.pad.rumble(400) },
      { key: 'sound', title: 'PC 스피커에서 “삑” 소리가 들리나요?', sub: '2초마다 소리를 냅니다. 스피커 음량을 확인하세요.', repeat: () => beep(660, 250) },
    ];
    const q = questions.find((x) => !answers[x.key]);
    if (!q) {
      const ok = questions.every((x) => answers[x.key] === 'yes');
      const no = questions.filter((x) => answers[x.key] === 'no').map((x) => ({ led: 'LED', rumble: '진동', sound: '소리' })[x.key as 'led']);
      this.pass({ pass: ok, text: ok ? 'LED·진동·소리 모두 확인' : `안 됨: ${no.join(', ')}`, data: { ...answers } });
      return;
    }
    // 질문이 바뀐 직후의 입력은 이전 질문의 답이 이어진 것이므로 잠시 받지 않는다.
    if (this.s.q !== q.key) {
      this.s.q = q.key;
      this.s.qAt = this.stepTime;
      this.s.repeatAt = -1;
    }
    if (q.repeat && this.stepTime - (this.s.repeatAt as number) >= 2) {
      q.repeat();
      this.s.repeatAt = this.stepTime;
    }
    say(q.title, q.sub, '');
    const a = this.ask(fires, b);
    if (a && this.stepTime - (this.s.qAt as number) > 0.4) {
      answers[q.key] = a;
      log('answer', { question: q.key, answer: a });
      beep(a === 'yes' ? 880 : 330, 80);
    }
  }

  // ───── 3. 센서바 ─────

  private updateSensor(dt: number): void {
    const pad = this.pad;
    showCross(null, false);
    const stable = (this.s.stable as number | undefined) ?? 0;
    const next = pad.tracking === 'pair' ? stable + dt : 0;
    this.s.stable = next;
    if (next >= 1) {
      this.pass({ pass: true, text: `센서바 두 점 감지 (기다린 시간 ${this.stepTime.toFixed(0)}초)`, data: { reportsPerSec: pad.reportsPerSec, waitSeconds: this.stepTime } });
      return;
    }
    const hint =
      this.stepTime > 6 && pad.dotCount === 0
        ? '점이 보이지 않습니다. 센서바 USB 전원과 위치(화면 위·아래 가운데)를 확인하세요.'
        : '평소 플레이하는 자리에 서서 총을 화면 가운데로 향하세요. 이 자리를 기억해 두세요.';
    say('총을 화면 쪽으로 겨누세요', hint, `센서바 점 ${pad.dotCount}개`);
  }

  // ───── 4. 보정 ─────

  private updateCalibrate(dt: number, fires: (Point | null)[]): void {
    const pad = this.pad;
    const screen = { width: window.innerWidth, height: window.innerHeight };
    this.calib ??= new CalibrationSession(screen);
    const c = this.calib;
    if (c.phase === 'failed') {
      showTargets([]);
      say('보정을 다시 합니다', c.message, '방아쇠를 당기면 처음부터 다시 시작합니다');
      if (fires.length) {
        this.s.failures = ((this.s.failures as number | undefined) ?? 0) + 1;
        c.restart();
      }
      showCross(null, false);
      return;
    }
    c.update(dt, pad.raw, fires.length > 0);
    if (c.phase === 'done' && c.outcome) {
      this.matrix = c.outcome.matrix;
      showTargets([]);
      const ok = c.outcome.centerError <= 0.05;
      this.pass({
        pass: ok,
        text: `중앙 확인 오차 ${(c.outcome.centerError * 100).toFixed(1)}%`,
        data: { centerError: c.outcome.centerError, screen, measured: c.measured, failures: this.s.failures ?? 0, seconds: this.stepTime },
      });
      return;
    }
    showTargets([{ p: c.target }]);
    const raw = pad.raw;
    const shown = raw ? provisionalAim(c.measured, raw, (p) => ({ x: 0.5 + (p.x - 0.5) * DEFAULT_GAIN, y: 0.5 + (p.y - 0.5) * DEFAULT_GAIN })) : null;
    showCross(shown && { x: Math.min(1, Math.max(0, shown.x)), y: Math.min(1, Math.max(0, shown.y)) }, true);
    say(
      `노란 표적 가운데를 겨누고 방아쇠를 당기세요 (${Math.min(c.index + 1, CALIBRATION_TARGETS.length)}/${CALIBRATION_TARGETS.length})`,
      c.phase === 'collect' ? '그대로 멈추세요…' : c.message || '당긴 뒤 0.5초 동안 총을 움직이지 마세요. 조준점이 표적과 어긋나 있어도 괜찮습니다.',
      '',
    );
  }

  // ───── 5~7. 조준 정확도 ─────

  /** 9곳 정지 조준. 조준점 표시 여부와 표적당 발수만 다르다. */
  private updateAccuracy(fires: (Point | null)[], crosshair: boolean, shots: number, title: string, sub: string, pass?: (s: AccuracySummary) => boolean): void {
    this.accuracy ??= new AccuracyTest({ width: window.innerWidth, height: window.innerHeight }, crosshair, shots);
    const t = this.accuracy;
    for (const raw of fires) {
      const shot = t.shoot(this.map(raw));
      beep(shot?.error === null ? 220 : 660, 40);
      log('accuracy-shot', { step: this.step, crosshair, target: shot?.target, aim: shot?.aim, error: shot?.error });
      if (t.done) break;
    }
    showCross(this.aim(), crosshair);
    if (t.done) {
      showTargets([]);
      const s = t.summary();
      log('accuracy-result', { step: this.step, crosshair, limit: ACCURACY_LIMIT, screen: t.screen, shotsPerTarget: shots, ...s });
      this.showAimTable(s);
      say(`${STEPS[this.index].name} 결과 — 표적 자리마다 오차를 표시합니다`, '잠시 뒤 다음 단계로 넘어갑니다.', '');
      const reached = s.reached.filter(Boolean).length;
      const ok = pass ? pass(s) : s.pass;
      this.pass(
        {
          pass: ok,
          text: `오차 90% ${pct(s.p90)}${crosshair ? ` (기준 ${pct(ACCURACY_LIMIT)} 이하)` : ''} · 중앙값 ${pct(s.p50)} · 도달 ${reached}/9`,
          data: { crosshair, shotsPerTarget: shots, p50: s.p50, p90: s.p90, max: s.max, noSignal: s.noSignal, shots: s.shots, perTarget: s.perTarget.map((x) => x.p90) },
        },
        RESULT_DELAY,
      );
      return;
    }
    showTargets([{ p: t.target, kind: 'small' }]);
    const last = t.shots[t.shots.length - 1];
    say(
      `${title} (표적 ${t.index + 1}/9 · ${t.shotsAtTarget}/${shots}발)`,
      sub,
      last ? (last.error === null ? '조준 신호 없음 — 센서바가 보이게 하세요' : crosshair ? `직전 오차 ${pct(last.error)}` : '') : '',
    );
  }

  private updatePosture(fires: (Point | null)[]): void {
    if (!this.s.ready) {
      showCross(null, false);
      say('원래 자리에서 한 걸음(약 70cm) 뒤로 물러나세요', '물러난 자리에서 방아쇠를 한 번 당기면 시작합니다. 거리가 바뀌어도 조준이 맞는지 봅니다.', '');
      if (fires.length) {
        this.s.ready = true;
        this.pad.takeFires();
      }
      return;
    }
    // 거리 변화는 기준이 정해지지 않은 기록 항목이다: 9곳 모두 조준이 닿으면 통과, 오차는 기록한다.
    this.updateAccuracy(fires, true, 1, '물러난 자리에서 표적 가운데를 맞히세요', '끝나면 원래 자리로 돌아갑니다.', (s) => s.reached.every(Boolean));
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

  // ───── 8. 방아쇠 ─────

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
        say(`원래 자리로 돌아와서 방아쇠를 ${goal}번 당기세요`, `한 번씩 끝까지 당겼다가 놓습니다. 화면 숫자가 1씩 올라가야 합니다.`, `${Math.min(count.count, goal)} / ${goal}`);
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
      say('그대로 유지하세요…', held >= TriggerTest.LONG_PRESS / 1000 + 0.5 ? '이제 놓으세요.' : '2초 동안 당긴 채로 있습니다.', `${held.toFixed(1)}초`);
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
      const data = { count: count.count, expected: goal, bounces: count.bounces, longPressExtra: hold.longPressExtra, holdPresses: hold.count };
      log('trigger-result', { ...data, pass });
      this.pass({ pass, text, data });
      return;
    }
    say('이번에는 방아쇠를 당긴 채로 2초 동안 유지하다가 놓으세요', '', this.s.shortTries ? '너무 짧았습니다. 다시 길게 당기세요.' : '');
  }

  // ───── 9. 버튼(엄폐 A·일시정지 + − HOME·십자) ─────

  private updateButtons(dt: number, fires: (Point | null)[], b: WiimoteButtons): void {
    showCross(null, false);
    const done = (this.s.done as Record<string, boolean> | undefined) ?? {};
    this.s.done = done;
    this.s.fires = ((this.s.fires as number | undefined) ?? 0) + fires.length;
    // A: 엄폐·장전과 같은 0.8초 유지
    if (!done.a) {
      const held = (this.s.aHeld as number | undefined) ?? 0;
      if (b.a) this.s.aHeld = held + dt;
      else {
        if (held >= COVER_HOLD) {
          done.a = true;
          this.s.aSeconds = held;
          beep(880, 80);
        }
        this.s.aHeld = 0;
      }
    }
    const names: [keyof WiimoteButtons, string][] = [
      ['plus', '+'],
      ['minus', '−'],
      ['home', 'HOME(짧게)'],
      ['up', '십자 ↑'],
      ['down', '십자 ↓'],
      ['left', '십자 ←'],
      ['right', '십자 →'],
    ];
    for (const [k] of names)
      if (!done[k] && this.pressed(b, k)) {
        done[k] = true;
        beep(880, 60);
      }
    // 1·2는 이 게임에서 쓰지 않는다. 총에 끼운 채 누를 수 있는지 다음 게임을 위해 기록만 한다(못 눌러도 넘어간다).
    const optional: [keyof WiimoteButtons, string][] = [
      ['one', '1 (선택)'],
      ['two', '2 (선택)'],
    ];
    for (const [k] of optional) if (!done[k] && this.pressed(b, k)) done[k] = true;
    const all: [string, string][] = [['a', 'A 1초 누르기'], ...names.map(([k, n]) => [k, n] as [string, string])];
    const left = all.filter(([k]) => !done[k]);
    ui.result.replaceChildren(
      h(
        'div',
        { class: 'checklist' },
        ...[...all, ...optional].map(([k, n]) => h('span', { class: done[k] ? 'ok' : '' }, `${done[k] ? '✓' : '○'} ${n}`)),
      ),
    );
    if (!left.length) {
      this.s.requiredAt ??= this.stepTime;
      const optionalLeft = optional.filter(([k]) => !done[k]);
      if (optionalLeft.length && this.stepTime - (this.s.requiredAt as number) < OPTIONAL_WAIT) {
        say('1·2 버튼도 눌러 보세요', `총에 끼운 채로 누를 수 없으면 그대로 두세요. ${Math.ceil(OPTIONAL_WAIT - (this.stepTime - (this.s.requiredAt as number)))}초 뒤 넘어갑니다.`, '');
        return;
      }
      const firesDuring = this.s.fires as number;
      const opt = optional.map(([k, n]) => `${n.replace(' (선택)', '')} ${done[k] ? '됨' : '안 누름'}`).join(', ');
      this.pass({
        pass: firesDuring === 0,
        text: `A ${(this.s.aSeconds as number).toFixed(1)}초 유지 · + − HOME · 십자 4방향 모두 인식 · ${opt}${firesDuring ? ` · 방아쇠 ${firesDuring}회 섞임` : ''}`,
        data: { aSeconds: this.s.aSeconds, firesDuring, one: !!done.one, two: !!done.two },
      });
      return;
    }
    const aHeld = (this.s.aHeld as number | undefined) ?? 0;
    say(
      '아래 버튼을 하나씩 눌러 보세요 (순서 상관없음)',
      'A는 1초 동안 누르고 있다가 놓습니다. 방아쇠는 당기지 않습니다. 총을 잡은 채로 누르기 어려운 버튼이 있으면 기억해 두세요.',
      b.a && !done.a ? `A ${aHeld.toFixed(1)}초` : `남은 버튼: ${left.map(([, n]) => n).join(' · ')}`,
    );
  }

  // ───── 10. 센서바 가림 ─────

  private updateBlock(dt: number, fires: (Point | null)[]): void {
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
    if (!this.s.blockedShot) {
      for (const raw of fires) {
        const aim = this.map(raw);
        this.s.blockedShot = aim === null ? 'blocked' : 'fired';
        flash(aim === null ? '조준 신호 없음 — 발사 막힘' : '가렸는데도 조준 신호가 있습니다', aim === null);
        setTimeout(() => ui.flash.classList.remove('show'), 1200);
      }
      if (!this.s.blockedShot) {
        say('가린 채로 방아쇠를 한 번 당기세요', '조준 신호가 없으면 발사가 막혀야 합니다.', pad.tracking === 'none' ? '신호 없음' : '손이 센서바를 덜 가렸습니다');
        return;
      }
    }
    if (pad.tracking === 'pair') {
      const sec = (performance.now() - (this.s.coveredAt as number)) / 1000;
      const ok = this.s.blockedShot === 'blocked';
      this.pass({
        pass: ok,
        text: ok ? `가리면 신호 없음·발사 막힘, 치우면 다시 조준됨 (가린 시간 ${sec.toFixed(1)}초)` : '가린 상태에서 발사가 막히지 않았습니다',
        data: { coveredSeconds: sec, blockedShot: this.s.blockedShot },
      });
      return;
    }
    say('이제 손을 치우세요', '조준점이 다시 파란색으로 돌아와야 합니다.', pad.tracking === 'single' ? '한 점만 보입니다' : '신호 없음');
  }

  // ───── 11. 비틀기(두 점 각도 보정) ─────

  private updateRoll(): void {
    const pad = this.pad;
    const target = { x: 0.5, y: 0.55 };
    const aim = this.aim();
    showTargets([{ p: target }]);
    showCross(aim, true);
    const samples = (this.s.samples as { roll: number; aim: Point }[] | undefined) ?? [];
    this.s.samples = samples;
    // 표적을 겨누기 시작한 뒤부터 모은다(그 전 조준 이동을 비틀기 탓으로 세지 않도록).
    if (aim && !this.s.aiming && screenDist(aim, target) <= 0.08) this.s.aiming = true;
    if (aim && pad.tracking === 'pair' && this.s.aiming) {
      this.s.base ??= pad.roll;
      samples.push({ roll: pad.roll - (this.s.base as number), aim });
    }
    const rolls = samples.map((x) => x.roll);
    const minR = rolls.length ? Math.min(...rolls) : 0;
    const maxR = rolls.length ? Math.max(...rolls) : 0;
    if (minR <= -ROLL_NEED && maxR >= ROLL_NEED && samples.length > 60) {
      // 비틀지 않았을 때와 많이 비틀었을 때 조준점 평균 위치의 차이
      const mean = (list: { aim: Point }[]) => ({ x: list.reduce((a, v) => a + v.aim.x, 0) / list.length, y: list.reduce((a, v) => a + v.aim.y, 0) / list.length });
      const flat = samples.filter((x) => Math.abs(x.roll) < ROLL_NEED / 3);
      const left = samples.filter((x) => x.roll <= -ROLL_NEED * 0.8);
      const right = samples.filter((x) => x.roll >= ROLL_NEED * 0.8);
      const base = mean(flat.length ? flat : samples);
      const shift = Math.max(screenDist(mean(left), base), screenDist(mean(right), base));
      const ok = shift <= ROLL_SHIFT_LIMIT;
      showTargets([]);
      this.pass({
        pass: ok,
        text: `${deg(minR)}~${deg(maxR)} 비틀어도 조준점 이동 ${pct(shift)} (허용 ${pct(ROLL_SHIFT_LIMIT)})`,
        data: { minRollDeg: (minR * 180) / Math.PI, maxRollDeg: (maxR * 180) / Math.PI, shift, samples: samples.length },
      });
      return;
    }
    say(
      '표적을 계속 겨눈 채로 손목을 왼쪽·오른쪽으로 천천히 비트세요',
      '문 손잡이를 돌리듯 총을 기울입니다(양쪽 약 20도). 조준점이 표적에서 크게 벗어나지 않아야 합니다.',
      `왼쪽 ${deg(-minR)} ${minR <= -ROLL_NEED ? '✓' : ''} · 오른쪽 ${deg(maxR)} ${maxR >= ROLL_NEED ? '✓' : ''}`,
    );
  }

  // ───── 12. 이동하며 사격(십자 버튼 + 조준 + 방아쇠 동시) ─────

  private updateMove(fires: (Point | null)[], b: WiimoteButtons): void {
    const phases: { dir: keyof WiimoteButtons; arrow: string; target: Point }[] = [
      { dir: 'up', arrow: '↑', target: { x: 0.3, y: 0.55 } },
      { dir: 'left', arrow: '←', target: { x: 0.7, y: 0.55 } },
    ];
    const k = (this.s.phase as number | undefined) ?? 0;
    this.s.phase = k;
    const stats = (this.s.stats as { hits: number; misses: number; notHeld: number }[] | undefined) ?? phases.map(() => ({ hits: 0, misses: 0, notHeld: 0 }));
    this.s.stats = stats;
    const aim = this.aim();
    showCross(aim, true);

    if (k >= phases.length) {
      // 조작감은 사람만 판정할 수 있다: 기록용 질문(통과·미달에는 쓰지 않는다)
      showTargets([]);
      say('십자 버튼과 방아쇠를 함께 쓰기 편했나요?', '총을 잡은 채로 십자 버튼을 누르고 쏘는 것이 할 만했는지 답해 주세요.', '');
      const a = this.ask(fires, b);
      if (a && this.stepTime - (this.s.askAt as number) > 0.4) {
        log('answer', { question: 'move-comfort', answer: a });
        this.pass({
          pass: true,
          text: `십자 누른 채 ${MOVE_HITS}발씩 2방향 명중 (빗나감 ${stats.reduce((s, x) => s + x.misses, 0)}) · 조작 ${a === 'yes' ? '편함' : '불편함'}`,
          data: { stats, comfortable: a === 'yes' },
        });
      }
      return;
    }
    const p = phases[k];
    const st = stats[k];
    for (const raw of fires) {
      const shot = this.map(raw);
      if (!b[p.dir]) {
        st.notHeld++;
        beep(220, 60);
      } else if (shot && screenDist(shot, p.target) <= HIT_RADIUS * 1.3) {
        st.hits++;
        beep(880, 50);
      } else {
        st.misses++;
        beep(330, 50);
      }
    }
    if (st.hits >= MOVE_HITS) {
      this.s.phase = k + 1;
      this.s.askAt = this.stepTime;
      this.pad.takeFires();
      beep(990, 120);
      return;
    }
    showTargets([{ p: p.target, kind: 'play' }]);
    ui.result.replaceChildren(h('div', { class: 'arrows' }, ...['up', 'down', 'left', 'right'].map((d) => h('span', { class: b[d as 'up'] ? 'on' : '' }, { up: '↑', down: '↓', left: '←', right: '→' }[d]!))));
    say(
      `십자 ${p.arrow}를 누른 채로 표적을 ${MOVE_HITS}번 맞히세요 (${k + 1}/2)`,
      '게임에서 걸어가며 쏘는 조작입니다. 십자 버튼을 계속 누르고 있어야 셉니다.',
      `${st.hits} / ${MOVE_HITS}${st.notHeld ? ` · ${p.arrow}를 안 누르고 쏜 것 ${st.notHeld}회` : ''}`,
    );
  }

  // ───── 13. 실전 사격(게임 규칙: 탄창·장전·일시정지) ─────

  private updatePlay(dt: number, fires: (Point | null)[], b: WiimoteButtons): void {
    interface Play {
      rand: () => number;
      alive: Point[];
      destroyed: number;
      ammo: number;
      coverTime: number;
      reloads: number;
      shots: number;
      hits: number;
      empty: number;
      noAim: number;
      coverBlocked: number;
      pauseState: 'before' | 'ask' | 'paused' | 'done';
      pausedBy: string;
      startedAt: number;
    }
    let g = this.s.play as Play | undefined;
    if (!g) {
      g = { rand: lcg(20261022), alive: [], destroyed: 0, ammo: MAGAZINE, coverTime: 0, reloads: 0, shots: 0, hits: 0, empty: 0, noAim: 0, coverBlocked: 0, pauseState: 'before', pausedBy: '', startedAt: this.stepTime };
      this.s.play = g;
    }
    const aim = this.aim();

    // 일시정지: 6번째 표적을 부순 뒤 + − HOME 중 하나로 멈추고, 방아쇠로 다시 시작한다.
    if (g.pauseState === 'ask' || g.pauseState === 'paused') {
      showTargets([]);
      showCross(null, false);
      if (g.pauseState === 'ask') {
        const btn = (['plus', 'minus', 'home'] as const).find((n) => this.pressed(b, n));
        if (btn) {
          g.pauseState = 'paused';
          g.pausedBy = btn;
          this.pad.takeFires();
          beep(440, 120);
        }
        say('+ 버튼(또는 −, HOME)을 눌러 일시정지하세요', '게임에서 잠깐 멈추는 동작입니다.', '');
      } else {
        say('일시정지 중 — 방아쇠를 당기면 이어서 합니다', '이어서 할 때의 방아쇠는 총알로 나가지 않아야 합니다.', `탄 ${g.ammo}/${MAGAZINE}`);
        if (fires.length) {
          g.pauseState = 'done';
          beep(880, 80);
        }
      }
      return;
    }

    // 엄폐(A 유지): 엄폐 중 발사 막힘, 0.8초 유지 시 장전
    const cover = this.pad.coverHeld;
    g.coverTime = cover ? g.coverTime + dt : 0;
    if (cover && g.coverTime >= RELOAD_TIME && g.ammo < MAGAZINE) {
      g.ammo = MAGAZINE;
      g.reloads++;
      beep(990, 100);
    }
    for (const raw of fires) {
      const shot = this.map(raw);
      if (cover) g.coverBlocked++;
      else if (g.ammo === 0) {
        g.empty++;
        beep(200, 80);
      } else if (!shot) {
        g.noAim++;
        beep(220, 60);
      } else {
        g.ammo--;
        g.shots++;
        const hit = g.alive.findIndex((t) => screenDist(t, shot) <= HIT_RADIUS);
        if (hit >= 0) {
          g.alive.splice(hit, 1);
          g.hits++;
          g.destroyed++;
          beep(880, 60);
        } else beep(400, 40);
      }
    }
    if (g.destroyed >= PLAY_TARGETS) {
      showTargets([]);
      const seconds = this.stepTime - g.startedAt;
      const ok = g.reloads >= 1 && g.pauseState === 'done';
      this.pass({
        pass: ok,
        text: `표적 ${PLAY_TARGETS}개 모두 맞힘 · ${seconds.toFixed(0)}초 · 명중률 ${Math.round((g.hits / Math.max(1, g.shots)) * 100)}% · 장전 ${g.reloads}회 · 일시정지·재개 확인`,
        data: { seconds, shots: g.shots, hits: g.hits, reloads: g.reloads, empty: g.empty, noAim: g.noAim, coverBlocked: g.coverBlocked, pausedBy: g.pausedBy },
      });
      return;
    }
    if (g.destroyed >= PLAY_PAUSE_AT && g.pauseState === 'before') {
      g.pauseState = 'ask';
      return;
    }
    // 표적은 한 번에 2개까지, 위쪽 글자와 겹치지 않는 범위에 나타난다.
    const remaining = PLAY_TARGETS - g.destroyed;
    while (g.alive.length < Math.min(2, remaining)) g.alive.push({ x: 0.12 + g.rand() * 0.76, y: 0.3 + g.rand() * 0.55 });
    showTargets(g.alive.map((p) => ({ p, kind: 'play' as const })));
    showCross(aim, !cover);
    const ammo = '●'.repeat(g.ammo) + '○'.repeat(MAGAZINE - g.ammo);
    say(
      cover ? (g.ammo < MAGAZINE ? '엄폐 중 — 그대로 누르고 있으면 장전됩니다' : '엄폐 중 — A를 놓으면 다시 쏠 수 있습니다') : g.ammo === 0 ? '탄창이 비었습니다 — A 버튼을 누르고 있으세요(장전)' : '나타나는 표적을 모두 맞히세요',
      `게임과 같은 규칙: 6발을 쏘면 A를 0.8초 누르고 있어 장전합니다. 남은 표적 ${remaining}개.`,
      `탄 ${ammo}`,
    );
  }

  // ───── 14. 창 전환(포커스 상실) ─────

  private onFocus(focused: boolean): void {
    if (this.step !== 'focus' || this.passedAt !== null) return;
    const b = this.pad.buttons;
    if (!focused) {
      this.s.blurred = true;
      this.s.fireHeldAtBlur = this.pad.fireHeld;
      this.s.dpadHeldAtBlur = b.up || b.down || b.left || b.right;
      this.s.blurAt = performance.now();
      log('blur', { fireHeld: this.pad.fireHeld, dpadHeld: this.s.dpadHeldAtBlur });
      recordMark('blur');
    } else if (this.s.blurred) {
      this.s.returned = true;
      this.s.fireHeldOnReturn = this.pad.fireHeld;
      this.s.awaySeconds = (performance.now() - (this.s.blurAt as number)) / 1000;
      this.pad.takeFires();
      log('focus', { fireHeld: this.pad.fireHeld, awaySeconds: this.s.awaySeconds });
      recordMark('focus');
    }
  }

  private updateFocus(fires: (Point | null)[]): void {
    const pad = this.pad;
    const b = pad.buttons;
    showCross(null, false);
    if (!this.s.blurred) {
      say(
        '방아쇠를 당긴 채로 키보드 Alt+Tab을 눌러 다른 창으로 가세요',
        '할 수 있으면 십자 ↑도 함께 누릅니다. 다른 창으로 가면 모두 놓고, 다시 Alt+Tab으로 이 창에 돌아오세요.',
        pad.fireHeld ? `방아쇠 당김${b.up ? ' · ↑ 누름' : ''} — 이제 Alt+Tab` : '',
      );
      return;
    }
    if (!this.s.returned) {
      say('다시 Alt+Tab으로 이 창에 돌아오세요', '방아쇠와 십자 버튼은 놓은 상태로 돌아옵니다.', '');
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
    const dpadStuck = b.up || b.down || b.left || b.right;
    const pass = shots === 1 && this.s.fireHeldAtBlur === true && !dpadStuck;
    const text = pass
      ? `창을 오간 뒤에도 방아쇠 1회 = 1발, 십자 버튼 고착 없음 (다른 창에 ${(this.s.awaySeconds as number).toFixed(1)}초${this.s.dpadHeldAtBlur ? ', ↑ 누른 채 전환' : ''})`
      : this.s.fireHeldAtBlur !== true
        ? '창을 바꿀 때 방아쇠를 당기고 있지 않았습니다(HOME 길게 눌러 다시)'
        : dpadStuck
          ? '돌아온 뒤에도 십자 버튼이 눌린 것으로 보입니다'
          : `돌아온 뒤 한 번 당김에 ${shots}발 인식`;
    this.pass({ pass, text, data: { fireHeldAtBlur: this.s.fireHeldAtBlur, dpadHeldAtBlur: this.s.dpadHeldAtBlur, fireHeldOnReturn: this.s.fireHeldOnReturn, shots, awaySeconds: this.s.awaySeconds } });
  }

  // ───── 15. 전원 끄기·다시 켜기 ─────

  private updatePower(): void {
    const pad = this.pad;
    showCross(null, false);
    if (!this.s.off) {
      if (!pad.connected) {
        this.s.off = true;
        this.s.offAt = performance.now();
        recordMark('power-off');
        beep(440, 120);
        return;
      }
      // Wii 리모컨은 전원 버튼으로 꺼지지 않는다(2026-10-22 실물). 건전지를 빼야 끊긴다.
      say('리모컨의 건전지를 빼세요', '전원 버튼으로는 꺼지지 않습니다. 건전지를 빼면 끊김을 감지합니다.', '');
      return;
    }
    if (pad.connected) {
      const sec = (performance.now() - (this.s.offAt as number)) / 1000;
      recordMark('power-on');
      this.pass({ pass: true, text: `끊김 감지 → 아무 버튼으로 다시 연결 (꺼진 뒤 ${sec.toFixed(1)}초)`, data: { secondsUntilReconnect: sec, info: pad.info } });
      return;
    }
    say('끊김을 감지했습니다. 건전지를 다시 넣고 아무 버튼이나 누르세요', 'SYNC가 아닌 보통 버튼(A 등)입니다. 자동으로 다시 연결되어야 합니다.', pad.status);
  }

  // ───── 16. 결과 ─────

  private finishAll(): void {
    showCross(null, false);
    showTargets([]);
    const items = STEPS.filter((s) => s.id !== 'done');
    const all = items.every((s) => this.results[s.id]?.pass);
    const minutes = (performance.now() - this.startedMs) / 60000;
    say(all ? '검증 끝 — 모두 통과했습니다' : '검증 끝 — 기준 미달 항목이 있습니다', '이 창은 닫아도 됩니다. 결과와 입력 녹화를 파일로 저장했습니다.', '');
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
    const report = {
      app: 'WiiHwTest',
      version: 2,
      sim: SIM,
      startedAt: this.startedAt,
      finishedAt: localTime(),
      minutes,
      unexpectedDisconnects: this.disconnects,
      screen: { width: window.innerWidth, height: window.innerHeight },
      recordPath,
      allPass: all,
      results: this.results,
    };
    log('hwtest-result', report);
    recordMark('done');
    flushRecord();
    if (host && !this.saved)
      void host.call<string>('result.save', { json: JSON.stringify(report, null, 2) }).then((file) => {
        this.saved = file;
        ui.foot.textContent = `결과: ${file}`;
      });
  }
}

// ───────── 시작 ─────────

const pad: Pad = SIM ? new SimPad() : new WiiPad(log, record);
const runner = new Runner(pad);
(window as unknown as { __hwtest: unknown }).__hwtest = { runner, pad };

void host
  ?.call<{ closedGame: number; logPath: string; recordPath: string }>('host.info')
  .then((info) => {
    logPath = info.logPath;
    recordPath = info.recordPath;
    log('start', { closedGame: info.closedGame, logPath, recordPath, ua: navigator.userAgent, screen: { width: window.innerWidth, height: window.innerHeight } });
    recordMark('start', { screen: { width: window.innerWidth, height: window.innerHeight }, sim: SIM });
  })
  .catch(() => undefined);

// 1초마다 장치 상태 요약(판정 근거·문제 추적용)
setInterval(() => {
  if (!pad.connected) return;
  log('status', { step: runner.step, info: pad.info, reportsPerSec: pad.reportsPerSec, tracking: pad.tracking, dots: pad.dotCount, raw: pad.raw, roll: pad.roll });
}, 1000);

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  runner.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

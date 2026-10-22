import type { Sfx } from '../audio/Sfx';
import {
  BUTTON_LABELS,
  PAUSE_BUTTONS,
  newlyPressed,
  saveButtonMap,
  type WiimoteButtonName,
} from '../input/wiimote/ButtonMap';
import type { PairProgress, PairResult } from '../input/wiimote/hid';
import { NO_BUTTONS, type WiimoteButtons } from '../input/wiimote/protocol';
import type { WiimoteManager } from '../input/wiimote/WiimoteManager';
import type { WiimoteSource } from '../input/WiimoteSource';
import { h } from './dom';
import { drawIrView } from './irView';

export type SetupStep = 'choose' | 'connect' | 'sensor' | 'buttons';
export type PlayDevice = 'wiimote' | 'mouse';

export interface SetupDeps {
  manager: WiimoteManager;
  source: WiimoteSource;
  sfx: Sfx;
  onDone: (device: PlayDevice) => void;
  onCancel: () => void;
  log: (data: Record<string, unknown>) => void;
}

/** 센서바 두 점이 이 시간 동안 계속 보이면 통과 */
const SENSOR_STABLE = 1.0;
/** 이 시간이 지나도 점이 안 보이면 원인 안내를 띄운다 */
const SENSOR_HINT_AFTER = 6;
/** 통과 표시를 보여 준 뒤 다음 단계로 넘어가기까지 */
const ADVANCE_DELAY = 0.8;
/** 이미 등록된 리모컨이 자동 연결될 여유를 준 뒤 게임 안 등록을 시작한다 */
const PAIR_START_DELAY = 1.5;
const PAIR_SECONDS = 120;

const PAIR_STAGE_TEXT: Record<string, (p: PairProgress) => string> = {
  radio: () => '블루투스 준비됨 — 리모컨을 찾는 중…',
  searching: () => '리모컨을 찾는 중…',
  found: (p) => `리모컨 발견 — 등록 중 (${p.attempt}번째 시도)`,
  'waiting-remembered': () => '등록된 리모컨이 있습니다 — 리모컨의 아무 버튼이나 누르세요.',
  retry: (p) => p.message,
  're-register': () => '이전 등록 정보를 정리하고 다시 등록합니다…',
  paired: (p) => (p.permanent ? '등록 완료 — 다음부터는 아무 버튼만 누르면 연결됩니다. 연결하는 중…' : '임시 연결 — 연결하는 중…'),
  already: () => '등록된 리모컨 — 연결하는 중…',
  'no-radio': (p) => p.message,
};

type ButtonTask = 'fire' | 'cover' | 'pause';

/**
 * 게임 시작 전 컨트롤러 설정. 각 단계는 장치 상태를 자동으로 감지해 넘어간다.
 * 조작 방식 선택 → 리모컨 연결 → 센서바 확인 → 버튼 확인(실제 눌린 버튼을 기능에 학습)
 */
export class SetupWizard {
  readonly el = h('div', { class: 'screen' });
  step: SetupStep;
  private stepTime = 0;
  private passedAt: number | null = null;
  private stableTime = 0;
  private message = '';
  private searching = false;
  private pairing: 'idle' | 'running' | 'ended' = 'idle';
  private pairText = '';
  private prevButtons: WiimoteButtons = NO_BUTTONS;
  private buttonTask: ButtonTask = 'fire';
  private learned: { fire?: WiimoteButtonName; cover?: WiimoteButtonName; pause?: WiimoteButtonName } = {};

  // 단계별로 매 프레임 갱신하는 요소
  private readonly status = h('p', { class: 'setup-status' });
  private readonly hint = h('div', { class: 'setup-hint' });
  private readonly irCanvas = h('canvas', { width: 320, height: 240, class: 'setup-ir' });
  private readonly taskList = h('ol', { class: 'setup-tasks' });

  constructor(
    private readonly deps: SetupDeps,
    start: SetupStep,
    private readonly learnButtons: boolean,
  ) {
    this.step = start;
    this.enter(start);
  }

  /** 리모컨으로 화면 버튼을 겨냥해 누르는 것을 허용할지. 버튼 학습 중에는 막는다. */
  get allowPointerClick(): boolean {
    return this.step === 'choose' || this.step === 'connect';
  }

  update(dt: number): void {
    this.stepTime += dt;
    const { source } = this.deps;

    if (this.passedAt !== null) {
      if (this.stepTime - this.passedAt >= ADVANCE_DELAY) this.next();
      return;
    }

    switch (this.step) {
      case 'connect':
        if (source.connected) {
          const d = source.device!;
          this.pass(`연결됨 · ${d.model}${d.batteryLevel !== null ? ` · 배터리 ${Math.round(d.batteryLevel * 100)}%` : ''}`);
          this.deps.log({ step: 'connect', result: 'ok', model: d.model, productName: d.hid.productName });
        } else {
          const m = this.deps.manager;
          if (m.canPair && this.pairing === 'idle' && this.stepTime >= PAIR_START_DELAY) void this.startPairing();
          this.status.className = 'setup-status warn';
          this.status.textContent =
            m.availability === 'connecting'
              ? '리모컨을 여는 중…'
              : m.canPair
                ? this.pairText || this.message || '리모컨을 찾는 중…'
                : this.message || m.lastError || '리모컨을 찾고 있습니다. 아래 순서대로 연결하세요.';
        }
        break;

      case 'sensor': {
        if (!source.connected) return this.goto('connect');
        const ir = source.ir;
        drawIrView(this.irCanvas, source.device?.dots ?? [], ir);
        this.stableTime = ir.tracking === 'pair' ? this.stableTime + dt : 0;
        if (this.stableTime >= SENSOR_STABLE) {
          this.pass('센서바 감지됨');
          this.deps.log({ step: 'sensor', result: 'ok', sensitivity: source.device?.sensitivityName, dots: source.device?.dots });
          break;
        }
        this.status.className = 'setup-status warn';
        this.status.textContent =
          ir.dotCount === 0
            ? '센서바가 보이지 않습니다. 총을 화면 쪽으로 향하세요.'
            : ir.dotCount === 1
              ? '센서바 점이 하나만 보입니다. 화면 가운데를 향하세요.'
              : '센서바 감지 중…';
        this.hint.style.display = this.stepTime > SENSOR_HINT_AFTER ? 'block' : 'none';
        break;
      }

      case 'buttons':
        if (!source.connected) return this.goto('connect');
        this.updateButtons();
        break;

      default:
        break;
    }
  }

  private updateButtons(): void {
    const now = this.deps.source.rawButtons;
    const pressed = newlyPressed(this.prevButtons, now);
    this.prevButtons = now;
    for (const b of pressed) {
      const l = this.learned;
      if (this.buttonTask === 'fire') {
        l.fire = b;
        this.buttonTask = 'cover';
      } else if (this.buttonTask === 'cover') {
        if (b === l.fire) continue;
        l.cover = b;
        this.buttonTask = 'pause';
      } else {
        if (!PAUSE_BUTTONS.includes(b) || b === l.fire || b === l.cover) continue;
        l.pause = b;
        const map = { fire: l.fire!, cover: l.cover! };
        this.deps.source.buttonMap = map;
        saveButtonMap(map);
        this.deps.log({ step: 'buttons', result: 'ok', ...l });
        this.renderTasks();
        this.pass('버튼 설정 완료');
        return;
      }
      this.deps.sfx.play('ui');
      this.renderTasks();
    }
  }

  /** 마법사를 벗어날 때 진행 중인 등록을 멈춘다. */
  dispose(): void {
    if (this.pairing === 'running') this.deps.manager.cancelPair();
  }

  private async startPairing(): Promise<void> {
    this.pairing = 'running';
    this.pairText = '';
    this.render();
    const r: PairResult = await this.deps.manager.pair(PAIR_SECONDS, (p) => {
      const f = PAIR_STAGE_TEXT[p.stage];
      if (f) this.pairText = f(p);
      this.deps.log({ step: 'pair', ...p });
    });
    this.deps.log({ step: 'pair', result: r });
    if (this.step !== 'connect') return;
    if (r === 'paired' || r === 'already') {
      // 연결은 관리자의 자동 재시도가 맡는다. 등록 직후 Windows가 HID 장치를 만드는 데 몇 초 걸린다.
      this.pairing = 'running';
      this.pairText = '등록 완료 — 연결하는 중…';
      return;
    }
    this.pairing = 'ended';
    this.pairText =
      r === 'timeout'
        ? '리모컨을 찾지 못했습니다. 리모컨을 PC 가까이 두고 SYNC 버튼을 누른 뒤 [다시 찾기]를 누르세요. 그래도 안 되면 건전지를 확인하세요.'
        : r === 'no-radio'
          ? 'PC 블루투스를 찾지 못했습니다. 블루투스를 켜거나 USB 블루투스 어댑터를 연결하세요.'
          : r === 'cancelled'
            ? ''
            : '리모컨 등록 중 오류가 났습니다. 리모컨 건전지를 뺐다 다시 넣고 [다시 찾기]를 누르세요.';
    this.render();
  }

  private pass(text: string): void {
    this.deps.sfx.play('reload');
    this.status.className = 'setup-status ok';
    this.status.textContent = `✓ ${text}`;
    this.hint.style.display = 'none';
    this.passedAt = this.stepTime;
  }

  private next(): void {
    if (this.step === 'connect') this.goto('sensor');
    else if (this.step === 'sensor' && this.learnButtons) this.goto('buttons');
    else this.deps.onDone('wiimote');
  }

  private goto(step: SetupStep): void {
    this.deps.log({ step, result: 'enter' });
    if (this.step === 'connect' && step !== 'connect') this.dispose();
    this.step = step;
    this.enter(step);
  }

  private enter(step: SetupStep): void {
    this.stepTime = 0;
    this.passedAt = null;
    this.stableTime = 0;
    this.message = '';
    this.prevButtons = this.deps.source.rawButtons;
    if (step === 'buttons') {
      this.buttonTask = 'fire';
      this.learned = {};
    }
    if (step === 'connect') {
      this.pairing = 'idle';
      this.pairText = '';
      void this.deps.manager.autoConnect();
    }
    this.render();
  }

  private render(): void {
    const total = this.learnButtons ? 3 : 2;
    const num = { choose: 0, connect: 1, sensor: 2, buttons: 3 }[this.step];
    const head = (title: string) => [
      h('p', { class: 'sub' }, num > 0 ? `컨트롤러 설정 ${num}/${total}` : '컨트롤러 설정'),
      h('h2', {}, title),
    ];
    const mouseFallback = h('button', { onclick: () => this.deps.onDone('mouse') }, '마우스로 플레이');
    const back = h('button', { class: 'small', onclick: () => this.deps.onCancel() }, '메뉴로');
    let body: (Node | null)[];

    switch (this.step) {
      case 'choose': {
        const supported = this.deps.manager.supported;
        body = [
          ...head('어떻게 플레이할까요?'),
          h(
            'div',
            { class: 'buttons' },
            h(
              'button',
              { class: 'primary', disabled: !supported, onclick: () => this.goto('connect'), 'data-default': true },
              'Wii 총으로 플레이',
            ),
            mouseFallback,
          ),
          supported
            ? h('p', { class: 'sub' }, 'Wii 리모컨과 USB 센서바가 필요합니다. 처음 한 번만 연결 설정을 합니다.')
            : h('p', { class: 'bad' }, '이 브라우저에서는 Wii 리모컨을 직접 연결할 수 없습니다. Chrome 또는 Edge로 열어 주세요.'),
          h('div', { class: 'buttons' }, back),
        ];
        break;
      }
      case 'connect':
        if (this.deps.manager.canPair) {
          body = [
            ...head('Wii 리모컨 연결'),
            h('p', { class: 'setup-big' }, '리모컨 배터리 덮개를 열고 빨간 ', h('b', {}, 'SYNC'), ' 버튼을 누르세요.'),
            h(
              'p',
              { class: 'sub' },
              'LED가 깜박이는 동안 게임이 자동으로 등록하고 연결합니다. 영구 등록된 리모컨은 아무 버튼만 눌러도 연결됩니다.',
            ),
            this.status,
            h(
              'div',
              { class: 'buttons' },
              this.pairing === 'ended'
                ? h('button', { class: 'primary', onclick: () => void this.startPairing(), 'data-default': true }, '다시 찾기')
                : null,
              mouseFallback,
            ),
            h('div', { class: 'buttons' }, back),
          ];
          break;
        }
        body = [
          ...head('Wii 리모컨 연결'),
          this.status,
          h(
            'ol',
            {},
            h(
              'li',
              {},
              'Windows ',
              h('b', {}, '설정 → Bluetooth 및 장치 → 장치 추가 → Bluetooth'),
              '를 엽니다. ',
              h('a', { href: 'ms-settings:bluetooth', class: 'link' }, 'Bluetooth 설정 열기'),
            ),
            h('li', {}, '리모컨 배터리 칸 안의 빨간 ', h('b', {}, 'SYNC'), ' 버튼을 누릅니다. 리모컨 LED가 깜박입니다.'),
            h('li', {}, '목록에 나타난 ', h('b', {}, 'Nintendo RVL-CNT-01'), '을 선택합니다. PIN을 물으면 비워 둔 채 연결합니다.'),
            h('li', {}, '아래 ', h('b', {}, '리모컨 찾기'), '를 누르고, 브라우저 창에서 리모컨을 선택합니다.'),
          ),
          h('p', { class: 'sub' }, '이미 등록한 리모컨은 아무 버튼이나 누르면 자동으로 연결됩니다.'),
          h(
            'div',
            { class: 'buttons' },
            h('button', { class: 'primary', onclick: () => void this.find(), 'data-default': true }, '리모컨 찾기'),
            mouseFallback,
          ),
          h('div', { class: 'buttons' }, back),
        ];
        break;
      case 'sensor':
        this.hint.replaceChildren(
          h('b', {}, '센서바가 잡히지 않으면'),
          h(
            'ul',
            {},
            h('li', {}, '센서바 USB가 꽂혀 있는지 확인합니다(전원만 쓰므로 PC 인식 여부는 상관없습니다).'),
            h('li', {}, '센서바가 플레이어 쪽을 향하게 화면 위나 아래 가운데에 둡니다.'),
            h('li', {}, '화면에서 1~3m 떨어져 겨냥합니다. 너무 가까우면 두 점이 시야 밖으로 나갑니다.'),
            h('li', {}, '창문 햇빛·백열등처럼 강한 적외선이 화면 쪽에 있으면 가립니다.'),
          ),
        );
        this.hint.style.display = 'none';
        body = [
          ...head('센서바 확인'),
          h('p', {}, '평소 플레이할 자리에서 총을 화면 가운데로 향하세요. 노란 점 두 개가 보이면 자동으로 넘어갑니다.'),
          this.irCanvas,
          this.status,
          this.hint,
          h('div', { class: 'buttons' }, mouseFallback, back),
        ];
        break;
      case 'buttons':
        this.renderTasks();
        body = [
          ...head('버튼 확인'),
          h('p', {}, '안내에 따라 버튼을 눌러 주세요. 누른 버튼이 그 기능으로 설정됩니다.'),
          this.taskList,
          this.status,
          h('div', { class: 'buttons' }, back),
        ];
        this.status.className = 'setup-status';
        this.status.textContent = '';
        break;
    }
    this.el.replaceChildren(h('div', { class: 'panel setup' }, ...body));
  }

  private renderTasks(): void {
    const l = this.learned;
    const item = (task: ButtonTask, text: string, got?: WiimoteButtonName) =>
      h(
        'li',
        { class: got ? 'done' : this.buttonTask === task ? 'current' : '' },
        text,
        got ? h('span', { class: 'ok' }, ` ✓ ${BUTTON_LABELS[got]} 버튼`) : null,
      );
    this.taskList.replaceChildren(
      item('fire', '방아쇠를 당기세요 (발사)', l.fire),
      item('cover', '엄지로 누르기 쉬운 버튼을 누르세요 (엄폐·재장전, 보통 A)', l.cover),
      item('pause', '+ 버튼을 누르세요 (일시정지)', l.pause),
    );
  }

  private async find(): Promise<void> {
    if (this.searching) return;
    this.searching = true;
    const r = await this.deps.manager.request();
    this.searching = false;
    this.deps.log({ step: 'connect', request: r, error: this.deps.manager.lastError });
    if (r === 'cancelled') this.message = '선택한 리모컨이 없습니다. 목록에 리모컨이 없으면 위 1~3을 먼저 진행하세요.';
    else if (r !== 'connected') this.message = this.deps.manager.lastError || '리모컨을 연결하지 못했습니다.';
  }
}

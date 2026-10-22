import { Sfx } from '../audio/Sfx';
import { CalibrationSession, provisionalAim } from '../calibration/CalibrationSession';
import { CalibrationStore, CALIBRATION_VERSION, currentScreen, sameScreen } from '../calibration/CalibrationStore';
import { applyHomography, type Point } from '../calibration/homography';
import { GameSession, type GameEvent, type GameMode } from '../game/GameSession';
import { InputHub } from '../input/InputHub';
import { MouseKeyboardSource } from '../input/MouseKeyboardSource';
import type { InputFrame, InputSource, InputSourceId } from '../input/types';
import { WiimoteManager } from '../input/wiimote/WiimoteManager';
import { WiimoteSource } from '../input/WiimoteSource';
import { World } from '../rendering/World';
import { FREE_RANGE } from '../stage/freeRange';
import { STAGE1 } from '../stage/stage1';
import type { StageDef } from '../stage/types';
import { AccuracyCheck } from '../ui/AccuracyCheck';
import { CalibrationView } from '../ui/CalibrationView';
import { Crosshair } from '../ui/Crosshair';
import { Diagnostics } from '../ui/Diagnostics';
import { h } from '../ui/dom';
import { Hud } from '../ui/Hud';
import { Screens, type StatusInfo } from '../ui/Screens';
import { SetupWizard, type PlayDevice, type SetupStep } from '../ui/SetupWizard';
import { loadButtonMap } from '../input/wiimote/ButtonMap';

type AppState = 'title' | 'setup' | 'help' | 'calibrate' | 'accuracy' | 'playing' | 'ending' | 'paused' | 'result';
type AfterCalibration = 'play' | 'title' | 'paused';

/** 보정 전 Wii 기본 매핑 배율(센서바 두 점의 중점이 화면 중앙 부근을 움직이는 범위에 맞춘 근사값) */
const WIIMOTE_DEFAULT_GAIN = 2.2;
/** 화면 밖으로 이만큼 벗어나면 조준 신호 없음으로 본다 */
const OFFSCREEN_MARGIN = 0.03;
const RESULT_DELAY = 1.4;
const DEVICE_KEY = 'tgg.device';

function loadDevice(): PlayDevice | null {
  try {
    const v = localStorage.getItem(DEVICE_KEY);
    return v === 'wiimote' || v === 'mouse' ? v : null;
  } catch {
    return null;
  }
}

function saveDevice(d: PlayDevice): void {
  try {
    localStorage.setItem(DEVICE_KEY, d);
  } catch {
    // 저장 실패 시 다음 실행에서 다시 고른다.
  }
}

/** 전체 흐름: 시작 → (보정) → 전투 A·B·C → 결과, 그리고 일시정지·재시작 */
export class App {
  private readonly canvas = h('canvas', { id: 'game' });
  private readonly screensLayer = h('div', { id: 'screens', class: 'layer' });
  private readonly world: World;
  private readonly hud = new Hud();
  private readonly crosshair: Crosshair;
  private readonly calibView: CalibrationView;
  private readonly diag: Diagnostics;
  private readonly mouse: MouseKeyboardSource;
  private readonly wiimoteManager = new WiimoteManager();
  private readonly wiimote: WiimoteSource;
  private readonly hub: InputHub;
  private readonly store = new CalibrationStore();
  private readonly sfx = new Sfx();

  private state: AppState = 'title';
  private session: GameSession | null = null;
  private calib: { session: CalibrationSession; source: InputSource; then: AfterCalibration } | null = null;
  private setup: { wizard: SetupWizard; then: 'play' | 'title' } | null = null;
  private accuracy: { check: AccuracyCheck; source: InputSourceId } | null = null;
  private device: PlayDevice | null = loadDevice();
  private mode: GameMode = 'rail';
  private loadedStage: StageDef = STAGE1;
  private pauseReason = '';
  private endingTime = 0;
  private lastFrame = 0;
  private titleRefresh = 0;
  private hovered: Element | null = null;

  constructor(private readonly root: HTMLElement) {
    this.world = new World(this.canvas);
    this.world.loadStage(STAGE1);
    this.crosshair = new Crosshair(this.canvas);
    this.mouse = new MouseKeyboardSource(this.canvas);
    this.wiimote = new WiimoteSource(this.wiimoteManager);
    this.hub = new InputHub([this.mouse, this.wiimote], this.mapAim);
    if (this.device) this.hub.preference = this.device;
    this.calibView = new CalibrationView({
      retry: () => this.calib?.session.retryPoint(),
      restart: () => this.calib?.session.restart(),
      reset: () => {
        if (this.calib) this.store.clear(this.calib.source.id);
        this.calib?.session.restart();
      },
      cancel: () => this.endCalibration(false),
    });
    this.diag = new Diagnostics(this.hub, this.wiimote, this.canvas, () => this.calibrationSummary());

    root.append(this.canvas, this.hud.el, this.screensLayer, this.calibView.el, this.diag.el, this.crosshair.el);
  }

  start(): void {
    window.addEventListener('resize', () => this.world.resize());
    window.addEventListener('blur', () => this.pause('창 포커스를 잃어 일시정지했습니다.'));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pause('다른 탭으로 전환되어 일시정지했습니다.');
    });
    document.addEventListener('fullscreenchange', () => {
      this.world.resize();
      if (!document.fullscreenElement) this.pause('전체 화면이 해제되어 일시정지했습니다.');
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F3') {
        e.preventDefault();
        this.diag.toggle();
      }
    });
    this.wiimoteManager.onChange(() => {
      if (this.state === 'title') this.showTitle();
      if (this.wiimoteManager.availability === 'connected') this.wiimoteManager.device?.setLeds(0x1);
    });
    this.wiimoteManager.onDevice((d) => {
      if (!d && this.hub.activeSource()?.id === 'wiimote') this.pause('Wii 리모컨 연결이 끊겼습니다. 리모컨 버튼을 누르면 자동으로 다시 연결됩니다.');
    });
    void this.wiimoteManager.init();

    this.showTitle();
    this.lastFrame = performance.now();
    requestAnimationFrame(this.loop);
  }

  /** 개발 서버 전용 실물 확인 기록을 연결한다. */
  startHardwareLog(start: (m: WiimoteManager, s: WiimoteSource) => void): void {
    start(this.wiimoteManager, this.wiimote);
  }

  // ───────── 조준 좌표 변환 ─────────

  /** 장치 원본 좌표 → 게임 화면 좌표(0~1). 보정 프로필이 있으면 원근 변환을 쓴다. */
  private mapAim = (source: InputSourceId, raw: Point): Point | null => {
    const p = this.projectAim(source, raw);
    const m = OFFSCREEN_MARGIN;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < -m || p.x > 1 + m || p.y < -m || p.y > 1 + m) return null;
    return { x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) };
  };

  /** 화면 범위 확인 없이 원본 좌표를 화면 좌표로 옮긴다. */
  private projectAim(source: InputSourceId, raw: Point): Point {
    const profile = this.store.get(source);
    return profile ? applyHomography(profile.matrix, raw.x, raw.y) : this.defaultAim(source, raw);
  }

  /** 보정 값이 없을 때의 근사 매핑 */
  private defaultAim(source: InputSourceId, raw: Point): Point {
    if (source === 'wiimote')
      return { x: 0.5 + (raw.x - 0.5) * WIIMOTE_DEFAULT_GAIN, y: 0.5 + (raw.y - 0.5) * WIIMOTE_DEFAULT_GAIN };
    return raw;
  }

  private calibrationSummary(): string {
    const src = this.hub.activeSource()?.id ?? 'mouse';
    const p = this.store.get(src);
    if (!p) return `${src}: 없음`;
    const same = sameScreen(p.screen, currentScreen(this.canvas));
    return `${src}: 오차 ${(p.centerError * 100).toFixed(1)}%${same ? '' : ' (화면 변경됨)'}${this.store.persistent ? '' : ' · 저장 안 됨'}`;
  }

  // ───────── 메인 루프 ─────────

  private loop = (now: number): void => {
    const dt = Math.min(0.05, Math.max(0, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    const frame = this.hub.poll();

    switch (this.state) {
      case 'playing':
        this.updatePlaying(dt, frame);
        break;
      case 'ending':
        this.updateEnding(dt);
        break;
      case 'setup':
        this.setup!.wizard.update(dt);
        if (this.setup) this.updateMenu(dt, frame, this.setup.wizard.allowPointerClick);
        break;
      case 'accuracy':
        this.updateAccuracy(dt, frame);
        break;
      case 'calibrate':
        this.updateCalibration(dt, frame);
        this.world.render(dt, null);
        break;
      default:
        this.updateMenu(dt, frame);
        break;
    }

    this.diag.update(dt, frame);
    requestAnimationFrame(this.loop);
  };

  private updatePlaying(dt: number, frame: InputFrame): void {
    const s = this.session!;
    if (frame.pausePressed) {
      this.pause('');
      this.world.render(dt, s);
      return;
    }
    const events = s.step(dt, frame, this.world.resolveHit);
    for (const e of events) this.handleEvent(e);
    this.world.render(dt, s);
    const aimLost = frame.source === 'wiimote' && !frame.aim;
    this.hud.update(dt, s, aimLost);
    this.crosshair.update(frame.aim, s.phase !== 'travel');
    if (s.finished) {
      this.state = 'ending';
      this.endingTime = 0;
    }
  }

  private updateEnding(dt: number): void {
    const s = this.session!;
    this.endingTime += dt;
    this.world.render(dt, s);
    this.hud.update(dt, s, false);
    this.crosshair.update(null, false);
    if (this.endingTime >= RESULT_DELAY) this.showResult();
  }

  private updateMenu(dt: number, frame: InputFrame, allowClick = true): void {
    if (this.state === 'title' || this.state === 'setup') {
      this.world.setIdleView(STAGE1);
      this.world.render(dt, null);
      this.titleRefresh += dt;
      if (this.state === 'title' && this.titleRefresh > 1) this.showTitle();
    } else {
      this.world.render(dt, this.session);
    }

    // Wii 총으로 메뉴 조작: 조준점으로 버튼을 겨냥하고 방아쇠로 누른다.
    const usingWii = frame.source === 'wiimote';
    this.root.classList.toggle('hide-cursor', usingWii);
    this.crosshair.update(frame.aim, usingWii && allowClick);
    this.setHover(usingWii && allowClick && frame.aim ? this.elementAt(frame.aim) : null);
    for (const press of frame.firePresses) {
      if (allowClick && press.source === 'wiimote' && press.aim) {
        const el = this.elementAt(press.aim);
        if (el instanceof HTMLElement) {
          this.sfx.play('ui');
          el.click();
        }
      }
    }
    if (frame.pausePressed && this.state === 'paused') this.resume();
  }

  private elementAt(aim: Point): Element | null {
    const p = this.crosshair.clientPoint(aim);
    return document.elementFromPoint(p.x, p.y)?.closest('button, a, select, input') ?? null;
  }

  private setHover(el: Element | null): void {
    if (el === this.hovered) return;
    this.hovered?.classList.remove('hover');
    el?.classList.add('hover');
    this.hovered = el;
  }

  // ───────── 게임 이벤트 → 소리·효과·안내 ─────────

  private handleEvent(e: GameEvent): void {
    const s = this.session!;
    switch (e.type) {
      case 'shot':
        this.sfx.play('shot');
        this.crosshair.fired();
        break;
      case 'empty':
        this.sfx.play('empty');
        this.hud.toast('빈 탄창 — 엄폐 버튼을 누르고 있으면 재장전', 1.2, true);
        break;
      case 'blocked':
        if (e.reason === 'noAim') this.hud.toast('조준 신호 없음', 0.8, true);
        break;
      case 'hit':
        this.sfx.play(e.part === 'head' ? 'hitHead' : 'hitBody');
        if (e.killed) this.sfx.play('kill');
        this.crosshair.hit(e.part === 'head');
        this.world.addSpark(e.point, e.part === 'head' ? 0xffe14d : 0xffffff);
        if (e.part === 'head') this.hud.toast('머리 명중! +200', 0.7);
        break;
      case 'worldHit':
        this.sfx.play('wall');
        this.world.addBulletHole(e.point, e.normal);
        break;
      case 'coverStart':
        this.sfx.play('cover');
        break;
      case 'reloaded':
        this.sfx.play('reload');
        this.hud.toast('장전 완료', 0.8);
        break;
      case 'enemyWarn':
        this.sfx.play('warn');
        break;
      case 'enemyFire':
        this.sfx.play('enemyShot');
        this.world.enemyFired(e.enemyId);
        break;
      case 'damaged':
        this.sfx.play('damage');
        this.hud.damage();
        this.wiimote.device?.pulseRumble(180);
        break;
      case 'waveStart': {
        const p = s.stage.points[e.point];
        if (s.mode === 'free') {
          if (s.stats.shots > 0) this.hud.toast('표적을 다시 세웠습니다', 1.2);
          break;
        }
        this.hud.toast(p.waves.length > 1 ? `${p.name} — 웨이브 ${e.wave + 1}/${p.waves.length}` : p.name, 1.3);
        break;
      }
      case 'travelStart':
        this.hud.toast('다음 구역으로 이동 중', 2);
        break;
      case 'cleared':
        this.sfx.play('clear');
        this.hud.toast('스테이지 클리어!', 2);
        break;
      case 'failed':
        this.sfx.play('fail');
        this.hud.toast(e.reason === 'time' ? '시간 초과' : '임무 실패', 2, true);
        break;
      default:
        break;
    }
  }

  // ───────── 화면 전환 ─────────

  private setScreen(el: HTMLElement | null): void {
    this.hovered = null;
    this.screensLayer.replaceChildren(...(el ? [el] : []));
  }

  private showTitle(): void {
    this.state = 'title';
    this.useStage(STAGE1);
    this.titleRefresh = 0;
    this.mouse.captureGameKeys = false;
    this.hud.show(false);
    this.calibView.show(false);
    this.root.classList.remove('playing');
    this.setScreen(
      Screens.title(this.statusInfo(), {
        start: () => void this.startFlow('rail'),
        free: () => void this.startFlow('free'),
        setup: () => this.openSetup('choose', true, 'title'),
        calibrate: () => void this.beginCalibration('title'),
        accuracy: () => void this.openAccuracy(),
        help: () => this.showHelp(),
        diag: () => this.diag.toggle(),
      }),
    );
  }

  private showHelp(): void {
    this.state = 'help';
    this.setScreen(Screens.help({ back: () => this.showTitle() }));
  }

  private showResult(): void {
    const s = this.session!;
    this.hwlog('game-end', { outcome: s.phase, failReason: s.failReason, hp: s.hp, timeLeft: Math.round(s.timeLeft), device: this.device, ...s.stats });
    this.state = 'result';
    this.mouse.captureGameKeys = false;
    this.root.classList.remove('playing');
    this.crosshair.update(null, false);
    this.hud.show(false);
    this.setScreen(Screens.result(this.session!, { restart: () => void this.restart(), menu: () => this.showTitle() }));
  }

  private statusInfo(): StatusInfo {
    const m = this.wiimoteManager;
    const d = m.device;
    let wiimote: StatusInfo['wiimote'];
    if (m.availability === 'unsupported') wiimote = { text: '이 브라우저에서는 사용할 수 없음 (Chrome·Edge 필요)', tone: 'bad' };
    else if (m.availability === 'connecting') wiimote = { text: '연결 중…', tone: 'warn' };
    else if (d && d.state === 'ready') {
      const battery = d.batteryLevel === null ? '' : ` · 배터리 ${Math.round(d.batteryLevel * 100)}%`;
      const seen = performance.now() - d.lastDotsTime < 1500 && this.wiimote.ir.dotCount > 0;
      wiimote = {
        text: `연결됨 · ${d.model}${battery} · ${seen ? '센서바 감지됨' : '센서바 미감지 (화면 쪽으로 향하세요)'}`,
        tone: seen ? 'ok' : 'warn',
      };
    } else if (m.availability === 'error') wiimote = { text: m.lastError, tone: 'bad' };
    else wiimote = { text: m.lastError || '연결 안 됨 — 게임 시작 시 연결을 안내합니다', tone: 'warn' };

    const p = this.store.get('wiimote');
    let calibration: StatusInfo['calibration'];
    if (!p) calibration = { text: '아직 없음 — Wii로 시작하면 먼저 보정합니다', tone: 'warn' };
    else if (!sameScreen(p.screen, currentScreen(this.canvas)) && document.fullscreenElement)
      calibration = { text: '화면 조건이 바뀌었습니다 — 다시 보정하세요', tone: 'warn' };
    else calibration = { text: `저장됨 · 중앙 오차 ${(p.centerError * 100).toFixed(1)}%`, tone: 'ok' };
    if (!this.store.persistent) calibration.text += ' (브라우저 저장 불가 — 이번 실행에만 유지)';

    const device =
      this.device === 'wiimote' ? 'Wii 총' : this.device === 'mouse' ? '마우스' : '아직 선택 안 함 — 게임 시작 시 선택합니다';
    return { device, wiimote, calibration, audio: '' };
  }

  // ───────── 컨트롤러 설정 ─────────

  /** 게임 시작 전 컨트롤러 설정 마법사를 연다. */
  private openSetup(start: SetupStep, learnButtons: boolean, then: 'play' | 'title'): void {
    const wizard = new SetupWizard(
      {
        manager: this.wiimoteManager,
        source: this.wiimote,
        sfx: this.sfx,
        onDone: (d) => this.finishSetup(d),
        onCancel: () => {
          this.setup?.wizard.dispose();
          this.setup = null;
          this.showTitle();
        },
        log: (data) => this.hwlog('setup', data),
      },
      start,
      learnButtons,
    );
    this.setup = { wizard, then };
    this.state = 'setup';
    this.hud.show(false);
    this.setScreen(wizard.el);
  }

  private finishSetup(device: PlayDevice): void {
    const then = this.setup?.then ?? 'play';
    this.setup?.wizard.dispose();
    this.setup = null;
    this.device = device;
    saveDevice(device);
    this.hub.preference = device;
    if (then === 'title') {
      this.showTitle();
      return;
    }
    const p = this.store.get(device);
    if (device === 'wiimote' && (!p || !sameScreen(p.screen, currentScreen(this.canvas)))) void this.beginCalibration('play');
    else this.startGame();
  }

  // ───────── 시작·일시정지·재시작 ─────────

  /** 게임 시작: 실제 게임처럼 컨트롤러 확인을 거친다. 마우스를 고른 경우 바로 시작한다. */
  private async startFlow(mode: GameMode): Promise<void> {
    this.mode = mode;
    await this.prepareScreen();
    if (!this.device) this.openSetup('choose', true, 'play');
    else if (this.device === 'mouse') this.finishSetup('mouse');
    else this.openSetup(this.wiimote.connected ? 'sensor' : 'connect', !loadButtonMap(), 'play');
  }

  /**
   * 사용자 동작 안에서 소리를 켠다. 전체 화면은 요청하지 않는다(작업 표시줄이 보이는 창 모드로 실행).
   * 보정 값은 창 크기 조건과 함께 저장되므로 창 크기가 바뀌면 다시 보정을 요구한다.
   */
  private async prepareScreen(): Promise<void> {
    await this.sfx.unlock();
    this.world.resize();
  }

  private startGame(): void {
    const stage = this.mode === 'free' ? FREE_RANGE : STAGE1;
    this.useStage(stage);
    this.world.clearDynamic();
    this.session = new GameSession(stage, (Math.random() * 2 ** 31) | 0, this.mode);
    this.hub.reset();
    this.state = 'playing';
    this.mouse.captureGameKeys = true;
    this.root.classList.add('playing');
    this.root.classList.remove('hide-cursor');
    this.setScreen(null);
    // 다시 도전 시 첫 프레임에 이전 판의 체력·시간이 보이지 않게 바로 갱신한다.
    this.hud.update(0, this.session, false);
    this.hwlog('game-start', { mode: this.mode, device: this.device, preference: this.hub.preference, wiimote: this.wiimote.connected });
    this.hud.show(true);
    this.hud.toast(this.mode === 'free' ? '자유 이동 시험장 — 십자 버튼으로 이동' : stage.points[0].name, 1.6);
  }

  /** 모드를 바꿀 때만 장면을 다시 만든다. */
  private useStage(stage: StageDef): void {
    if (this.loadedStage === stage) return;
    this.world.clearDynamic();
    this.world.loadStage(stage);
    this.loadedStage = stage;
  }

  private async restart(): Promise<void> {
    await this.prepareScreen();
    this.startGame();
  }

  private pause(reason: string): void {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    this.pauseReason = reason;
    this.hwlog('pause', { reason, fireHeld: this.hub.sources.some((x) => x.isHeld('fire')), coverHeld: this.hub.sources.some((x) => x.isHeld('cover')) });
    this.hub.reset();
    this.mouse.captureGameKeys = false;
    this.root.classList.remove('playing');
    this.crosshair.update(null, false);
    const free = this.session?.mode === 'free';
    this.setScreen(
      Screens.paused(reason, {
        resume: () => this.resume(),
        restart: () => void this.restart(),
        calibrate: () => void this.beginCalibration('paused'),
        menu: () => this.showTitle(),
        resetTargets: free
          ? () => {
              this.session?.resetTargets();
              this.resume();
            }
          : undefined,
        toStart: free
          ? () => {
              this.session?.returnToStart();
              this.resume();
            }
          : undefined,
      }),
    );
  }

  private resume(): void {
    if (this.state !== 'paused' || !this.session) return;
    this.hwlog('resume', {});
    this.hub.reset();
    this.state = 'playing';
    this.pauseReason = '';
    this.mouse.captureGameKeys = true;
    this.root.classList.add('playing');
    this.setScreen(null);
  }

  // ───────── 정확도 측정 ─────────

  private async openAccuracy(): Promise<void> {
    await this.prepareScreen();
    const source = this.calibrationSource().id;
    const p = this.store.get(source);
    const check = new AccuracyCheck({
      wiimote: this.wiimote,
      source,
      calibration: p ? `중앙 오차 ${(p.centerError * 100).toFixed(1)}%` : source === 'wiimote' ? '없음 — 먼저 조준 보정을 하세요' : '없음(마우스는 보정 없이 정확)',
      screen: () => {
        const r = this.canvas.getBoundingClientRect();
        return { width: r.width, height: r.height };
      },
      log: (kind, data) => this.hwlog(kind, data),
      exit: () => this.closeAccuracy(),
      sound: (name) => this.sfx.play(name),
    });
    this.accuracy = { check, source };
    this.state = 'accuracy';
    this.hub.reset();
    this.mouse.captureGameKeys = true;
    this.hud.show(false);
    this.setScreen(check.el);
  }

  private updateAccuracy(dt: number, frame: InputFrame): void {
    const { check, source } = this.accuracy!;
    if (check.menuMode) {
      check.update(frame, []);
      if (this.accuracy) this.updateMenu(dt, frame);
      return;
    }
    if (frame.pausePressed) {
      this.closeAccuracy();
      return;
    }
    const presses = frame.firePresses.filter((p) => p.source === source);
    check.update(frame, presses);
    this.world.render(dt, null);
    this.root.classList.toggle('hide-cursor', source === 'wiimote');
    this.crosshair.update(frame.aim, check.showCrosshair && frame.source === source);
  }

  private closeAccuracy(): void {
    this.accuracy = null;
    this.hub.reset();
    this.root.classList.remove('hide-cursor');
    this.showTitle();
  }

  /** 실물 확인 기록(hw-check.log)에 한 줄 남긴다. 기록 모듈이 없으면 무시된다. */
  private hwlog(kind: string, data: Record<string, unknown>): void {
    window.dispatchEvent(new CustomEvent('tgg-hwlog', { detail: { kind, ...data } }));
  }

  // ───────── 보정 ─────────

  private calibrationSource(): InputSource {
    if (this.hub.preference !== 'auto') return this.hub.sources.find((s) => s.id === this.hub.preference)!;
    return this.wiimote.connected ? this.wiimote : this.mouse;
  }

  private async beginCalibration(then: AfterCalibration): Promise<void> {
    if (then !== 'paused') await this.prepareScreen();
    const r = this.canvas.getBoundingClientRect();
    this.calib = {
      session: new CalibrationSession({ width: r.width, height: r.height }),
      source: this.calibrationSource(),
      then,
    };
    this.hub.reset();
    this.state = 'calibrate';
    this.mouse.captureGameKeys = true;
    this.setScreen(null);
    this.hud.show(false);
    this.crosshair.update(null, false);
    this.root.classList.add('hide-cursor');
    this.calibView.show(true);
  }

  private updateCalibration(dt: number, frame: InputFrame): void {
    const c = this.calib!;
    // 마우스로 보정 화면의 버튼을 누른 클릭은 측정으로 치지 않는다.
    const presses = frame.firePresses.filter(
      (p) => p.source === c.source.id && !(p.source === 'mouse' && p.aim && this.elementAt(p.aim)),
    );
    if (frame.pausePressed) {
      this.endCalibration(false);
      return;
    }
    if (c.session.phase === 'failed') {
      if (presses.length > 0) c.session.restart();
    } else {
      c.session.update(dt, c.source.rawAim, presses.length > 0);
    }
    // 지금 가리키는 곳을 보여 준다. 새 보정은 이전 보정 값 대신 기본 매핑에서 시작해 측정한 점으로 바로잡는다.
    const raw = c.source.rawAim;
    const shown = raw ? provisionalAim(c.session.measured, raw, (p) => this.defaultAim(c.source.id, p)) : null;
    this.crosshair.update(
      shown && { x: Math.min(1, Math.max(0, shown.x)), y: Math.min(1, Math.max(0, shown.y)) },
      c.source.id === 'wiimote',
    );
    this.calibView.update(c.session, c.source.id, {
      hasSignal: raw !== null,
      ir: this.wiimote.ir,
      dots: this.wiimote.device?.dots,
    });
    if (c.session.phase === 'done') this.endCalibration(true);
  }

  private endCalibration(success: boolean): void {
    const c = this.calib;
    if (!c) return;
    if (success && c.session.outcome) {
      this.store.set({
        version: CALIBRATION_VERSION,
        source: c.source.id,
        matrix: c.session.outcome.matrix,
        screen: currentScreen(this.canvas),
        centerError: c.session.outcome.centerError,
        createdAt: new Date().toISOString(),
      });
      this.hwlog('calibration', { source: c.source.id, centerError: c.session.outcome.centerError, screen: currentScreen(this.canvas) });
      this.sfx.play('reload');
    }
    this.calib = null;
    this.calibView.show(false);
    this.root.classList.remove('hide-cursor');
    this.hub.reset();
    if (c.then === 'play' && success) this.startGame();
    else if (c.then === 'paused' && this.session) {
      this.state = 'playing';
      this.pause(success ? '보정을 저장했습니다.' : this.pauseReason);
    } else this.showTitle();
  }
}

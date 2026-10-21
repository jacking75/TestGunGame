import type { Point } from '../../src/calibration/homography';
import type { PairProgress } from '../../src/input/wiimote/hid';
import { WiimoteManager } from '../../src/input/wiimote/WiimoteManager';
import { WiimoteSource } from '../../src/input/WiimoteSource';

export type Tracking = 'pair' | 'single' | 'none';

/** 검증 단계가 보는 총 입력. 실물(Wii)과 리모컨 없는 흐름 확인용(마우스)을 같은 모양으로 다룬다. */
export interface Pad {
  readonly connected: boolean;
  /** 연결 진행 상황 한 줄 */
  readonly status: string;
  /** 모델·배터리 한 줄 */
  readonly info: string;
  /** 원본 조준 좌표(IR 카메라 기준 0~1). 신호가 없으면 null */
  readonly raw: Point | null;
  readonly tracking: Tracking;
  readonly dotCount: number;
  readonly fireHeld: boolean;
  readonly coverHeld: boolean;
  readonly homeHeld: boolean;
  readonly anyHeld: boolean;
  readonly reportsPerSec: number;
  /** 지난 호출 이후 방아쇠를 새로 당긴 순간들의 원본 조준 좌표 */
  takeFires(): (Point | null)[];
  update(dt: number): void;
}

/** 등록된 리모컨이 스스로 연결될 여유를 준 뒤 앱 안 등록을 시작한다 */
const PAIR_START_DELAY = 1.5;
const PAIR_SECONDS = 120;
const PAIR_RETRY_DELAY = 3;

const PAIR_TEXT: Record<string, (p: PairProgress) => string> = {
  radio: () => '블루투스 준비됨 — 리모컨을 찾는 중…',
  searching: () => '리모컨을 찾는 중…',
  found: (p) => `리모컨 발견 — 등록 중 (${p.attempt}번째 시도)`,
  'waiting-remembered': () => '등록된 리모컨이 있습니다 — 리모컨의 아무 버튼이나 누르세요.',
  retry: (p) => p.message,
  're-register': () => '이전 등록 정보를 정리하고 다시 등록합니다…',
  paired: (p) => (p.permanent ? '등록 완료 — 연결하는 중…' : '임시 연결 — 연결하는 중…'),
  already: () => '등록된 리모컨 — 연결하는 중…',
  'no-radio': (p) => p.message,
};

export class WiiPad implements Pad {
  readonly manager = new WiimoteManager();
  readonly source = new WiimoteSource(this.manager);
  reportsPerSec = 0;
  private pairing: 'idle' | 'running' | 'waiting' = 'idle';
  private pairText = '';
  private idleTime = 0;
  private lastReports = 0;
  private rateTime = 0;

  constructor(private readonly log: (kind: string, data: Record<string, unknown>) => void) {
    void this.manager.init();
    this.manager.onChange(() => {
      this.log('availability', { availability: this.manager.availability, error: this.manager.lastError });
      if (this.manager.availability === 'connected') this.manager.device?.setLeds(0x1);
    });
  }

  get connected(): boolean {
    return this.source.connected;
  }

  get status(): string {
    const m = this.manager;
    if (this.connected) return '연결됨';
    if (m.availability === 'unsupported') return '이 환경에서는 리모컨을 쓸 수 없습니다(검증 앱 실행 파일로 실행하세요).';
    if (m.availability === 'connecting') return '리모컨을 여는 중…';
    return this.pairText || m.lastError || '리모컨을 찾는 중…';
  }

  get info(): string {
    const d = this.manager.device;
    if (!d) return '';
    return `${d.model}${d.batteryLevel === null ? '' : ` · 배터리 ${Math.round(d.batteryLevel * 100)}%`}`;
  }

  get raw(): Point | null {
    return this.connected ? this.source.rawAim : null;
  }

  get tracking(): Tracking {
    return this.connected ? this.source.ir.tracking : 'none';
  }

  get dotCount(): number {
    return this.connected ? this.source.ir.dotCount : 0;
  }

  get fireHeld(): boolean {
    return this.source.isHeld('fire');
  }

  get coverHeld(): boolean {
    return this.source.isHeld('cover');
  }

  get homeHeld(): boolean {
    return this.connected && this.source.rawButtons.home;
  }

  get anyHeld(): boolean {
    return this.connected && Object.values(this.source.rawButtons).some(Boolean);
  }

  takeFires(): (Point | null)[] {
    this.source.takePresses('cover');
    this.source.takePresses('pause');
    return this.source.takePresses('fire');
  }

  update(dt: number): void {
    const d = this.manager.device;
    this.rateTime += dt;
    if (this.rateTime >= 1) {
      this.reportsPerSec = d ? d.reportCount - this.lastReports : 0;
      this.lastReports = d?.reportCount ?? 0;
      this.rateTime = 0;
    }
    if (this.connected) {
      this.idleTime = 0;
      return;
    }
    this.idleTime += dt;
    if (this.manager.canPair && this.pairing === 'idle' && this.idleTime >= PAIR_START_DELAY) void this.startPairing();
  }

  private async startPairing(): Promise<void> {
    this.pairing = 'running';
    const r = await this.manager.pair(PAIR_SECONDS, (p) => {
      const f = PAIR_TEXT[p.stage];
      if (f) this.pairText = f(p);
      this.log('pair', { ...p });
    });
    this.log('pair', { result: r });
    if (r === 'paired' || r === 'already') {
      // 연결은 관리자의 자동 재시도가 맡는다. 등록 직후 Windows가 HID 장치를 만드는 데 몇 초 걸린다.
      this.pairText = '등록 완료 — 연결하는 중…';
    } else {
      this.pairText =
        r === 'no-radio'
          ? 'PC 블루투스를 찾지 못했습니다. 블루투스를 켜 주세요.'
          : '리모컨을 찾지 못했습니다. 리모컨 버튼(처음이면 SYNC)을 다시 누르세요.';
    }
    // 연결되지 않았으면 잠시 뒤 다시 찾는다. 사용자가 다시 누를 버튼은 없다.
    this.pairing = 'waiting';
    setTimeout(() => {
      this.pairing = 'idle';
      this.idleTime = PAIR_START_DELAY;
    }, PAIR_RETRY_DELAY * 1000);
  }
}

/**
 * 리모컨 없이 흐름을 확인하는 가짜 총(자동 검증용, ?sim=1).
 * 마우스 위치 = 조준, 왼쪽 버튼 = 방아쇠, 오른쪽 버튼 = 엄폐(A), H = HOME, K = 센서바 가림 전환.
 */
export class SimPad implements Pad {
  readonly status = '모의 입력';
  readonly info = '모의 리모컨(마우스)';
  readonly reportsPerSec = 100;
  private mouse: Point = { x: 0.5, y: 0.5 };
  private covered = false;
  private fire = false;
  private cover = false;
  private home = false;
  private fires: (Point | null)[] = [];
  private time = 0;

  constructor() {
    window.addEventListener('mousemove', (e) => (this.mouse = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }));
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousedown', (e) => {
      // mousemove는 화면 갱신에 맞춰 늦게 올 수 있으므로 눌린 순간의 위치를 직접 쓴다.
      this.mouse = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight };
      if (e.button === 0) {
        this.fire = true;
        this.fires.push(this.raw && { ...this.raw });
      } else if (e.button === 2) this.cover = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fire = false;
      else if (e.button === 2) this.cover = false;
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyH') this.home = true;
      if (e.code === 'KeyK' && !e.repeat) this.covered = !this.covered;
    });
    window.addEventListener('keyup', (e) => {
      if (e.code === 'KeyH') this.home = false;
    });
  }

  get connected(): boolean {
    return this.time > 0.3;
  }
  get raw(): Point | null {
    return this.connected && !this.covered ? this.mouse : null;
  }
  get tracking(): Tracking {
    return this.raw ? 'pair' : 'none';
  }
  get dotCount(): number {
    return this.raw ? 2 : 0;
  }
  get fireHeld(): boolean {
    return this.fire;
  }
  get coverHeld(): boolean {
    return this.cover;
  }
  get homeHeld(): boolean {
    return this.home;
  }
  get anyHeld(): boolean {
    return this.fire || this.cover || this.home;
  }
  takeFires(): (Point | null)[] {
    const f = this.fires;
    this.fires = [];
    return f;
  }
  update(dt: number): void {
    this.time += dt;
  }
}

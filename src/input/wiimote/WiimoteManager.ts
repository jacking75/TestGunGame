import { createHidProvider, type HidLike, type HidProvider, type PairProgress, type PairResult } from './hid';
import { WiimoteDevice } from './WiimoteDevice';

export type WiimoteAvailability =
  | 'unsupported' // 장치 접근 수단이 없다(WebHID 미지원 브라우저)
  | 'idle' // 연결된 리모컨이 없다
  | 'connecting'
  | 'connected'
  | 'error';

/** 연결이 안 된 동안 자동 재시도 간격(게임 실행 파일) */
const RETRY_MS = 2000;

/**
 * 리모컨 찾기·연결·재연결·등록을 맡는다.
 * - 게임 실행 파일: 블루투스 등록부터 게임 안에서 처리하고, 등록된 리모컨이 보이면 자동으로 연다.
 * - 일반 브라우저: 처음 한 번 장치 선택 창에서 허용한 뒤 자동으로 연다.
 * 후보가 여럿이면 흔한 순서(정품 ID → 이름 → 제조사)로 시도해 열리는 장치를 쓴다.
 */
export class WiimoteManager {
  device: WiimoteDevice | null = null;
  availability: WiimoteAvailability;
  lastError = '';
  readonly provider: HidProvider;
  private changeListeners = new Set<() => void>();
  private deviceListeners = new Set<(d: WiimoteDevice | null) => void>();
  private opening = false;

  constructor(provider: HidProvider = createHidProvider()) {
    this.provider = provider;
    this.availability = provider.kind === 'none' ? 'unsupported' : 'idle';
  }

  get supported(): boolean {
    return this.availability !== 'unsupported';
  }

  get canPair(): boolean {
    return this.provider.canPair;
  }

  onChange(fn: () => void): void {
    this.changeListeners.add(fn);
  }

  onDevice(fn: (d: WiimoteDevice | null) => void): void {
    this.deviceListeners.add(fn);
  }

  async init(): Promise<void> {
    if (!this.supported) return;
    this.provider.onConnect(() => {
      if (!this.device) void this.autoConnect();
    });
    this.provider.onDisconnect((d) => {
      if (this.device && this.device.hid === d) void this.drop('리모컨 연결이 끊겼습니다');
    });
    if (this.provider.kind === 'host') {
      setInterval(() => {
        if (!this.device) void this.autoConnect();
      }, RETRY_MS);
    }
    await this.autoConnect();
  }

  /** 쓸 수 있는 리모컨이 있으면 연다. */
  async autoConnect(): Promise<boolean> {
    if (this.device) return true;
    if (!this.supported || this.opening) return false;
    return this.openFirst(await this.provider.getDevices());
  }

  /** 사용자 동작(클릭) 안에서 호출한다. 일반 브라우저에서는 장치 선택 창이 뜬다. */
  async request(): Promise<'connected' | 'cancelled' | 'failed' | 'unsupported'> {
    if (!this.supported) return 'unsupported';
    if (await this.autoConnect()) return 'connected';
    let picked: HidLike[];
    try {
      picked = await this.provider.requestDevice();
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return 'failed';
    }
    if (picked.length === 0) return 'cancelled';
    return (await this.openFirst(picked)) ? 'connected' : 'failed';
  }

  /** 게임 안 블루투스 등록(게임 실행 파일에서만 가능). 등록 후 자동 연결은 init()의 재시도가 맡는다. */
  pair(seconds: number, onProgress: (p: PairProgress) => void): Promise<PairResult> {
    return this.provider.pair(seconds, onProgress);
  }

  cancelPair(): void {
    this.provider.cancelPair();
  }

  async disconnect(): Promise<void> {
    await this.drop('');
  }

  private async openFirst(candidates: HidLike[]): Promise<boolean> {
    if (this.opening) return false;
    this.opening = true;
    try {
      for (const d of candidates) {
        if (await this.open(d)) return true;
      }
      return false;
    } finally {
      this.opening = false;
    }
  }

  private async open(hid: HidLike): Promise<boolean> {
    if (this.device) await this.drop('');
    const dev = new WiimoteDevice(hid);
    this.device = dev;
    this.setAvailability('connecting');
    this.emitDevice();
    try {
      await dev.start();
      this.lastError = '';
      this.setAvailability('connected');
      return true;
    } catch (e) {
      this.lastError = describeOpenError(e);
      await dev.close();
      if (this.device === dev) this.device = null;
      this.setAvailability('error');
      this.emitDevice();
      return false;
    }
  }

  private async drop(reason: string): Promise<void> {
    const dev = this.device;
    if (!dev) return;
    this.device = null;
    await dev.close();
    this.lastError = reason;
    this.setAvailability('idle');
    this.emitDevice();
  }

  private setAvailability(a: WiimoteAvailability): void {
    this.availability = a;
    for (const fn of this.changeListeners) fn();
  }

  private emitDevice(): void {
    for (const fn of this.deviceListeners) fn(this.device);
  }
}

function describeOpenError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/open|열 수/i.test(msg)) {
    return '리모컨을 열 수 없습니다. 리모컨을 사용하는 다른 프로그램(Dolphin 등)을 종료해 주세요.';
  }
  if (/sendReport|write|전송/i.test(msg)) {
    return '리모컨이 응답하지 않습니다. 리모컨의 아무 버튼이나 눌러 깨워 주세요.';
  }
  return `리모컨 연결 실패: ${msg}`;
}

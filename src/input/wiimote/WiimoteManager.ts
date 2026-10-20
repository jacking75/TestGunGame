import { WIIMOTE_FILTERS, isWiimote } from './protocol';
import { WiimoteDevice } from './WiimoteDevice';

export type WiimoteAvailability =
  | 'unsupported' // 브라우저에 WebHID가 없다
  | 'idle' // 허용된 리모컨이 없다
  | 'connecting'
  | 'connected'
  | 'error';

/**
 * 리모컨 찾기·연결·재연결을 맡는다.
 * 1) 시작 시 이전에 허용한 리모컨을 자동으로 연다.
 * 2) 리모컨 전원이 다시 켜지면(브라우저 connect 이벤트) 자동으로 다시 연다.
 * 3) 처음 한 번은 사용자가 버튼을 눌러 브라우저 장치 선택 창에서 허용해야 한다(WebHID 규칙).
 */
export class WiimoteManager {
  device: WiimoteDevice | null = null;
  availability: WiimoteAvailability;
  lastError = '';
  private changeListeners = new Set<() => void>();
  private deviceListeners = new Set<(d: WiimoteDevice | null) => void>();

  constructor() {
    this.availability = navigator.hid ? 'idle' : 'unsupported';
  }

  get supported(): boolean {
    return this.availability !== 'unsupported';
  }

  onChange(fn: () => void): void {
    this.changeListeners.add(fn);
  }

  onDevice(fn: (d: WiimoteDevice | null) => void): void {
    this.deviceListeners.add(fn);
  }

  async init(): Promise<void> {
    const hid = navigator.hid;
    if (!hid) return;
    hid.addEventListener('connect', (ev) => {
      if (isWiimote(ev.device) && !this.device) void this.open(ev.device);
    });
    hid.addEventListener('disconnect', (ev) => {
      if (this.device && this.device.hid === ev.device) void this.drop('리모컨 연결이 끊겼습니다');
    });
    await this.autoConnect();
  }

  /** 이미 허용된 리모컨이 있으면 연다. 없으면 false. */
  async autoConnect(): Promise<boolean> {
    const hid = navigator.hid;
    if (!hid || this.device) return !!this.device;
    const devices = (await hid.getDevices()).filter(isWiimote);
    for (const d of devices) {
      if (await this.open(d)) return true;
    }
    return false;
  }

  /** 사용자 동작(클릭) 안에서 호출한다. 선택 창에서 리모컨을 고르면 연결한다. */
  async request(): Promise<'connected' | 'cancelled' | 'failed' | 'unsupported'> {
    const hid = navigator.hid;
    if (!hid) return 'unsupported';
    if (await this.autoConnect()) return 'connected';
    let picked: HIDDevice[];
    try {
      picked = await hid.requestDevice({ filters: WIIMOTE_FILTERS });
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      return 'failed';
    }
    if (picked.length === 0) return 'cancelled';
    for (const d of picked) {
      if (await this.open(d)) return 'connected';
    }
    return 'failed';
  }

  async disconnect(): Promise<void> {
    await this.drop('');
  }

  private async open(hid: HIDDevice): Promise<boolean> {
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
  if (/open/i.test(msg)) {
    return '리모컨을 열 수 없습니다. Dolphin 등 리모컨을 사용하는 다른 프로그램을 종료한 뒤 다시 시도하세요.';
  }
  if (/sendReport|write/i.test(msg)) {
    return '리모컨에 설정을 보내지 못했습니다. 리모컨 전원을 껐다 켠 뒤 다시 시도하세요.';
  }
  return `리모컨 연결 실패: ${msg}`;
}

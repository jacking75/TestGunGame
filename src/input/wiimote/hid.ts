import { host, type Host } from '../../platform/host';
import { NINTENDO_VENDOR_ID, WIIMOTE_PRODUCT_IDS } from './protocol';

export type InputReportListener = (ev: { reportId: number; data: DataView }) => void;

/** WebHID의 HIDDevice와 같은 모양. 실행 환경(브라우저·게임 실행 파일)에 따라 구현이 다르다. */
export interface HidLike {
  readonly opened: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
  addEventListener(type: 'inputreport', listener: InputReportListener): void;
  removeEventListener(type: 'inputreport', listener: InputReportListener): void;
}

export type PairResult = 'paired' | 'already' | 'timeout' | 'cancelled' | 'no-radio' | 'error';

export interface PairProgress {
  stage: string;
  message: string;
  [key: string]: unknown;
}

export interface HidProvider {
  readonly kind: 'host' | 'webhid' | 'none';
  /** 게임 안에서 블루투스 등록까지 할 수 있는지(게임 실행 파일에서만 가능) */
  readonly canPair: boolean;
  /** 사용자 선택 없이 쓸 수 있는 리모컨 후보(흔한 순서로 정렬) */
  getDevices(): Promise<HidLike[]>;
  /** 처음 허용(WebHID 장치 선택 창). 게임 실행 파일에서는 getDevices와 같다. */
  requestDevice(): Promise<HidLike[]>;
  onConnect(fn: (d: HidLike) => void): void;
  onDisconnect(fn: (d: HidLike) => void): void;
  pair(seconds: number, onProgress: (p: PairProgress) => void): Promise<PairResult>;
  cancelPair(): void;
}

/**
 * 리모컨 후보 순위. 특정 기기만 받지 않고 흔한 순서로 넓힌다.
 * 1: 정품 VID/PID, 2: 이름에 RVL-CNT·Wii Remote, 3: Nintendo VID의 다른 PID. 0이면 후보 아님.
 */
export function wiimoteRank(d: { vendorId: number; productId: number; productName: string }): number {
  const name = d.productName ?? '';
  if (/RVL-WBC|balance/i.test(name)) return 0;
  if (d.vendorId === NINTENDO_VENDOR_ID && (WIIMOTE_PRODUCT_IDS as readonly number[]).includes(d.productId)) return 1;
  if (/RVL-CNT|wii ?remote|wiimote/i.test(name)) return 2;
  if (d.vendorId === NINTENDO_VENDOR_ID && !/pro controller|joy-con|switch/i.test(name)) return 3;
  return 0;
}

export function sortCandidates<T extends { vendorId: number; productId: number; productName: string }>(list: T[]): T[] {
  return list.filter((d) => wiimoteRank(d) > 0).sort((a, b) => wiimoteRank(a) - wiimoteRank(b));
}

// ───────── 일반 브라우저: WebHID ─────────

class WebHidProvider implements HidProvider {
  readonly kind = 'webhid' as const;
  readonly canPair = false;
  constructor(private readonly hid: HID) {}

  async getDevices(): Promise<HidLike[]> {
    return sortCandidates(await this.hid.getDevices()) as HidLike[];
  }
  async requestDevice(): Promise<HidLike[]> {
    // 호환품까지 고를 수 있도록 Nintendo 제조사 전체를 보여 준다.
    const picked = await this.hid.requestDevice({ filters: [{ vendorId: NINTENDO_VENDOR_ID }] });
    return sortCandidates(picked) as HidLike[];
  }
  onConnect(fn: (d: HidLike) => void): void {
    this.hid.addEventListener('connect', (e) => {
      if (wiimoteRank(e.device) > 0) fn(e.device as HidLike);
    });
  }
  onDisconnect(fn: (d: HidLike) => void): void {
    this.hid.addEventListener('disconnect', (e) => fn(e.device as HidLike));
  }
  async pair(): Promise<PairResult> {
    return 'error';
  }
  cancelPair(): void {}
}

// ───────── 게임 실행 파일: C# 호스트 ─────────

interface HostHidInfo {
  path: string;
  vendorId: number;
  productId: number;
  productName: string;
}

class HostHidDevice implements HidLike {
  opened = false;
  handle = 0;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  private listeners = new Set<InputReportListener>();

  constructor(
    private readonly host: Host,
    readonly info: HostHidInfo,
    private readonly onClosed: (d: HostHidDevice) => void,
  ) {
    this.vendorId = info.vendorId;
    this.productId = info.productId;
    this.productName = info.productName;
    host.on('hid.report', (m) => {
      if (m.handle !== this.handle) return;
      const data = new Uint8Array(m.data as number[]);
      const ev = { reportId: m.reportId as number, data: new DataView(data.buffer) };
      for (const fn of this.listeners) fn(ev);
    });
    host.on('hid.closed', (m) => {
      if (m.handle !== this.handle) return;
      this.opened = false;
      this.handle = 0;
      this.onClosed(this);
    });
  }

  async open(): Promise<void> {
    if (this.opened) return;
    const r = await this.host.call<{ handle: number }>('hid.open', { path: this.info.path });
    this.handle = r.handle;
    this.opened = true;
  }

  async close(): Promise<void> {
    if (!this.opened) return;
    const h = this.handle;
    this.opened = false;
    this.handle = 0;
    await this.host.call('hid.close', { handle: h });
  }

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    if (!this.opened) throw new Error('sendReport: 장치가 열려 있지 않습니다');
    const bytes =
      data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    await this.host.call('hid.write', { handle: this.handle, reportId, data: Array.from(bytes) });
  }

  addEventListener(_type: 'inputreport', fn: InputReportListener): void {
    this.listeners.add(fn);
  }
  removeEventListener(_type: 'inputreport', fn: InputReportListener): void {
    this.listeners.delete(fn);
  }
}

/** 게임 실행 파일에서는 장치 선택 창이 없다. 1초마다 목록을 확인해 연결·해제를 알린다. */
class HostHidProvider implements HidProvider {
  readonly kind = 'host' as const;
  readonly canPair = true;
  private devices = new Map<string, HostHidDevice>();
  private connectFns = new Set<(d: HidLike) => void>();
  private disconnectFns = new Set<(d: HidLike) => void>();

  constructor(private readonly host: Host) {
    setInterval(() => void this.refresh(), 1000);
  }

  private async refresh(): Promise<HostHidDevice[]> {
    let list: HostHidInfo[];
    try {
      list = sortCandidates(await this.host.call<HostHidInfo[]>('hid.list'));
    } catch {
      return [...this.devices.values()];
    }
    const seen = new Set(list.map((d) => d.path));
    for (const info of list) {
      if (this.devices.has(info.path)) continue;
      const dev = new HostHidDevice(this.host, info, (d) => this.disconnectFns.forEach((fn) => fn(d)));
      this.devices.set(info.path, dev);
      this.connectFns.forEach((fn) => fn(dev));
    }
    for (const [path, dev] of this.devices) {
      if (seen.has(path)) continue;
      this.devices.delete(path);
      this.disconnectFns.forEach((fn) => fn(dev));
    }
    return list.map((i) => this.devices.get(i.path)!);
  }

  getDevices(): Promise<HidLike[]> {
    return this.refresh();
  }
  requestDevice(): Promise<HidLike[]> {
    return this.refresh();
  }
  onConnect(fn: (d: HidLike) => void): void {
    this.connectFns.add(fn);
  }
  onDisconnect(fn: (d: HidLike) => void): void {
    this.disconnectFns.add(fn);
  }

  async pair(seconds: number, onProgress: (p: PairProgress) => void): Promise<PairResult> {
    const off = this.host.on('bt.progress', (m) => onProgress(m as unknown as PairProgress));
    try {
      const r = await this.host.call<string>('bt.pair', { seconds });
      return (r.startsWith('error') ? 'error' : r) as PairResult;
    } finally {
      off();
    }
  }
  cancelPair(): void {
    void this.host.call('bt.cancel').catch(() => undefined);
  }
}

class NoHidProvider implements HidProvider {
  readonly kind = 'none' as const;
  readonly canPair = false;
  async getDevices(): Promise<HidLike[]> {
    return [];
  }
  async requestDevice(): Promise<HidLike[]> {
    return [];
  }
  onConnect(): void {}
  onDisconnect(): void {}
  async pair(): Promise<PairResult> {
    return 'error';
  }
  cancelPair(): void {}
}

export function createHidProvider(): HidProvider {
  if (host) return new HostHidProvider(host);
  if (navigator.hid) return new WebHidProvider(navigator.hid);
  return new NoHidProvider();
}

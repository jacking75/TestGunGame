import {
  DATA_MODE,
  InReport,
  IR_MODE_EXTENDED,
  IR_REG,
  IR_SENSITIVITIES,
  NO_BUTTONS,
  OutReport,
  modelName,
  parseAck,
  parseButtons,
  parseIrExtended,
  parseStatus,
  writeRegisterPayload,
  type IrDot,
  type WiimoteButtons,
} from './protocol';

export type WiimoteState = 'connecting' | 'ready' | 'error' | 'closed';

export interface WiimoteReport {
  time: number;
  buttons: WiimoteButtons;
  dots: IrDot[];
}

const ACK_TIMEOUT_MS = 400;
/** 연결 후 이 시간 동안 IR 점이 하나도 안 보이면 다음 감도 설정으로 바꾼다. */
const SENSITIVITY_RETRY_MS = 4000;
const SENSITIVITY_KEY = 'tgg.wiimote.irSensitivity';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** WebHID로 연 Wii 리모컨 한 대. 초기화·IR 설정·보고서 해석·진동·LED를 담당한다. */
export class WiimoteDevice {
  state: WiimoteState = 'connecting';
  error = '';
  readonly model: string;
  buttons: WiimoteButtons = NO_BUTTONS;
  dots: IrDot[] = [];
  batteryLevel: number | null = null;
  batteryLow = false;
  lastReportTime = 0;
  lastDotsTime = 0;
  sensitivityIndex = 0;
  reportCount = 0;

  private rumble = false;
  private leds = 0x1;
  private rumbleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingAck: { report: number; resolve: (ok: boolean) => void } | null = null;
  private listeners = new Set<(r: WiimoteReport) => void>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private initializing = false;
  private savedSensitivity = -1;

  constructor(readonly hid: HIDDevice) {
    this.model = modelName(hid.productId);
    this.sensitivityIndex = loadSensitivity();
  }

  onReport(fn: (r: WiimoteReport) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async start(): Promise<void> {
    this.state = 'connecting';
    try {
      if (!this.hid.opened) await this.hid.open();
      this.hid.addEventListener('inputreport', this.handleReport);
      await this.setLeds(this.leds);
      await this.initIr();
      await this.send(OutReport.StatusRequest, [0x00]);
      this.state = 'ready';
      this.lastDotsTime = performance.now();
      this.watchdog = setInterval(this.checkIr, 1000);
    } catch (e) {
      this.state = 'error';
      this.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async close(): Promise<void> {
    this.state = 'closed';
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.rumbleTimer) clearTimeout(this.rumbleTimer);
    this.hid.removeEventListener('inputreport', this.handleReport);
    try {
      if (this.hid.opened) await this.hid.close();
    } catch {
      // 이미 끊긴 장치는 닫기도 실패할 수 있다.
    }
  }

  /** 진동을 잠깐 켠다(피격 피드백). */
  pulseRumble(ms: number): void {
    if (this.state !== 'ready') return;
    this.rumble = true;
    void this.send(OutReport.Leds, [this.leds << 4]);
    if (this.rumbleTimer) clearTimeout(this.rumbleTimer);
    this.rumbleTimer = setTimeout(() => {
      this.rumble = false;
      void this.send(OutReport.Leds, [this.leds << 4]);
    }, ms);
  }

  async setLeds(mask: number): Promise<void> {
    this.leds = mask & 0x0f;
    await this.send(OutReport.Leds, [this.leds << 4]);
  }

  get sensitivityName(): string {
    return IR_SENSITIVITIES[this.sensitivityIndex].name;
  }

  /** IR 카메라를 켜고 확장 모드로 설정한 뒤 연속 보고 모드를 요청한다. */
  private async initIr(): Promise<void> {
    this.initializing = true;
    try {
      const s = IR_SENSITIVITIES[this.sensitivityIndex];
      await this.send(OutReport.IrEnable, [0x04]);
      await sleep(20);
      await this.send(OutReport.IrEnable2, [0x04]);
      await sleep(20);
      await this.writeRegister(IR_REG.Control, [0x08]);
      await this.writeRegister(IR_REG.Sensitivity1, s.block1);
      await this.writeRegister(IR_REG.Sensitivity2, s.block2);
      await this.writeRegister(IR_REG.Mode, [IR_MODE_EXTENDED]);
      await this.writeRegister(IR_REG.Control, [0x08]);
      await this.setReportMode();
    } finally {
      this.initializing = false;
    }
  }

  private setReportMode(): Promise<void> {
    // 0x04: 변화가 없어도 계속 보고(조준 좌표를 끊김 없이 받기 위해)
    return this.send(OutReport.ReportMode, [0x04, DATA_MODE]);
  }

  private async writeRegister(address: number, values: readonly number[]): Promise<void> {
    const ack = this.waitAck(OutReport.WriteMemory);
    await this.hid.sendReport(OutReport.WriteMemory, withRumble(writeRegisterPayload(address, values), this.rumble));
    // 일부 호환품은 확인 보고서를 보내지 않으므로 시간 초과는 오류로 보지 않는다.
    await ack;
    await sleep(10);
  }

  private waitAck(report: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingAck?.report === report) this.pendingAck = null;
        resolve(false);
      }, ACK_TIMEOUT_MS);
      this.pendingAck = {
        report,
        resolve: (ok) => {
          clearTimeout(timer);
          resolve(ok);
        },
      };
    });
  }

  private send(report: number, data: number[]): Promise<void> {
    const bytes = new Uint8Array(data);
    return this.hid.sendReport(report, withRumble(bytes, this.rumble));
  }

  private checkIr = (): void => {
    if (this.state !== 'ready' || this.initializing) return;
    const now = performance.now();
    if (now - this.lastDotsTime < SENSITIVITY_RETRY_MS) return;
    // 센서바가 꺼져 있거나 감도가 맞지 않는 경우: 다음 설정으로 자동 전환한다.
    this.sensitivityIndex = (this.sensitivityIndex + 1) % IR_SENSITIVITIES.length;
    this.lastDotsTime = now;
    void this.initIr().catch(() => undefined);
  };

  private handleReport = (ev: HIDInputReportEvent): void => {
    const data = new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
    const now = performance.now();
    this.lastReportTime = now;
    this.reportCount++;
    if (data.length >= 2) this.buttons = parseButtons(data[0], data[1]);

    switch (ev.reportId) {
      case InReport.Status: {
        const st = parseStatus(data);
        this.batteryLevel = st.batteryLevel;
        this.batteryLow = st.batteryLow;
        // 상태 보고서를 받으면 리모컨이 보고 모드를 버튼 전용으로 되돌리므로 다시 설정한다.
        if (!this.initializing) void this.setReportMode().catch(() => undefined);
        break;
      }
      case InReport.Ack: {
        const ack = parseAck(data);
        if (this.pendingAck && this.pendingAck.report === ack.report) {
          const p = this.pendingAck;
          this.pendingAck = null;
          p.resolve(ack.error === 0);
        }
        break;
      }
      case InReport.ButtonsAccelIr12: {
        this.dots = parseIrExtended(data, 5);
        if (this.dots.length > 0) {
          if (this.savedSensitivity !== this.sensitivityIndex) {
            saveSensitivity(this.sensitivityIndex);
            this.savedSensitivity = this.sensitivityIndex;
          }
          this.lastDotsTime = now;
        }
        break;
      }
      default:
        break;
    }

    const report: WiimoteReport = { time: now, buttons: this.buttons, dots: this.dots };
    for (const fn of this.listeners) fn(report);
  };
}

function withRumble(bytes: Uint8Array<ArrayBuffer>, rumble: boolean): Uint8Array<ArrayBuffer> {
  if (rumble) bytes[0] |= 0x01;
  else bytes[0] &= 0xfe;
  return bytes;
}

function loadSensitivity(): number {
  try {
    const v = Number(localStorage.getItem(SENSITIVITY_KEY));
    return Number.isInteger(v) && v >= 0 && v < IR_SENSITIVITIES.length ? v : 0;
  } catch {
    return 0;
  }
}

function saveSensitivity(index: number): void {
  try {
    localStorage.setItem(SENSITIVITY_KEY, String(index));
  } catch {
    // 저장 실패 시 다음 실행에서 기본값부터 다시 찾는다.
  }
}

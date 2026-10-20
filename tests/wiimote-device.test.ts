import { afterEach, describe, expect, it } from 'vitest';
import { WiimoteDevice } from '../src/input/wiimote/WiimoteDevice';
import { WiimoteSource } from '../src/input/WiimoteSource';
import type { WiimoteManager } from '../src/input/wiimote/WiimoteManager';

/** 레지스터 쓰기에 확인 보고서로 답하는 가짜 리모컨 */
class FakeHid extends EventTarget {
  opened = false;
  vendorId = 0x057e;
  productId = 0x0306;
  productName = 'Nintendo RVL-CNT-01';
  sent: { id: number; data: number[] }[] = [];

  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  async sendReport(id: number, data: BufferSource) {
    const bytes = [...new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer)];
    this.sent.push({ id, data: bytes });
    if (id === 0x16) queueMicrotask(() => this.input(0x22, [0, 0, 0x16, 0]));
  }
  input(reportId: number, data: number[]) {
    const ev = new Event('inputreport') as Event & { reportId: number; data: DataView; device: unknown };
    Object.assign(ev, { reportId, data: new DataView(new Uint8Array(data).buffer), device: this });
    this.dispatchEvent(ev);
  }
}

/** 버튼 2바이트 + 가속도 3바이트 + 확장 IR 12바이트 */
function report33(b1: number, dots: { x: number; y: number }[]): number[] {
  const ir = new Array(12).fill(0xff);
  dots.forEach((d, i) => {
    ir[i * 3] = d.x & 0xff;
    ir[i * 3 + 1] = d.y & 0xff;
    ir[i * 3 + 2] = (((d.y >> 8) & 3) << 6) | (((d.x >> 8) & 3) << 4) | 3;
  });
  return [0, b1, 0x80, 0x80, 0x80, ...ir];
}

const PAIR = [
  { x: 400, y: 380 },
  { x: 620, y: 380 },
];

let device: WiimoteDevice | null = null;
afterEach(async () => {
  await device?.close();
  device = null;
});

async function connected() {
  const hid = new FakeHid();
  device = new WiimoteDevice(hid as unknown as HIDDevice);
  let onDevice: (d: WiimoteDevice | null) => void = () => {};
  const manager = {
    get device() {
      return device;
    },
    onDevice: (fn: typeof onDevice) => (onDevice = fn),
  } as unknown as WiimoteManager;
  const source = new WiimoteSource(manager);
  await device.start();
  onDevice(device);
  return { hid, source };
}

describe('WebHID 리모컨 연결', () => {
  it('IR 카메라를 확장 모드로 켜고 연속 보고 모드를 요청한다', async () => {
    const { hid } = await connected();
    expect(device!.state).toBe('ready');
    const ids = hid.sent.map((s) => s.id);
    expect(ids).toContain(0x13);
    expect(ids).toContain(0x1a);
    const writes = hid.sent.filter((s) => s.id === 0x16).map((s) => s.data.slice(1, 6));
    expect(writes).toContainEqual([0xb0, 0x00, 0x33, 0x01, 0x03]); // IR 확장 모드
    expect(hid.sent.at(-2)).toEqual({ id: 0x12, data: [0x04, 0x33] });
  });

  it('센서바 두 점이 보이면 조준 좌표가 생기고, 사라지면 신호 없음이 된다', async () => {
    const { hid, source } = await connected();
    hid.input(0x33, report33(0, PAIR));
    expect(source.rawAim).not.toBeNull();
    expect(source.ir.tracking).toBe('pair');
    hid.input(0x33, report33(0, []));
    expect(source.rawAim).toBeNull();
  });

  it('방아쇠(B)를 누르고 있어도 눌림은 한 번만 기록되고, 눌린 순간의 조준을 담는다', async () => {
    const { hid, source } = await connected();
    hid.input(0x33, report33(0, PAIR));
    hid.input(0x33, report33(0x04, PAIR));
    for (let i = 0; i < 10; i++) hid.input(0x33, report33(0x04, PAIR));
    const presses = source.takePresses('fire');
    expect(presses).toHaveLength(1);
    expect(presses[0]).not.toBeNull();
    expect(source.isHeld('fire')).toBe(true);
    hid.input(0x33, report33(0, PAIR));
    expect(source.isHeld('fire')).toBe(false);
  });

  it('상태 보고서를 받으면 배터리를 읽고 보고 모드를 다시 설정한다', async () => {
    const { hid } = await connected();
    const before = hid.sent.length;
    hid.input(0x20, [0, 0, 0x10, 0, 0, 0x64]);
    await Promise.resolve();
    expect(device!.batteryLevel).toBeCloseTo(0.5, 2);
    expect(hid.sent.slice(before)).toContainEqual({ id: 0x12, data: [0x04, 0x33] });
  });
});

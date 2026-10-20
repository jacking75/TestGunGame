// Wii 리모컨 HID 프로토콜. 보고서 번호와 바이트 배치는 WiiBrew 문서 기준이다.
// WebHID의 sendReport/inputreport는 보고서 번호를 별도로 다루므로 아래 data에는 보고서 번호가 없다.

export const NINTENDO_VENDOR_ID = 0x057e;
/** RVL-CNT-01(구형), RVL-CNT-01-TR(MotionPlus 내장형). 모델을 사용자에게 묻지 않고 둘 다 받는다. */
export const WIIMOTE_PRODUCT_IDS = [0x0306, 0x0330] as const;

export const WIIMOTE_FILTERS: HIDDeviceFilter[] = WIIMOTE_PRODUCT_IDS.map((productId) => ({
  vendorId: NINTENDO_VENDOR_ID,
  productId,
}));

export function isWiimote(device: { vendorId: number; productId: number }): boolean {
  return (
    device.vendorId === NINTENDO_VENDOR_ID &&
    (WIIMOTE_PRODUCT_IDS as readonly number[]).includes(device.productId)
  );
}

export function modelName(productId: number): string {
  return productId === 0x0330 ? 'RVL-CNT-01-TR' : 'RVL-CNT-01';
}

export const OutReport = {
  Leds: 0x11,
  ReportMode: 0x12,
  IrEnable: 0x13,
  StatusRequest: 0x15,
  WriteMemory: 0x16,
  IrEnable2: 0x1a,
} as const;

export const InReport = {
  Status: 0x20,
  ReadData: 0x21,
  Ack: 0x22,
  ButtonsAccelIr12: 0x33,
} as const;

/** 버튼 + 가속도 + 확장 IR(12바이트) 모드. 센서바 점 4개의 위치와 크기를 받는다. */
export const DATA_MODE = InReport.ButtonsAccelIr12;
export const IR_MODE_EXTENDED = 0x03;

export interface WiimoteButtons {
  left: boolean;
  right: boolean;
  down: boolean;
  up: boolean;
  plus: boolean;
  two: boolean;
  one: boolean;
  b: boolean;
  a: boolean;
  minus: boolean;
  home: boolean;
}

export const NO_BUTTONS: WiimoteButtons = Object.freeze({
  left: false,
  right: false,
  down: false,
  up: false,
  plus: false,
  two: false,
  one: false,
  b: false,
  a: false,
  minus: false,
  home: false,
});

/** 모든 입력 보고서(0x20~0x3f)의 앞 2바이트는 버튼이다. */
export function parseButtons(b0: number, b1: number): WiimoteButtons {
  return {
    left: (b0 & 0x01) !== 0,
    right: (b0 & 0x02) !== 0,
    down: (b0 & 0x04) !== 0,
    up: (b0 & 0x08) !== 0,
    plus: (b0 & 0x10) !== 0,
    two: (b1 & 0x01) !== 0,
    one: (b1 & 0x02) !== 0,
    b: (b1 & 0x04) !== 0,
    a: (b1 & 0x08) !== 0,
    minus: (b1 & 0x10) !== 0,
    home: (b1 & 0x80) !== 0,
  };
}

/** IR 카메라 좌표: x 0~1023, y 0~767. size는 점 크기(0~15). */
export interface IrDot {
  x: number;
  y: number;
  size: number;
}

export const IR_WIDTH = 1024;
export const IR_HEIGHT = 768;

/** 확장 IR 형식 12바이트(점 4개 × 3바이트)를 해석한다. 보이지 않는 점(0x3ff)은 제외한다. */
export function parseIrExtended(bytes: ArrayLike<number>, offset = 0): IrDot[] {
  const dots: IrDot[] = [];
  for (let i = 0; i < 4; i++) {
    const b0 = bytes[offset + i * 3];
    const b1 = bytes[offset + i * 3 + 1];
    const b2 = bytes[offset + i * 3 + 2];
    const x = b0 | (((b2 >> 4) & 0x03) << 8);
    const y = b1 | (((b2 >> 6) & 0x03) << 8);
    if (x >= 1023 && y >= 1023) continue;
    if (x >= IR_WIDTH || y >= IR_HEIGHT) continue;
    dots.push({ x, y, size: b2 & 0x0f });
  }
  return dots;
}

export interface WiimoteStatus {
  batteryLevel: number; // 0~1
  batteryLow: boolean;
  extensionConnected: boolean;
}

/** 상태 보고서(0x20): BB BB LF 00 00 VV */
export function parseStatus(data: ArrayLike<number>): WiimoteStatus {
  const flags = data[2];
  return {
    batteryLow: (flags & 0x01) !== 0,
    extensionConnected: (flags & 0x02) !== 0,
    batteryLevel: Math.min(1, data[5] / 0xc8),
  };
}

/** 확인 보고서(0x22): BB BB RR EE */
export function parseAck(data: ArrayLike<number>): { report: number; error: number } {
  return { report: data[2], error: data[3] };
}

/** 레지스터 쓰기(0x16) 데이터. 최대 16바이트. */
export function writeRegisterPayload(address: number, values: readonly number[], rumble = false): Uint8Array<ArrayBuffer> {
  if (values.length < 1 || values.length > 16) throw new RangeError('레지스터 쓰기는 1~16바이트');
  const out = new Uint8Array(21);
  out[0] = 0x04 | (rumble ? 1 : 0);
  out[1] = (address >> 16) & 0xff;
  out[2] = (address >> 8) & 0xff;
  out[3] = address & 0xff;
  out[4] = values.length;
  out.set(values, 5);
  return out;
}

/** IR 감도 설정. 센서바·조명마다 잘 맞는 값이 달라 자동으로 바꿔 가며 시도한다. */
export interface IrSensitivity {
  name: string;
  block1: readonly number[]; // 0xb00000, 9바이트
  block2: readonly number[]; // 0xb0001a, 2바이트
}

export const IR_SENSITIVITIES: readonly IrSensitivity[] = [
  { name: 'Wii 레벨 3', block1: [0x02, 0x00, 0x00, 0x71, 0x01, 0x00, 0xaa, 0x00, 0x64], block2: [0x63, 0x03] },
  { name: '높은 감도', block1: [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x90, 0x00, 0xc0], block2: [0x40, 0x00] },
  { name: 'Wii 레벨 5', block1: [0x07, 0x00, 0x00, 0x71, 0x01, 0x00, 0x72, 0x00, 0x20], block2: [0x1f, 0x03] },
  { name: 'Wii 레벨 1', block1: [0x02, 0x00, 0x00, 0x71, 0x01, 0x00, 0x64, 0x00, 0xfe], block2: [0xfd, 0x05] },
];

export const IR_REG = {
  Control: 0xb00030,
  Sensitivity1: 0xb00000,
  Sensitivity2: 0xb0001a,
  Mode: 0xb00033,
} as const;

import { describe, expect, it } from 'vitest';
import { IrPointer } from '../src/input/wiimote/IrPointer';
import { isWiimote, parseButtons, parseIrExtended, writeRegisterPayload } from '../src/input/wiimote/protocol';

describe('Wii 리모컨 프로토콜', () => {
  it('확장 IR 형식의 상위 비트를 올바르게 합친다', () => {
    // x=0x2AB(683), y=0x1CD(461), size=5 → b2 = (y>>8)<<6 | (x>>8)<<4 | 5 = 0x40|0x20|5
    const bytes = [0xab, 0xcd, 0x65, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    expect(parseIrExtended(bytes)).toEqual([{ x: 683, y: 461, size: 5 }]);
  });

  it('방아쇠(B)와 A 버튼 비트를 구분한다', () => {
    expect(parseButtons(0, 0x04).b).toBe(true);
    expect(parseButtons(0, 0x04).a).toBe(false);
    expect(parseButtons(0, 0x08).a).toBe(true);
    expect(parseButtons(0x10, 0x80)).toMatchObject({ plus: true, home: true });
  });

  it('레지스터 쓰기는 21바이트이며 주소·길이·값 위치가 고정이다', () => {
    const p = writeRegisterPayload(0xb00030, [0x08]);
    expect(p.length).toBe(21);
    expect([...p.slice(0, 6)]).toEqual([0x04, 0xb0, 0x00, 0x30, 0x01, 0x08]);
  });

  it('구형·TR 모델을 모두 인식하고 다른 장치는 제외한다', () => {
    expect(isWiimote({ vendorId: 0x057e, productId: 0x0306 })).toBe(true);
    expect(isWiimote({ vendorId: 0x057e, productId: 0x0330 })).toBe(true);
    expect(isWiimote({ vendorId: 0x057e, productId: 0x2009 })).toBe(false);
  });
});

describe('IR 조준 계산', () => {
  it('리모컨을 비틀어도 같은 곳을 가리키면 좌표가 같다', () => {
    const level = new IrPointer().update([
      { x: 412, y: 384, size: 3 },
      { x: 612, y: 384, size: 3 },
    ]);
    // 중심(512,384) 기준으로 30° 회전한 두 점
    const a = (30 * Math.PI) / 180;
    const rot = (x: number, y: number) => ({
      x: 512 + (x - 512) * Math.cos(a) - (y - 384) * Math.sin(a),
      y: 384 + (x - 512) * Math.sin(a) + (y - 384) * Math.cos(a),
      size: 3,
    });
    const rolled = new IrPointer().update([rot(412, 384), rot(612, 384)]);
    expect(rolled.x).toBeCloseTo(level.x, 6);
    expect(rolled.y).toBeCloseTo(level.y, 6);
  });

  it('한 점이 시야 밖으로 나가도 직전 간격으로 중점을 추정한다', () => {
    const p = new IrPointer();
    const pair = p.update([
      { x: 100, y: 300, size: 3 },
      { x: 300, y: 300, size: 3 },
    ]);
    const single = p.update([{ x: 300, y: 300, size: 3 }]);
    expect(single.tracking).toBe('single');
    expect(single.x).toBeCloseTo(pair.x, 6);
  });

  it('점이 없으면 추적 없음으로 보고한다', () => {
    expect(new IrPointer().update([]).tracking).toBe('none');
  });
});

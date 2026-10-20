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

  it('한쪽 끝이 카메라 시야 밖으로 나가면 기억한 간격으로 중점을 추정한다', () => {
    const p = new IrPointer();
    p.update([
      { x: 40, y: 300, size: 3 },
      { x: 240, y: 300, size: 3 },
    ]);
    // 총을 오른쪽으로 돌려 두 끝이 왼쪽으로 100px 이동: 왼쪽 끝(-60)은 시야 밖, 오른쪽 끝(140)만 보인다.
    const single = p.update([{ x: 140, y: 300, size: 3 }]);
    const expected = new IrPointer().update([
      { x: 0, y: 300, size: 3 },
      { x: 80, y: 300, size: 3 },
    ]); // 중점 40
    expect(single.tracking).toBe('single');
    expect(single.x).toBeCloseTo(expected.x, 6);
  });

  it('가까이서 한쪽 끝 LED가 여러 점으로 보여도 양 끝 두 묶음으로 계산한다(실측 배치)', async () => {
    const { clusterDots } = await import('../src/input/wiimote/IrPointer');
    // 2026-10-20 실측: 왼쪽 끝 3점, 오른쪽 끝 1점
    const dots = [
      { x: 43, y: 417, size: 1 },
      { x: 770, y: 437, size: 4 },
      { x: 85, y: 422, size: 2 },
      { x: 124, y: 414, size: 2 },
    ];
    const ends = clusterDots(dots);
    expect(ends).toHaveLength(2);
    const r = new IrPointer().update(dots);
    expect(r.tracking).toBe('pair');
    // 두 끝의 중점 근처(카메라 x ≈ 430)를 가리켜야 한다. 같은 끝의 두 점을 고르면 x ≈ 0.9 부근으로 튄다.
    expect(r.x).toBeGreaterThan(0.5);
    expect(r.x).toBeLessThan(0.65);
  });

  it('점이 없으면 추적 없음으로 보고한다', () => {
    expect(new IrPointer().update([]).tracking).toBe('none');
  });
});

describe('호환품 대응', () => {
  it('기본 IR 형식(점 2개씩 5바이트)을 해석한다', async () => {
    const { parseIrBasic } = await import('../src/input/wiimote/protocol');
    // 점1 (683, 461), 점2 (300, 200): hi = y1hi<<6 | x1hi<<4 | y2hi<<2 | x2hi = 1<<6 | 2<<4 | 0<<2 | 1
    const bytes = [0xab, 0xcd, 0x61, 0x2c, 0xc8, 0xff, 0xff, 0xff, 0xff, 0xff];
    expect(parseIrBasic(bytes)).toEqual([
      { x: 683, y: 461, size: 3 },
      { x: 300, y: 200, size: 3 },
    ]);
  });

  it('리모컨 후보는 정품 ID → 이름 → 제조사 순서이며 밸런스 보드·스위치 컨트롤러는 제외한다', async () => {
    const { sortCandidates } = await import('../src/input/wiimote/hid');
    const list = [
      { vendorId: 0x057e, productId: 0x2009, productName: 'Pro Controller' },
      { vendorId: 0x1234, productId: 0x0001, productName: 'Nintendo RVL-CNT-01' },
      { vendorId: 0x057e, productId: 0x0306, productName: 'Nintendo RVL-WBC-01' },
      { vendorId: 0x057e, productId: 0x0999, productName: '' },
      { vendorId: 0x057e, productId: 0x0330, productName: 'Nintendo RVL-CNT-01-TR' },
    ];
    expect(sortCandidates(list).map((d) => d.productId)).toEqual([0x0330, 0x0001, 0x0999]);
  });
});

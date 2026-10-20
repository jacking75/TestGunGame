import { host } from '../platform/host';
import type { WiimoteManager } from '../input/wiimote/WiimoteManager';
import type { WiimoteSource } from '../input/WiimoteSource';

/**
 * 개발 서버 전용 실물 확인 기록. 연결 상태 변화·오류·버튼 눌림은 즉시, IR·배터리 요약은 1초마다 보낸다.
 */
export function startHardwareLog(manager: WiimoteManager, source: WiimoteSource): void {
  const send = (kind: string, data: Record<string, unknown>) => {
    const line = JSON.stringify({ t: new Date().toISOString(), kind, ...data });
    void fetch('/__hwlog', { method: 'POST', body: line }).catch(() => undefined);
  };

  send('page', { provider: manager.provider.kind, canPair: manager.canPair, hid: !!navigator.hid, ua: navigator.userAgent });
  // 게임 실행 파일: 필터 전 전체 HID 목록(장치 열거가 되는지, 호환품 이름이 무엇인지 확인용)
  void host
    ?.call<{ vendorId: number; productId: number; productName: string }[]>('hid.list')
    .then((all) => send('hid-all', { count: all.length, devices: all.map((d) => `${d.vendorId.toString(16)}:${d.productId.toString(16)} ${d.productName}`) }));
  void manager.provider.getDevices().then((list) =>
    send('candidates', { list: list.map((d) => ({ vendorId: d.vendorId, productId: d.productId, productName: d.productName })) }),
  );
  // 컨트롤러 설정 단계 결과
  window.addEventListener('tgg-hwlog', (e) => {
    const { kind, ...data } = (e as CustomEvent<Record<string, unknown>>).detail;
    send(String(kind), data);
  });
  manager.onChange(() => send('availability', { availability: manager.availability, error: manager.lastError }));

  let lastButtons = '';
  let lastReports = 0;
  setInterval(() => {
    const d = manager.device;
    const pressed = d ? Object.entries(d.buttons).filter(([, v]) => v).map(([k]) => k).join('+') : '';
    if (pressed !== lastButtons) {
      send('buttons', { pressed: pressed || '(none)' });
      lastButtons = pressed;
    }
  }, 50);
  setInterval(() => {
    const d = manager.device;
    if (!d) return;
    const rate = d.reportCount - lastReports;
    lastReports = d.reportCount;
    send('status', {
      state: d.state,
      model: d.model,
      productName: d.hid.productName,
      battery: d.batteryLevel,
      reportsPerSec: rate,
      sensitivity: d.sensitivityName,
      dots: d.dots,
      tracking: source.ir.tracking,
      aim: source.rawAim,
      error: d.error,
    });
  }, 1000);
}

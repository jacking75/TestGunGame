import type { WiimoteButtons } from './protocol';

export type WiimoteButtonName = keyof WiimoteButtons;

/** 게임 기능별로 쓸 리모컨 버튼. 설정 단계에서 실제로 눌린 버튼을 학습한다. */
export interface ButtonMap {
  fire: WiimoteButtonName;
  cover: WiimoteButtonName;
}

/** 일반적인 Wii 건 외장: 방아쇠가 B를 누르고, 엄지로 A를 누른다. */
export const DEFAULT_BUTTON_MAP: ButtonMap = { fire: 'b', cover: 'a' };

export const BUTTON_LABELS: Record<WiimoteButtonName, string> = {
  a: 'A',
  b: 'B',
  one: '1',
  two: '2',
  plus: '+',
  minus: '−',
  home: 'HOME',
  up: '십자 위',
  down: '십자 아래',
  left: '십자 왼쪽',
  right: '십자 오른쪽',
};

/** 일시정지는 학습하지 않고 +/−/HOME 중 발사·엄폐에 쓰이지 않은 버튼으로 한다. */
export const PAUSE_BUTTONS: readonly WiimoteButtonName[] = ['plus', 'minus', 'home'];

const KEY = 'tgg.wiimote.buttons';
const NAMES = Object.keys(BUTTON_LABELS) as WiimoteButtonName[];

export function loadButtonMap(): ButtonMap | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as ButtonMap;
    return NAMES.includes(m.fire) && NAMES.includes(m.cover) && m.fire !== m.cover ? m : null;
  } catch {
    return null;
  }
}

export function saveButtonMap(map: ButtonMap): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // 저장 실패 시 이번 실행에만 쓴다.
  }
}

/** 이전 상태에서 새로 눌린 버튼 목록 */
export function newlyPressed(prev: WiimoteButtons, next: WiimoteButtons): WiimoteButtonName[] {
  return NAMES.filter((n) => next[n] && !prev[n]);
}

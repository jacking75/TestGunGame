import type { Point } from '../calibration/homography';
import type { Action, FirePress, InputFrame, InputSource, InputSourceId } from './types';

/** 원본 좌표 → 게임 화면 좌표. 화면 밖을 가리키면 null */
export type AimMapper = (source: InputSourceId, raw: Point) => Point | null;
export type SourcePreference = 'auto' | InputSourceId;

const ACTIONS: Action[] = ['fire', 'cover', 'pause'];

/**
 * 여러 입력 장치를 하나의 의미 입력으로 합친다.
 * - 조준: 가장 최근에 사용한 장치(또는 고정 선택)의 좌표를 보정해 쓴다.
 * - 버튼: 어느 장치든 누르면 동작한다.
 * - reset() 이후에는 이미 누르고 있던 버튼을 한 번 놓기 전까지 무시한다(포커스 복귀 시 오발사·엄폐 고착 방지).
 */
export class InputHub {
  preference: SourcePreference = 'auto';
  private armed = new Map<InputSourceId, Set<Action>>();

  constructor(
    readonly sources: readonly InputSource[],
    private readonly mapAim: AimMapper,
  ) {
    for (const s of sources) this.armed.set(s.id, new Set(ACTIONS));
  }

  activeSource(): InputSource | null {
    if (this.preference !== 'auto') return this.sources.find((s) => s.id === this.preference) ?? null;
    let best: InputSource | null = null;
    for (const s of this.sources) if (!best || s.lastActivity > best.lastActivity) best = s;
    return best;
  }

  /** 눌림 상태·대기 중인 눌림을 버리고, 누르고 있는 버튼은 놓을 때까지 무시한다. */
  reset(): void {
    for (const s of this.sources) {
      s.reset();
      const armed = this.armed.get(s.id)!;
      armed.clear();
      for (const a of ACTIONS) if (!s.isHeld(a)) armed.add(a);
    }
  }

  poll(): InputFrame {
    const active = this.activeSource();
    const rawAim = active?.rawAim ?? null;
    const aim = active && rawAim ? this.mapAim(active.id, rawAim) : null;

    const firePresses: FirePress[] = [];
    let pausePressed = false;
    let fireHeld = false;
    let coverHeld = false;

    for (const s of this.sources) {
      const armed = this.armed.get(s.id)!;
      for (const a of ACTIONS) if (!s.isHeld(a)) armed.add(a);

      const fires = s.takePresses('fire');
      for (const raw of fires) firePresses.push({ source: s.id, aim: raw ? this.mapAim(s.id, raw) : null });
      if (fires.length > 0) armed.add('fire');
      if (s.takePresses('pause').length > 0) {
        pausePressed = true;
        armed.add('pause');
      }
      if (s.takePresses('cover').length > 0) armed.add('cover');

      if (armed.has('fire') && s.isHeld('fire')) fireHeld = true;
      if (armed.has('cover') && s.isHeld('cover')) coverHeld = true;
    }

    return {
      source: active?.id ?? null,
      aim,
      rawAim,
      firePresses,
      fireHeld,
      coverHeld,
      pausePressed,
      move: active?.move ?? { x: 0, y: 0 },
    };
  }
}

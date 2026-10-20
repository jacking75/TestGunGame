import type { InputSourceId } from '../input/types';
import type { Homography } from './homography';

export const CALIBRATION_VERSION = 1;
const STORAGE_KEY = 'tgg.calibration';

/** 보정했을 때의 화면 조건. 하나라도 달라지면 재확인을 요구한다. */
export interface ScreenCondition {
  width: number;
  height: number;
  dpr: number;
  fullscreen: boolean;
  screenWidth: number;
  screenHeight: number;
}

export interface CalibrationProfile {
  version: number;
  source: InputSourceId;
  /** 입력 원본 좌표 → 게임 화면 정규화 좌표 */
  matrix: Homography;
  screen: ScreenCondition;
  /** 중앙 확인점 오차(화면 짧은 변 대비 비율) */
  centerError: number;
  createdAt: string;
}

type StoredData = { version: number; profiles: Partial<Record<InputSourceId, CalibrationProfile>> };

export function currentScreen(canvas: HTMLElement): ScreenCondition {
  const r = canvas.getBoundingClientRect();
  return {
    width: Math.round(r.width),
    height: Math.round(r.height),
    dpr: window.devicePixelRatio,
    fullscreen: document.fullscreenElement !== null,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
  };
}

export function sameScreen(a: ScreenCondition, b: ScreenCondition): boolean {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.dpr === b.dpr &&
    a.fullscreen === b.fullscreen &&
    a.screenWidth === b.screenWidth &&
    a.screenHeight === b.screenHeight
  );
}

/** localStorage 저장. 실패하면 메모리에만 두고 persistent=false로 알린다. */
export class CalibrationStore {
  private profiles: Partial<Record<InputSourceId, CalibrationProfile>> = {};
  persistent = true;

  constructor() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw) as StoredData;
        if (data.version === CALIBRATION_VERSION && data.profiles) this.profiles = data.profiles;
      }
    } catch {
      this.persistent = false;
    }
  }

  get(source: InputSourceId): CalibrationProfile | null {
    return this.profiles[source] ?? null;
  }

  set(profile: CalibrationProfile): void {
    this.profiles[profile.source] = profile;
    this.save();
  }

  clear(source: InputSourceId): void {
    delete this.profiles[source];
    this.save();
  }

  private save(): void {
    try {
      const data: StoredData = { version: CALIBRATION_VERSION, profiles: this.profiles };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      this.persistent = true;
    } catch {
      this.persistent = false;
    }
  }
}

import type { Point } from '../calibration/homography';

export type InputSourceId = 'mouse' | 'wiimote';
export type Action = 'fire' | 'cover' | 'pause';

/** 입력 장치 하나. 원본 조준 좌표는 장치마다 기준이 다르며, 보정이 게임 화면 좌표로 바꾼다. */
export interface InputSource {
  readonly id: InputSourceId;
  /** 현재 조준 원본 좌표. 신뢰할 수 없으면 null(포인터가 화면 밖, IR 미감지 등) */
  readonly rawAim: Point | null;
  /** 마지막으로 사용자가 이 장치를 움직이거나 누른 시각. 자동 선택에 쓴다. */
  readonly lastActivity: number;
  isHeld(action: Action): boolean;
  /** 마지막 호출 이후 새로 눌린 횟수와 눌린 순간의 원본 조준 좌표 */
  takePresses(action: Action): (Point | null)[];
  /** 이동 입력(-1~1). 자유 이동 시험 모드에서만 쓴다. */
  readonly move: Point;
  reset(): void;
}

export interface FirePress {
  source: InputSourceId;
  /** 게임 화면 정규화 좌표(0~1). null이면 조준 신호가 없어 발사할 수 없다. */
  aim: Point | null;
}

/** 게임 로직이 받는 한 프레임의 입력. 장치 종류를 몰라도 되도록 의미만 담는다. */
export interface InputFrame {
  source: InputSourceId | null;
  aim: Point | null;
  rawAim: Point | null;
  firePresses: FirePress[];
  fireHeld: boolean;
  coverHeld: boolean;
  pausePressed: boolean;
  move: Point;
}

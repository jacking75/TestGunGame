export type Vec3 = readonly [number, number, number];

export type BoxKind = 'floor' | 'wall' | 'crate' | 'barrier' | 'pillar' | 'cover' | 'hatch';

/** 장면의 상자 하나. 모두 탄을 막는 충돌체다. */
export interface BoxDef {
  kind: BoxKind;
  center: Vec3;
  size: Vec3;
}

export interface PatrolDef {
  /** 좌우 왕복 구간(x 좌표) */
  from: number;
  to: number;
  /** 초당 이동 거리 */
  speed: number;
}

export interface EnemyDef {
  x: number;
  z: number;
  /** 등장 완료 후 첫 공격 예고까지(초). 설정 최소값보다 작으면 최소값을 쓴다. */
  firstAttack: number;
  /** 공격 후 다음 예고까지 간격 범위(초) */
  cooldown: readonly [number, number];
  patrol?: PatrolDef;
}

export interface WaveDef {
  enemies: readonly EnemyDef[];
}

export interface CombatPointDef {
  id: string;
  name: string;
  eye: Vec3;
  look: Vec3;
  waves: readonly WaveDef[];
}

export interface TravelDef {
  /** 출발·도착 사이의 경유점(눈 위치) */
  via: readonly Vec3[];
  duration: number;
}

export interface StageDef {
  id: string;
  name: string;
  geometry: readonly BoxDef[];
  points: readonly CombatPointDef[];
  /** points[i] → points[i+1] 이동. 길이는 points.length - 1 */
  travels: readonly TravelDef[];
}

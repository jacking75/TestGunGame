import type { BoxDef, EnemyDef, StageDef, Vec3 } from './types';

// 좌표: x 오른쪽, y 위, -z 앞. 1 단위 ≈ 1m. 시작 위치 (0, 0) 기준 좌우 ±4, 앞뒤 ±3 안에서 움직인다(FREE_MOVE).
const WALL_H = 4;
const EYE_Y = 1.6;

const box = (kind: BoxDef['kind'], center: Vec3, size: Vec3): BoxDef => ({ kind, center, size });
const wall = (center: Vec3, size: Vec3) => box('wall', center, size);

/** 공격하지 않는 고정 표적(공격 예고가 오지 않도록 첫 공격을 무한대로 둔다) */
const target = (x: number, z: number): EnemyDef => ({ x, z, firstAttack: Infinity, cooldown: [Infinity, Infinity] });

const geometry: BoxDef[] = [
  box('floor', [0, -0.05, -6], [14, 0.1, 22]),
  wall([-6.2, WALL_H / 2, -6], [0.4, WALL_H, 22]),
  wall([6.2, WALL_H / 2, -6], [0.4, WALL_H, 22]),
  wall([0, WALL_H / 2, 4.2], [12.8, WALL_H, 0.4]),
  wall([0, WALL_H / 2, -16.2], [12.8, WALL_H, 0.4]),
  // 이동 구역 안의 회색 상자: 돌아가서 쏘는 연습과 충돌 확인용
  box('crate', [-2.2, 0.5, -1.6], [1, 1, 1]),
  box('crate', [2.4, 0.6, 1.2], [1.2, 1.2, 1.2]),
];

export const FREE_RANGE: StageDef = {
  id: 'free',
  name: '자유 이동 시험장',
  geometry,
  points: [
    {
      id: 'F',
      name: '자유 이동 시험장',
      eye: [0, EYE_Y, 0],
      look: [0, 1.3, -10],
      // 정교한 조준 없이 맞힐 수 있게 가깝게 두고 가리지 않는다(2026-10-23 사용자 의견).
      waves: [{ enemies: [target(-4, -8), target(-2, -9), target(0, -8), target(2, -9), target(4, -8)] }],
    },
  ],
  travels: [],
};

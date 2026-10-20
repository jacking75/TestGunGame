import type { BoxDef, StageDef, Vec3 } from './types';

// 좌표: x 오른쪽, y 위, -z 앞(진행 방향). 1 단위 ≈ 1m.
const WALL_H = 4;
const EYE_Y = 1.6;

const box = (kind: BoxDef['kind'], center: Vec3, size: Vec3): BoxDef => ({ kind, center, size });
const wall = (center: Vec3, size: Vec3) => box('wall', center, size);
/** 플레이어 바로 앞의 낮은 가림막. 엄폐하면 이 뒤로 숨는다. */
const playerCover = (z: number) => box('cover', [0, 0.55, z], [2.8, 1.1, 0.35]);

const geometry: BoxDef[] = [
  box('floor', [0, -0.05, -30], [20, 0.1, 72]),

  // A 입구: x -7~7, z 2~-14
  wall([0, WALL_H / 2, 2.2], [14.4, WALL_H, 0.4]),
  wall([-7.2, WALL_H / 2, -6], [0.4, WALL_H, 16.4]),
  wall([7.2, WALL_H / 2, -6], [0.4, WALL_H, 16.4]),
  wall([-5.1, WALL_H / 2, -14], [4.2, WALL_H, 0.4]),
  wall([5.1, WALL_H / 2, -14], [4.2, WALL_H, 0.4]),
  wall([0, 3.5, -14], [6, 1, 0.4]),
  playerCover(-2),
  box('barrier', [-3.5, 0.45, -9], [1.6, 0.9, 0.4]),
  box('barrier', [0, 0.45, -9], [1.6, 0.9, 0.4]),
  box('barrier', [3.5, 0.45, -9], [1.6, 0.9, 0.4]),
  box('crate', [-6, 0.5, -3], [1, 1, 1]),
  box('crate', [6.1, 0.4, -11.5], [0.8, 0.8, 0.8]),

  // B 통로: x -3~3, z -14~-40
  wall([-3.2, WALL_H / 2, -27], [0.4, WALL_H, 26]),
  wall([3.2, WALL_H / 2, -27], [0.4, WALL_H, 26]),
  playerCover(-18.5),
  box('crate', [-1.7, 0.5, -24], [1.1, 1, 1]),
  box('pillar', [1.9, WALL_H / 2, -28], [0.7, WALL_H, 0.7]),
  box('crate', [0.6, 0.45, -31.5], [1.2, 0.9, 0.9]),
  box('crate', [-1.9, 0.6, -33.5], [1, 1.2, 1]),

  // C 안쪽 구역: x -9~9, z -40~-62
  wall([-6.1, WALL_H / 2, -40], [6.2, WALL_H, 0.4]),
  wall([6.1, WALL_H / 2, -40], [6.2, WALL_H, 0.4]),
  wall([0, 3.5, -40], [6, 1, 0.4]),
  wall([-9.2, WALL_H / 2, -51], [0.4, WALL_H, 22.4]),
  wall([9.2, WALL_H / 2, -51], [0.4, WALL_H, 22.4]),
  wall([0, WALL_H / 2, -62.2], [18.8, WALL_H, 0.4]),
  playerCover(-44.5),
  box('barrier', [0, 0.45, -52], [12, 0.9, 0.4]),
  box('crate', [-7, 0.5, -55], [1.2, 1, 1.2]),
  box('crate', [7, 0.5, -56], [1.2, 1, 1.2]),
  box('pillar', [-7.5, WALL_H / 2, -47], [0.8, WALL_H, 0.8]),
  box('pillar', [7.5, WALL_H / 2, -47], [0.8, WALL_H, 0.8]),
];

const NORMAL: readonly [number, number] = [2.8, 4.4];
const FAST: readonly [number, number] = [2.4, 3.8];

export const STAGE1: StageDef = {
  id: 'stage1',
  name: '1스테이지 — 훈련 시설',
  geometry,
  points: [
    {
      id: 'A',
      name: 'A 입구',
      eye: [0, EYE_Y, -1],
      look: [0, 1.3, -11],
      waves: [
        {
          enemies: [
            { x: -3.5, z: -10.2, firstAttack: 2.2, cooldown: NORMAL },
            { x: 0, z: -10.2, firstAttack: 4.6, cooldown: NORMAL },
            { x: 3.5, z: -10.2, firstAttack: 3.4, cooldown: NORMAL },
          ],
        },
      ],
    },
    {
      id: 'B',
      name: 'B 통로',
      eye: [0, EYE_Y, -17.5],
      look: [0, 1.3, -32],
      waves: [
        {
          enemies: [
            { x: -1.7, z: -25.3, firstAttack: 2.2, cooldown: NORMAL },
            { x: 0.9, z: -26.5, firstAttack: 3.5, cooldown: NORMAL },
            { x: 1.2, z: -34, firstAttack: 4.8, cooldown: NORMAL },
          ],
        },
        {
          enemies: [
            { x: 1.6, z: -24.5, firstAttack: 2.0, cooldown: NORMAL },
            { x: -0.4, z: -29.5, firstAttack: 3.2, cooldown: NORMAL },
            { x: -1.9, z: -35.2, firstAttack: 4.4, cooldown: NORMAL },
          ],
        },
      ],
    },
    {
      id: 'C',
      name: 'C 안쪽 구역',
      eye: [0, EYE_Y, -43.5],
      look: [0, 1.3, -57],
      waves: [
        {
          enemies: [
            { x: -4.5, z: -54, firstAttack: 2.2, cooldown: FAST },
            { x: 4.5, z: -54.5, firstAttack: 3.4, cooldown: FAST },
            { x: 0, z: -56.5, firstAttack: 4.4, cooldown: FAST, patrol: { from: -3, to: 3, speed: 1.3 } },
          ],
        },
        {
          enemies: [
            { x: -2.5, z: -57, firstAttack: 2.0, cooldown: FAST },
            { x: 3, z: -55, firstAttack: 3.0, cooldown: FAST },
            { x: 0, z: -55.5, firstAttack: 3.8, cooldown: FAST, patrol: { from: -5, to: 5, speed: 1.8 } },
          ],
        },
      ],
    },
  ],
  travels: [
    // 가림막·상자를 피해 지나가는 경로
    {
      via: [
        [1.9, EYE_Y, -2],
        [1.75, EYE_Y, -9],
        [0, EYE_Y, -14],
      ],
      duration: 3.6,
    },
    {
      via: [
        [-2.2, EYE_Y, -18.5],
        [-0.4, EYE_Y, -22],
        [-0.5, EYE_Y, -31.5],
        [0, EYE_Y, -37],
        [0, EYE_Y, -41],
      ],
      duration: 4.2,
    },
  ],
};

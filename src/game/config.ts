/** 초기 밸런스 값. 실제 조준 시험 후 조정한다(구현 계획 8절). */
export const GAME = {
  playerHp: 5,
  magazine: 6,
  /** 엄폐를 이만큼 유지하면 장전된다(초) */
  reloadHold: 0.8,
  timeLimit: 180,
  scoreBody: 100,
  scoreHead: 200,
  enemyBodyHits: 2,
  /** 등장 연출 시간(초). 이 동안은 공격 준비 시간에 포함하지 않는다. */
  enemyAppear: 0.6,
  /** 등장 후 첫 공격 예고까지 최소 시간(초) */
  enemyMinFirstAttack: 2.0,
  /** 공격 예고 시간(초) */
  enemyWarning: 0.8,
  enemyDying: 0.45,
  /** 웨이브 사이 대기(초) */
  waveGap: 0.9,
} as const;

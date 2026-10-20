export interface Point {
  x: number;
  y: number;
}

/** 3×3 행렬(행 우선, h[8] = 1로 정규화) */
export type Homography = readonly number[];

export const IDENTITY: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** 네 점 쌍으로 원근 변환을 구한다. 퇴화(세 점이 한 줄 등)하면 null. */
export function computeHomography(src: readonly Point[], dst: readonly Point[]): Homography | null {
  if (src.length !== 4 || dst.length !== 4) throw new RangeError('점 4개가 필요하다');
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  const h = solve8(a);
  if (!h) return null;
  return [...h, 1];
}

export function applyHomography(h: Homography, x: number, y: number): Point {
  const w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

/** 사각형 꼭짓점이 순서대로 볼록한지(자기 교차·뒤집힘 없는지) 확인한다. */
export function isConvexQuad(p: readonly Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i];
    const b = p[(i + 1) % 4];
    const c = p[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** 8×9 확대 행렬을 가우스 소거로 푼다(부분 피벗). */
function solve8(m: number[][]): number[] | null {
  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

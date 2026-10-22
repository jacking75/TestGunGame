import * as THREE from 'three';
import type { Point } from '../calibration/homography';
import type { GameSession, HitResult } from '../game/GameSession';
import type { BoxDef, BoxKind, StageDef, Vec3 } from '../stage/types';
import { EnemyView, type HitboxData } from './EnemyView';

const COLORS: Record<BoxKind, number> = {
  floor: 0x9ba2a9,
  wall: 0xd3d7db,
  crate: 0x8c949c,
  barrier: 0xa8afb6,
  pillar: 0xbfc4c9,
  cover: 0x6f7881,
  hatch: 0x50565d,
};

const MAX_DECALS = 40;
const DECAL_LIFE = 8;
/** 빗나간 발사를 살펴볼 반지름(화면 짧은 변 비율). 실물 Wii 조준 오차 90%가 3.9~5.6%였다(2026-10-22). */
const AIM_ASSIST_RINGS = [0.02, 0.04, 0.06];
const AIM_ASSIST_DIRS = 8;
/** 엄폐 시 카메라를 내리는 거리. 눈이 가림막(높이 1.1) 윗면 바로 아래로 내려가 화면 아래 대부분이 가려진다. */
const COVER_DROP = 0.62;
const COVER_SPEED = 9;

interface Decal {
  mesh: THREE.Mesh;
  age: number;
}

/** Three.js 장면·카메라·충돌 판정을 담당한다. 게임 규칙은 모른다. */
export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.05, 200);
  private readonly raycaster = new THREE.Raycaster();
  private readonly staticColliders: THREE.Object3D[] = [];
  private readonly views = new Map<number, EnemyView>();
  private readonly decals: Decal[] = [];
  private readonly decalGeo = new THREE.CircleGeometry(0.045, 12);
  private readonly sparks: { mesh: THREE.Mesh; age: number }[] = [];
  private stageRoot = new THREE.Group();
  private coverVisual = 0;
  private time = 0;
  private readonly lookTarget = new THREE.Vector3();

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color(0xc4ccd4);
    this.scene.fog = new THREE.Fog(0xc4ccd4, 30, 90);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x7c8590, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(6, 12, 4);
    this.scene.add(sun);
    this.scene.add(this.stageRoot);
    this.resize();
  }

  loadStage(stage: StageDef): void {
    this.scene.remove(this.stageRoot);
    this.stageRoot.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.stageRoot = new THREE.Group();
    this.staticColliders.length = 0;
    for (const b of stage.geometry) {
      const mesh = makeBox(b);
      this.stageRoot.add(mesh);
      this.staticColliders.push(mesh);
    }
    this.scene.add(this.stageRoot);
  }

  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 세션 상태를 반영해 한 프레임을 그린다. */
  render(dt: number, session: GameSession | null): void {
    this.time += dt;
    if (session) {
      this.syncEnemies(dt, session);
      const target = session.cover.active ? 1 : 0;
      this.coverVisual += (target - this.coverVisual) * Math.min(1, dt * COVER_SPEED);
      const v = session.view;
      this.camera.position.set(v.eye[0], v.eye[1] - COVER_DROP * this.coverVisual, v.eye[2]);
      this.lookTarget.set(v.look[0], v.look[1] - COVER_DROP * this.coverVisual * 0.2, v.look[2]);
      this.camera.lookAt(this.lookTarget);
    }
    this.updateEffects(dt);
    this.renderer.render(this.scene, this.camera);
  }

  /** 메뉴 배경: 시작 지점을 천천히 둘러본다. */
  setIdleView(stage: StageDef): void {
    const p = stage.points[0];
    const sway = Math.sin(this.time * 0.25) * 1.5;
    this.camera.position.set(p.eye[0] + sway, p.eye[1] + 0.3, p.eye[2] + 1);
    this.camera.lookAt(p.look[0], p.look[1], p.look[2]);
  }

  /** 화면 좌표(0~1)에서 카메라 광선을 쏴 가장 앞의 충돌체를 찾는다. */
  resolveHit = (aim: Point): HitResult => {
    this.camera.updateMatrixWorld();
    const targets: THREE.Object3D[] = [...this.staticColliders];
    for (const v of this.views.values()) if (v.enemy.alive) targets.push(...v.hitboxes);
    const center = this.castAt(aim, targets);
    if (center.kind === 'enemy') return center;
    // 빗나간 발사는 조준점 둘레를 안쪽부터 살펴 가장 가까운 적을 맞힌 것으로 본다(벽 너머는 첫 충돌이 벽이라 제외).
    const size = this.renderer.getSize(new THREE.Vector2());
    const short = Math.min(size.x, size.y) || 1;
    for (const r of AIM_ASSIST_RINGS) {
      for (let i = 0; i < AIM_ASSIST_DIRS; i++) {
        const a = (i / AIM_ASSIST_DIRS) * Math.PI * 2;
        const p = { x: aim.x + (Math.cos(a) * r * short) / (size.x || 1), y: aim.y + (Math.sin(a) * r * short) / (size.y || 1) };
        const hit = this.castAt(p, targets);
        if (hit.kind === 'enemy') return { ...hit, part: 'body' };
      }
    }
    return center;
  };

  private castAt(aim: Point, targets: THREE.Object3D[]): HitResult {
    this.raycaster.setFromCamera(new THREE.Vector2(aim.x * 2 - 1, -(aim.y * 2 - 1)), this.camera);
    const hits = this.raycaster.intersectObjects(targets, false);
    const first = hits[0];
    if (!first) return { kind: 'none' };
    const data = first.object.userData as Partial<HitboxData>;
    const point: Vec3 = [first.point.x, first.point.y, first.point.z];
    if (data.enemyId !== undefined && data.part) return { kind: 'enemy', enemyId: data.enemyId, part: data.part, point };
    const n = first.face?.normal.clone().transformDirection(first.object.matrixWorld) ?? new THREE.Vector3(0, 0, 1);
    return { kind: 'world', point, normal: [n.x, n.y, n.z] };
  }

  addBulletHole(point: Vec3, normal: Vec3): void {
    const mat = new THREE.MeshBasicMaterial({ color: 0x1d2024, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    const mesh = new THREE.Mesh(this.decalGeo, mat);
    const n = new THREE.Vector3(...normal);
    mesh.position.set(point[0], point[1], point[2]).addScaledVector(n, 0.005);
    mesh.lookAt(mesh.position.clone().add(n));
    this.scene.add(mesh);
    this.decals.push({ mesh, age: 0 });
    if (this.decals.length > MAX_DECALS) this.removeDecal(0);
    this.addSpark(point, 0xfff1b0);
  }

  addSpark(point: Vec3, color: number): void {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 8, 6),
      new THREE.MeshBasicMaterial({ color, transparent: true }),
    );
    mesh.position.set(point[0], point[1], point[2]);
    this.scene.add(mesh);
    this.sparks.push({ mesh, age: 0 });
  }

  enemyFired(enemyId: number): void {
    this.views.get(enemyId)?.showMuzzle();
  }

  /** 다시 시작할 때 적·효과를 모두 지운다. */
  clearDynamic(): void {
    for (const v of this.views.values()) this.removeView(v);
    this.views.clear();
    while (this.decals.length) this.removeDecal(0);
    for (const s of this.sparks) this.disposeEffect(s.mesh);
    this.sparks.length = 0;
    this.coverVisual = 0;
  }

  private syncEnemies(dt: number, session: GameSession): void {
    for (const [id, enemy] of session.enemies) {
      let view = this.views.get(id);
      if (!view) {
        view = new EnemyView(enemy);
        this.views.set(id, view);
        this.scene.add(view.root);
      }
      view.sync(dt, this.camera.position, this.time);
    }
    for (const [id, view] of this.views) {
      if (!session.enemies.has(id)) {
        this.removeView(view);
        this.views.delete(id);
      }
    }
  }

  private removeView(v: EnemyView): void {
    this.scene.remove(v.root);
    v.dispose();
  }

  private updateEffects(dt: number): void {
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      d.age += dt;
      const m = d.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = Math.min(1, (DECAL_LIFE - d.age) / 2);
      if (d.age >= DECAL_LIFE) this.removeDecal(i);
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i];
      s.age += dt;
      const t = s.age / 0.12;
      s.mesh.scale.setScalar(1 + t * 1.5);
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - t;
      if (t >= 1) {
        this.disposeEffect(s.mesh);
        this.sparks.splice(i, 1);
      }
    }
  }

  private removeDecal(i: number): void {
    const d = this.decals[i];
    this.scene.remove(d.mesh);
    (d.mesh.material as THREE.Material).dispose();
    this.decals.splice(i, 1);
  }

  private disposeEffect(mesh: THREE.Mesh): void {
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }
}

function makeBox(b: BoxDef): THREE.Mesh {
  const geo = new THREE.BoxGeometry(b.size[0], b.size[1], b.size[2]);
  const mat = new THREE.MeshStandardMaterial({
    color: COLORS[b.kind],
    roughness: 0.85,
    metalness: 0,
    map: b.kind === 'floor' ? floorTexture(b.size[0], b.size[2]) : null,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(b.center[0], b.center[1], b.center[2]);
  mesh.userData = { kind: b.kind };
  return mesh;
}

/** 거리감을 위한 1m 격자 바닥 */
function floorTexture(w: number, d: number): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 64, 64);
  g.strokeStyle = '#c9cdd1';
  g.lineWidth = 3;
  g.strokeRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(w, d);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

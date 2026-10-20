import * as THREE from 'three';
import type { Enemy, HitPart } from '../actors/Enemy';

const ORANGE = 0xff7a1a;
const ORANGE_HEAD = 0xff9840;
const DARK = 0x2b2f36;

export interface HitboxData {
  enemyId: number;
  part: HitPart;
}

let warningTexture: THREE.Texture | null = null;

/** 노란 삼각형 + 검은 느낌표. 색만으로 전달하지 않도록 모양을 함께 쓴다. */
function getWarningTexture(): THREE.Texture {
  if (warningTexture) return warningTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffd400';
  g.strokeStyle = '#1b1b1b';
  g.lineWidth = 8;
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(64, 8);
  g.lineTo(122, 116);
  g.lineTo(6, 116);
  g.closePath();
  g.fill();
  g.stroke();
  g.fillStyle = '#1b1b1b';
  g.fillRect(56, 38, 16, 46);
  g.fillRect(56, 92, 16, 14);
  warningTexture = new THREE.CanvasTexture(c);
  warningTexture.colorSpace = THREE.SRGBColorSpace;
  return warningTexture;
}

/**
 * 훈련 로봇의 모습과 충돌 영역. 충돌 영역은 보이는 모델과 별도인 단순 상자다.
 * 머리와 몸통 사이에 틈을 두어 판정이 섞이지 않게 한다.
 */
export class EnemyView {
  readonly root = new THREE.Group();
  readonly hitboxes: THREE.Mesh[] = [];
  private readonly body = new THREE.Group();
  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly warning: THREE.Sprite;
  private readonly muzzle: THREE.Mesh;
  private muzzleTime = 0;

  constructor(readonly enemy: Enemy) {
    const orange = this.mat(ORANGE);
    const head = this.mat(ORANGE_HEAD);
    const dark = this.mat(DARK);

    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      this.body.add(mesh);
      return mesh;
    };
    add(new THREE.BoxGeometry(0.22, 0.62, 0.26), dark, -0.17, 0.31, 0);
    add(new THREE.BoxGeometry(0.22, 0.62, 0.26), dark, 0.17, 0.31, 0);
    add(new THREE.BoxGeometry(0.72, 0.9, 0.42), orange, 0, 1.06, 0);
    add(new THREE.BoxGeometry(0.4, 0.12, 0.05), dark, 0, 1.25, 0.22); // 가슴 표식
    add(new THREE.BoxGeometry(0.38, 0.36, 0.38), head, 0, 1.78, 0);
    add(new THREE.BoxGeometry(0.3, 0.08, 0.05), dark, 0, 1.8, 0.2); // 눈 띠
    add(new THREE.BoxGeometry(0.14, 0.14, 0.55), dark, 0.42, 1.18, 0.2); // 총

    this.muzzle = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true }),
    );
    this.muzzle.position.set(0.42, 1.18, 0.55);
    this.muzzle.visible = false;
    this.body.add(this.muzzle);

    this.warning = new THREE.Sprite(new THREE.SpriteMaterial({ map: getWarningTexture(), depthTest: false }));
    this.warning.scale.set(0.5, 0.5, 1);
    this.warning.position.set(0, 2.35, 0);
    this.warning.renderOrder = 10;
    this.warning.visible = false;
    this.body.add(this.warning);

    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    const bodyBox = new THREE.Mesh(new THREE.BoxGeometry(0.76, 1.52, 0.46), hitMat);
    bodyBox.position.set(0, 0.76, 0);
    bodyBox.userData = { enemyId: enemy.id, part: 'body' } satisfies HitboxData;
    const headBox = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.4, 0.42), hitMat);
    headBox.position.set(0, 1.78, 0);
    headBox.userData = { enemyId: enemy.id, part: 'head' } satisfies HitboxData;
    this.body.add(bodyBox, headBox);
    this.hitboxes.push(bodyBox, headBox);

    this.root.add(this.body);
  }

  showMuzzle(): void {
    this.muzzleTime = 0.09;
  }

  /** 논리 상태를 화면에 반영한다. */
  sync(dt: number, eye: THREE.Vector3, time: number): void {
    const e = this.enemy;
    this.root.position.set(e.x, 0, e.z);
    this.root.rotation.y = Math.atan2(eye.x - e.x, eye.z - e.z);

    // 바닥 승강구에서 올라오는 등장 연출
    const a = e.appearProgress;
    const rise = 1 - (1 - a) * (1 - a);
    this.body.position.y = -(1 - rise) * 2.1;

    const flash = e.flash > 0 ? 0.9 : 0;
    const warn = e.state === 'warning' ? 0.35 + 0.25 * Math.sin(time * 30) : 0;
    for (const m of this.materials) m.emissiveIntensity = Math.max(flash, warn);
    for (const m of this.materials) m.emissive.setHex(flash > 0 ? 0xffffff : 0xffcc00);

    this.warning.visible = e.state === 'warning';
    if (this.warning.visible) {
      const s = 0.45 + 0.12 * Math.sin(time * 18);
      this.warning.scale.set(s, s, 1);
    }

    this.muzzleTime = Math.max(0, this.muzzleTime - dt);
    this.muzzle.visible = this.muzzleTime > 0;

    if (e.state === 'dying' || e.state === 'dead') {
      const t = Math.min(1, e.stateTime / 0.45);
      this.body.rotation.x = -t * 1.2;
      this.body.position.y = -t * 0.4;
      for (const m of this.materials) {
        m.transparent = true;
        m.opacity = 1 - t;
      }
      this.warning.visible = false;
    }
  }

  dispose(): void {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material as THREE.Material;
        m.dispose();
      }
    });
    (this.warning.material as THREE.SpriteMaterial).dispose();
  }

  private mat(color: number): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, emissive: 0x000000 });
    this.materials.push(m);
    return m;
  }
}

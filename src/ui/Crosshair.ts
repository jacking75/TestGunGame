import type { Point } from '../calibration/homography';

/** 청록색 원형 조준점. 표시 위치 = 실제 판정 위치(같은 좌표를 쓴다). */
export class Crosshair {
  readonly el: HTMLDivElement;
  private last: Point = { x: 0.5, y: 0.5 };
  private timers: number[] = [];

  constructor(private readonly area: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'crosshair';
    this.el.innerHTML = '<div class="ring"></div><div class="dot"></div><div class="marker"></div>';
    this.el.style.display = 'none';
  }

  /** aim이 null이면 마지막 위치에 '신호 없음' 모양으로 둔다. */
  update(aim: Point | null, visible: boolean): void {
    this.el.style.display = visible ? 'block' : 'none';
    if (!visible) return;
    if (aim) this.last = aim;
    this.el.classList.toggle('lost', !aim);
    const r = this.area.getBoundingClientRect();
    this.el.style.transform = `translate(${r.left + this.last.x * r.width}px, ${r.top + this.last.y * r.height}px)`;
  }

  /** 화면 좌표(px). 메뉴에서 리모컨으로 버튼을 누를 때 쓴다. */
  clientPoint(aim: Point): { x: number; y: number } {
    const r = this.area.getBoundingClientRect();
    return { x: r.left + aim.x * r.width, y: r.top + aim.y * r.height };
  }

  fired(): void {
    this.pulse('fired', 120);
  }

  hit(head: boolean): void {
    this.el.classList.toggle('head', head);
    this.pulse('hit', 250);
  }

  private pulse(cls: string, ms: number): void {
    this.el.classList.remove(cls);
    void this.el.offsetWidth; // 애니메이션 재시작
    this.el.classList.add(cls);
    const t = window.setTimeout(() => this.el.classList.remove(cls), ms);
    this.timers.push(t);
    if (this.timers.length > 8) this.timers.shift();
  }
}

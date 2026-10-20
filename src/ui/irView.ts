import type { IrPointerResult } from '../input/wiimote/IrPointer';
import { IR_HEIGHT, IR_WIDTH, type IrDot } from '../input/wiimote/protocol';

/** 리모컨 IR 카메라가 보는 점을 사용자 시점(좌우 반전)으로 그린다. */
export function drawIrView(canvas: HTMLCanvasElement, dots: readonly IrDot[], ir: IrPointerResult): void {
  const g = canvas.getContext('2d')!;
  const w = canvas.width;
  const h = canvas.height;
  g.fillStyle = '#050607';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = '#262a30';
  g.beginPath();
  g.moveTo(w / 2, 0);
  g.lineTo(w / 2, h);
  g.moveTo(0, h / 2);
  g.lineTo(w, h / 2);
  g.stroke();
  for (const d of dots) {
    g.fillStyle = '#ffeb3b';
    g.beginPath();
    g.arc((1 - d.x / IR_WIDTH) * w, (d.y / IR_HEIGHT) * h, 3 + d.size * (w / 256), 0, Math.PI * 2);
    g.fill();
  }
  if (ir.tracking !== 'none') {
    g.strokeStyle = '#19e3e3';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(ir.x * w, ir.y * h, 8 * (w / 256), 0, Math.PI * 2);
    g.stroke();
    g.lineWidth = 1;
  }
}

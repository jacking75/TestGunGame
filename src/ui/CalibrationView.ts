import { CALIBRATION_TARGETS, type CalibrationSession } from '../calibration/CalibrationSession';
import type { InputSourceId } from '../input/types';
import type { IrPointerResult } from '../input/wiimote/IrPointer';
import type { IrDot } from '../input/wiimote/protocol';
import { h } from './dom';
import { drawIrView } from './irView';

const POINT_NAMES = ['왼쪽 위', '오른쪽 위', '오른쪽 아래', '왼쪽 아래', '가운데(확인)'];

export interface CalibrationSignal {
  /** 지금 조준 신호가 있는지 */
  hasSignal: boolean;
  /** Wii일 때 카메라 미리보기용 */
  ir?: IrPointerResult;
  dots?: readonly IrDot[];
}

/** 보정 화면: 목표점을 차례로 보여주고, 현재 조준 위치·센서바 상태·진행·실패 안내를 표시한다. */
export class CalibrationView {
  readonly el: HTMLDivElement;
  private readonly targets: HTMLDivElement[] = [];
  private readonly bars: HTMLElement[] = [];
  private readonly title = h('div');
  private readonly guide = h('div');
  private readonly msg = h('div', { class: 'msg' });
  private readonly signal = h('div');
  private readonly irBox = h('div', { class: 'calib-ir' });
  private readonly irCanvas = h('canvas', { width: 256, height: 192 });

  constructor(handlers: { retry: () => void; restart: () => void; cancel: () => void; reset: () => void }) {
    this.el = h('div', { id: 'calibration' });
    CALIBRATION_TARGETS.forEach((t) => {
      const bar = h('b');
      const el = h('div', { class: 'target' }, h('div', { class: 'progress' }, bar));
      el.style.left = `${t.x * 100}%`;
      el.style.top = `${t.y * 100}%`;
      this.targets.push(el);
      this.bars.push(bar);
      this.el.append(el);
    });
    this.irBox.append(h('div', { class: 'sub' }, '리모컨이 보는 센서바'), this.irCanvas);
    this.el.append(
      h('div', { class: 'info' }, this.title, this.guide, this.signal, this.msg),
      this.irBox,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'small', onclick: handlers.retry }, '이 지점 다시'),
        h('button', { class: 'small', onclick: handlers.restart }, '처음부터'),
        h('button', { class: 'small', onclick: handlers.reset }, '보정 초기화'),
        h('button', { class: 'small', onclick: handlers.cancel }, '취소'),
      ),
    );
    this.el.style.display = 'none';
  }

  show(visible: boolean): void {
    this.el.style.display = visible ? 'block' : 'none';
  }

  update(s: CalibrationSession, source: InputSourceId, sig: CalibrationSignal): void {
    this.targets.forEach((el, i) => {
      el.classList.toggle('done', i < s.index);
      el.classList.toggle('pending', i > s.index);
      el.style.display = i <= s.index || i < 4 ? 'block' : 'none';
    });
    this.bars.forEach((b, i) => (b.style.width = i === s.index ? `${s.progress * 100}%` : '0%'));

    const wii = source === 'wiimote';
    const trigger = wii ? '방아쇠' : '왼쪽 버튼';
    this.title.innerHTML = `<b>조준 보정</b> — ${wii ? 'Wii 총' : '마우스'} (${Math.min(s.index + 1, 5)}/5)`;
    this.guide.textContent =
      s.phase === 'failed'
        ? `보정에 실패했습니다. ${trigger}을(를) 당기면 처음부터 다시 합니다.`
        : `평소 플레이할 자리와 자세에서 빨간 점 ${POINT_NAMES[Math.min(s.index, 4)]}의 중심에 청록색 조준점을 맞추고 ${trigger}을(를) 당긴 뒤 잠시 그대로 유지하세요. 조준점은 보정 전이라 대략적인 위치입니다.`;

    this.irBox.style.display = wii ? 'block' : 'none';
    if (wii) {
      if (sig.ir) drawIrView(this.irCanvas, sig.dots ?? [], sig.ir);
      const t = sig.ir?.tracking ?? 'none';
      this.signal.innerHTML =
        t === 'pair'
          ? '<span class="ok">센서바 감지됨</span>'
          : t === 'single'
            ? '<span class="warn">센서바 한쪽 끝만 보입니다 — 화면 가운데 쪽으로 조금 돌려 보세요</span>'
            : '<span class="bad">센서바가 리모컨 시야를 벗어났습니다. 화면에서 조금 더 뒤로 물러나면 모서리까지 겨냥하기 쉬워집니다.</span>';
    } else {
      this.signal.innerHTML = sig.hasSignal ? '' : '<span class="bad">포인터가 게임 화면 밖에 있습니다</span>';
    }
    this.msg.textContent = s.message;
  }
}

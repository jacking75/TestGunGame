import { CALIBRATION_TARGETS, type CalibrationSession } from '../calibration/CalibrationSession';
import type { InputSourceId } from '../input/types';
import { h } from './dom';

const POINT_NAMES = ['왼쪽 위', '오른쪽 위', '오른쪽 아래', '왼쪽 아래', '가운데(확인)'];

/** 보정 화면: 목표점을 차례로 보여주고 진행·실패 안내를 표시한다. */
export class CalibrationView {
  readonly el: HTMLDivElement;
  private readonly targets: HTMLDivElement[] = [];
  private readonly bars: HTMLElement[] = [];
  private readonly title = h('div');
  private readonly guide = h('div');
  private readonly msg = h('div', { class: 'msg' });
  private readonly signal = h('div');

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
    this.el.append(
      h('div', { class: 'info' }, this.title, this.guide, this.signal, this.msg),
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

  update(s: CalibrationSession, source: InputSourceId, hasSignal: boolean): void {
    this.targets.forEach((el, i) => {
      el.classList.toggle('done', i < s.index);
      el.classList.toggle('pending', i > s.index);
      el.style.display = i <= s.index || i < 4 ? 'block' : 'none';
    });
    this.bars.forEach((b, i) => (b.style.width = i === s.index ? `${s.progress * 100}%` : '0%'));

    const device = source === 'wiimote' ? 'Wii 총' : '마우스';
    const trigger = source === 'wiimote' ? '방아쇠' : '왼쪽 버튼';
    this.title.innerHTML = `<b>조준 보정</b> — ${device} (${Math.min(s.index + 1, 5)}/5)`;
    this.guide.textContent =
      s.phase === 'failed'
        ? `보정에 실패했습니다. ${trigger}을(를) 당기면 처음부터 다시 합니다.`
        : `평소 플레이할 자리와 자세에서 ${POINT_NAMES[Math.min(s.index, 4)]} 점의 중심을 겨냥하고 ${trigger}을(를) 당긴 채 잠시 유지하세요.`;
    this.signal.innerHTML =
      source === 'wiimote'
        ? hasSignal
          ? '<span class="ok">센서바 감지됨</span>'
          : '<span class="bad">센서바가 보이지 않습니다 — 센서바 전원과 방향을 확인하세요</span>'
        : '';
    this.msg.textContent = s.message;
  }
}

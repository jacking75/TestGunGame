import type { GameSession } from '../game/GameSession';
import { formatTime, h } from './dom';

export interface StatusInfo {
  device: string;
  wiimote: { text: string; tone: 'ok' | 'warn' | 'bad' };
  calibration: { text: string; tone: 'ok' | 'warn' | 'bad' };
  audio: string;
}

type Handler = () => void;

/** 메뉴 화면 모음. 각 함수는 화면 요소를 만들어 돌려준다. */
export const Screens = {
  title(status: StatusInfo, on: { start: Handler; calibrate: Handler; setup: Handler; help: Handler; diag: Handler }) {
    return screen(
      h('h1', {}, 'TestGunGame'),
      h('p', { class: 'sub' }, 'Wii 총 레일 슈팅 — 1스테이지 훈련 시설'),
      statusBox(status),
      h(
        'div',
        { class: 'buttons' },
        h('button', { class: 'primary', onclick: on.start, 'data-default': true }, '게임 시작'),
        h('button', { onclick: on.setup }, '컨트롤러 설정'),
        h('button', { onclick: on.calibrate }, '조준 보정'),
        h('button', { onclick: on.help }, '조작 방법'),
        h('button', { class: 'small', onclick: on.diag }, '입력 진단 (F3)'),
      ),
    );
  },

  help(on: { back: Handler }) {
    return screen(
      h('h2', {}, '조작 방법'),
      h(
        'table',
        { class: 'controls' },
        h('tr', {}, h('th', {}, '동작'), h('th', {}, 'Wii 총'), h('th', {}, '마우스·키보드')),
        row('조준', '총을 화면으로 향한다', '마우스 이동'),
        row('발사', '방아쇠(B)', '왼쪽 버튼'),
        row('엄폐·재장전', 'A 버튼을 누르고 유지', 'Space 또는 오른쪽 버튼 유지'),
        row('일시정지', '+ / − / HOME', 'Esc 또는 P'),
        row('메뉴 선택', '버튼을 겨냥하고 방아쇠', '클릭'),
      ),
      h(
        'ul',
        {},
        h('li', {}, '한 번 당길 때 한 발만 나갑니다(반자동). 탄창은 6발입니다.'),
        h('li', {}, '엄폐를 0.8초 유지하면 6발로 장전됩니다. 엄폐 중에는 피해를 받지 않고 쏠 수도 없습니다.'),
        h('li', {}, '적 머리 위에 노란 삼각형(!)이 뜨면 곧 공격합니다. 숨으세요.'),
        h('li', {}, '몸통 2발, 머리 1발로 처치합니다. 머리 명중은 200점, 몸통은 100점입니다.'),
      ),
      h('div', { class: 'buttons' }, h('button', { onclick: on.back }, '돌아가기')),
    );
  },

  paused(reason: string, on: { resume: Handler; restart: Handler; calibrate: Handler; menu: Handler }) {
    return screen(
      h('h2', {}, '일시정지'),
      reason ? h('p', { class: 'warn' }, reason) : null,
      h('p', { class: 'sub' }, '재개하면 이미 누르고 있던 버튼은 한 번 놓은 뒤부터 다시 동작합니다.'),
      h(
        'div',
        { class: 'buttons' },
        h('button', { class: 'primary', onclick: on.resume, 'data-default': true }, '재개'),
        h('button', { onclick: on.restart }, '처음부터 다시'),
        h('button', { onclick: on.calibrate }, '조준 보정'),
        h('button', { onclick: on.menu }, '메뉴로'),
      ),
    );
  },

  result(s: GameSession, on: { restart: Handler; menu: Handler }) {
    const cleared = s.phase === 'cleared';
    const st = s.stats;
    const acc = st.shots === 0 ? 0 : Math.round((st.hits / st.shots) * 100);
    const reason = s.failReason === 'time' ? '제한 시간이 끝났습니다.' : '체력이 모두 떨어졌습니다.';
    return screen(
      h('h1', { class: cleared ? 'ok' : 'bad' }, cleared ? '스테이지 클리어' : '임무 실패'),
      h('p', { class: 'sub' }, cleared ? `남은 시간 ${formatTime(s.timeLeft)} · 남은 체력 ${s.hp}` : reason),
      h(
        'div',
        { class: 'stats' },
        stat('점수', st.score.toLocaleString('ko-KR')),
        stat('플레이 시간', formatTime(st.playTime)),
        stat('발사 수', st.shots),
        stat('명중 수', st.hits),
        stat('명중률', `${acc}%`),
        stat('처치 수', `${st.kills}/${s.totalEnemies}`),
        stat('머리 명중', st.headshots),
        stat('피해 횟수', st.damageTaken),
      ),
      h(
        'div',
        { class: 'buttons' },
        h('button', { class: 'primary', onclick: on.restart, 'data-default': true }, '다시 도전'),
        h('button', { onclick: on.menu }, '메뉴로'),
      ),
    );
  },
};

function screen(...children: (Node | null)[]): HTMLElement {
  return h('div', { class: 'screen' }, h('div', { class: 'panel' }, ...children));
}

function statusBox(s: StatusInfo): HTMLElement {
  return h(
    'div',
    { class: 'status' },
    h('div', { class: 'row' }, h('span', {}, '조작 방식'), h('span', { class: 'value' }, s.device)),
    h('div', { class: 'row' }, h('span', {}, 'Wii 리모컨'), h('span', { class: `value ${s.wiimote.tone}` }, s.wiimote.text)),
    h('div', { class: 'row' }, h('span', {}, '조준 보정'), h('span', { class: `value ${s.calibration.tone}` }, s.calibration.text)),
    s.audio ? h('div', { class: 'row' }, h('span', {}, '소리'), h('span', { class: 'value warn' }, s.audio)) : null,
  );
}

function row(a: string, b: string, c: string): HTMLElement {
  return h('tr', {}, h('td', {}, a), h('td', {}, b), h('td', {}, c));
}

function stat(k: string, v: string | number): HTMLElement {
  return h('div', {}, h('span', {}, k), h('span', {}, String(v)));
}

// T10 마우스 기준 검증: 배포용 게임 실행 파일(TestGunGame.exe)을 실제로 띄우고 마우스·키보드 입력을 보내 끝까지 플레이한다.
// 게임 내부 상태를 읽지 않고 화면(픽셀·HUD 글자)만 보고 조작한다. 사용자의 저장 설정을 건드리지 않도록 임시 데이터 폴더를 쓴다.
//
//   npm run app:build && node scripts/verify-exe.mjs [--runs 3] [--out logs/t10]
//
// 결과: <out>/result.json, 화면 캡처 PNG. WebView2 디버깅 포트는 로컬 규칙(TCP 25001~25199) 안의 25003을 쓴다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const RUNS = Number(args.runs ?? 3);
const OUT = path.resolve(args.out ?? 'logs/t10');
const PORT = 25003;
const EXE = path.resolve('host/bin/Release/net48/TestGunGame.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ───────── CDP 연결 ─────────

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
      } else if (m.method) for (const fn of this.handlers.get(m.method) ?? []) fn(m.params);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    return new Cdp(ws);
  }
  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  async eval(expr, userGesture = false) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
}

// ───────── 입력 ─────────

let mouse = { x: 0, y: 0 };
async function move(c, x, y) {
  mouse = { x, y };
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}
async function mouseDown(c) {
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mouse.x, y: mouse.y, button: 'left', buttons: 1, clickCount: 1 });
}
async function mouseUp(c) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mouse.x, y: mouse.y, button: 'left', buttons: 0, clickCount: 1 });
}
async function click(c, x, y) {
  await move(c, x, y);
  await mouseDown(c);
  await sleep(30);
  await mouseUp(c);
}
const KEYS = { Space: { key: ' ', code: 'Space', keyCode: 32 }, Escape: { key: 'Escape', code: 'Escape', keyCode: 27 } };
async function key(c, name, type) {
  const k = KEYS[name];
  await c.send('Input.dispatchKeyEvent', { type, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode });
}

/** 글자가 맞는 화면 버튼을 실제 마우스로 누른다. */
async function clickButton(c, text) {
  const r = await c.eval(`(() => {
    const b = [...document.querySelectorAll('#screens button, #calib button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && b.offsetParent);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!r) throw new Error(`버튼 없음: ${text}`);
  await click(c, r.x, r.y);
}

async function waitFor(c, expr, timeout = 10000, label = expr) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await c.eval(expr).catch(() => null);
    if (v) return v;
    await sleep(100);
  }
  throw new Error(`시간 초과: ${label}`);
}

async function shot(c, name) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
}

// ───────── 페이지 안 도우미(게임 내부를 읽지 않는다) ─────────

const PAGE_HELPERS = `
window.__v = {
  hud() {
    const q = (s) => document.querySelector(s);
    const hud = q('#hud');
    const scr = q('#screens .panel');
    return {
      hudVisible: !!hud && getComputedStyle(hud).display !== 'none' && hud.offsetParent !== null,
      ammo: q('#hud .ammo span')?.textContent ?? '',
      hp: document.querySelectorAll('#hud .hp i:not(.lost)').length,
      time: q('#hud .time')?.textContent ?? '',
      stance: q('#hud .stance')?.textContent ?? '',
      cover: q('#hud .stance')?.classList.contains('cover') ?? false,
      toast: q('#hud .toast.show')?.textContent ?? '',
      screen: scr ? (scr.querySelector('h1, h2')?.textContent ?? '') : '',
      screenText: scr?.textContent ?? '',
      crosshair: (() => { const e = q('#crosshair'); if (!e || e.style.display === 'none') return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })(),
      vw: innerWidth, vh: innerHeight,
      canvas: (() => { const c = q('#game'); return c ? { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight } : null; })(),
      fullscreen: !!document.fullscreenElement,
    };
  },
  scanCanvas: null,
  skipNext: false,
  /** 게임이 그린 직후 프레임을 줄여 읽어 주황 로봇과 노란 경고 표시를 찾는다. */
  scan() {
    return new Promise((res) => requestAnimationFrame(() => {
      const src = document.getElementById('game');
      const W = 240, H = Math.round(W * src.height / src.width);
      const cv = this.scanCanvas ??= document.createElement('canvas');
      cv.width = W; cv.height = H;
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(src, 0, 0, W, H);
      const d = g.getImageData(0, 0, W, H).data;
      this.skipNext = true;
      const mark = new Uint8Array(W * H);
      let warn = 0, warnX = 0;
      for (let i = 0; i < W * H; i++) {
        const r = d[i * 4], gg = d[i * 4 + 1], b = d[i * 4 + 2];
        // 경고 삼각형(#ffd400)
        if (r > 225 && gg > 195 && b < 70) { warn++; warnX += i % W; }
        // 로봇(주황, 예고 중에는 노랗게 깜박임)
        if (r > 150 && gg > 50 && gg < 215 && b < 120 && r - b > 90 && r - gg > 25) mark[i] = 1;
      }
      const comps = [];
      const stack = [];
      for (let i = 0; i < W * H; i++) {
        if (mark[i] !== 1) continue;
        let n = 0, minX = W, maxX = 0, minY = H, maxY = 0, sx = 0, sy = 0;
        stack.push(i); mark[i] = 2;
        while (stack.length) {
          const j = stack.pop();
          const x = j % W, y = (j / W) | 0;
          n++; sx += x; sy += y;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          for (const k of [j - 1, j + 1, j - W, j + W]) if (k >= 0 && k < W * H && mark[k] === 1 && Math.abs((k % W) - x) <= 1) { mark[k] = 2; stack.push(k); }
        }
        if (n >= 3) comps.push({ n, minX, maxX, minY, maxY, cx: sx / n, cy: sy / n });
      }
      // 머리 = 아래쪽에 더 큰 요소(몸통)가 겹쳐 있는 요소. 몸통마다 머리 하나를 표적으로 삼는다.
      const bodies = comps.filter((b) => !comps.some((o) => o !== b && o.n > b.n && o.minY > b.maxY && o.minX <= b.maxX && o.maxX >= b.minX));
      const targets = [];
      for (const body of bodies) {
        const heads = comps.filter((o) => o !== body && o.maxY < body.minY && body.minY - o.maxY < (body.maxX - body.minX) && o.minX <= body.maxX && o.maxX >= body.minX);
        let x, y, head = false;
        if (heads.length) {
          const top = Math.min(...heads.map((o) => o.minY)), bottom = Math.max(...heads.map((o) => o.maxY));
          x = heads.reduce((s, o) => s + o.cx * o.n, 0) / heads.reduce((s, o) => s + o.n, 0);
          y = (top + bottom) / 2;
          head = true;
        } else {
          x = body.cx;
          y = body.minY + (body.maxY - body.minY) * 0.3;
        }
        targets.push({ x: (x + 0.5) / W, y: (y + 0.5) / H, head, size: body.n });
      }
      targets.sort((a, b) => b.size - a.size);
      res({ targets, warn: warn > 3, warnX: warn > 3 ? (warnX / warn + 0.5) / W : null });
    }));
  },
  frames: null,
  startFrames() {
    this.frames = [];
    let last = performance.now();
    const tick = (t) => {
      if (!this.frames) return;
      if (this.skipNext) this.skipNext = false; else this.frames.push(t - last);
      last = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  },
  stopFrames() { const f = this.frames; this.frames = null; return f; },
};`;

// 페이지 시작 전에 넣는다: 소리 재생 횟수와 오류를 센다.
const PRELOAD = `
window.__audio = { contexts: [], starts: 0 };
(() => {
  const AC = window.AudioContext;
  window.AudioContext = class extends AC { constructor(...a) { super(...a); window.__audio.contexts.push(this); } };
  for (const C of [OscillatorNode, AudioBufferSourceNode]) {
    const s = C.prototype.start;
    C.prototype.start = function (...a) { window.__audio.starts++; return s.apply(this, a); };
  }
})();`;

// ───────── 실행 ─────────

async function launch() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgg-verify-'));
  const env = {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: dataDir,
    TGG_LOG_DIR: path.join(dataDir, 'logs'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --autoplay-policy=no-user-gesture-required --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`,
  };
  const proc = spawn(EXE, [], { env, stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.url.includes('game.local'));
    } catch {
      // 아직 시작 중
    }
  }
  if (!target) throw new Error('실행 파일의 게임 화면에 연결하지 못했습니다');
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  return { proc, target, dataDir, version };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const result = { date: new Date().toISOString(), exe: EXE, checks: [], runs: [], errors: [], notes: [] };
  const check = (name, ok, detail) => {
    result.checks.push({ name, ok, detail });
    log(ok ? 'PASS' : 'FAIL', name, detail ?? '');
  };

  const { proc, target, dataDir, version } = await launch();
  result.webview = version.Browser;
  result.dataDir = dataDir;
  log('연결', version.Browser, target.url);
  const c = await Cdp.connect(target.webSocketDebuggerUrl);
  c.on('Runtime.exceptionThrown', (p) => result.errors.push(`예외: ${p.exceptionDetails.exception?.description ?? p.exceptionDetails.text}`));
  c.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'warning') result.errors.push(`${p.type}: ${p.args.map((a) => a.value ?? a.description).join(' ')}`);
  });
  c.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error') result.errors.push(`log: ${p.entry.text} ${p.entry.url ?? ''}`);
  });
  await c.send('Page.enable');
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  // 테스트 중 다른 창을 눌러도 포커스를 잃은 것으로 보지 않게 한다(포커스 시험은 따로 한다).
  await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PRELOAD });
  await c.send('Page.reload');
  await sleep(1500);
  await c.eval(PAGE_HELPERS);
  const hud = () => c.eval('__v.hud()');

  result.gpu = await c.eval(`(() => { const g = document.createElement('canvas').getContext('webgl2'); const e = g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER); })()`);
  log('GPU', result.gpu);

  try {
    // 1) 시작 화면 → 게임 시작 → 처음 실행이므로 조작 방식 선택 → 마우스
    await waitFor(c, `document.querySelector('#screens h1')?.textContent === 'TestGunGame'`, 10000, '시작 화면');
    await shot(c, '01-title');
    const h0 = await hud();
    result.window = { vw: h0.vw, vh: h0.vh };
    await clickButton(c, '게임 시작');
    await waitFor(c, `[...document.querySelectorAll('#screens button')].some((b) => b.textContent === '마우스로 플레이')`, 5000, '조작 방식 선택');
    await shot(c, '02-setup');
    await clickButton(c, '마우스로 플레이');
    await waitFor(c, `__v.hud().hudVisible && __v.hud().ammo === '6/6'`, 5000, '전투 시작');
    check('시작 → 조작 선택 → 전투 진입', true);
    const audio = await c.eval(`({ n: __audio.contexts.length, state: __audio.contexts[0]?.state })`);
    check('소리 출력 준비(AudioContext running)', audio.state === 'running', JSON.stringify(audio));

    // 2) 좌표 변환: 마우스 위치 = 조준점 위치(창 모드)
    await checkAim(c, '창 모드', check);

    // 3) 탄약 0 → 빈 탄창, 엄폐 0.8초 장전. 첫 웨이브 등장 전 하늘을 쏜다.
    await move(c, h0.vw * 0.5, h0.vh * 0.08);
    for (let i = 0; i < 6; i++) {
      await click(c, h0.vw * (0.3 + i * 0.08), h0.vh * 0.08);
      await sleep(40);
    }
    const afterSix = await hud();
    await click(c, h0.vw * 0.5, h0.vh * 0.08);
    await sleep(80);
    const empty = await hud();
    check('6발 발사 후 탄창 0, 추가 발사 시 빈 탄창 안내', afterSix.ammo === '0/6' && empty.ammo === '0/6' && empty.toast.includes('빈 탄창'), `${afterSix.ammo} → ${empty.ammo} "${empty.toast}"`);
    await key(c, 'Space', 'keyDown');
    const t0 = Date.now();
    await waitFor(c, `__v.hud().ammo === '6/6'`, 3000, '엄폐 장전');
    const reloadMs = Date.now() - t0;
    await shot(c, '03-cover');
    await key(c, 'Space', 'keyUp');
    check('엄폐 유지 0.8초 후 6발 장전', reloadMs >= 750 && reloadMs < 1200, `${reloadMs}ms(입력 전달 지연 포함)`);

    // 4) 일시정지(Esc) → 재개
    await key(c, 'Escape', 'keyDown');
    await key(c, 'Escape', 'keyUp');
    await waitFor(c, `__v.hud().screen === '일시정지'`, 2000, '일시정지');
    await clickButton(c, '재개');
    await waitFor(c, `__v.hud().screen === ''`, 2000, '재개');
    check('Esc 일시정지 → 재개', true);

    // 5) 창 모드: 게임은 작업 표시줄을 가리지 않는 최대화 창으로 실행된다(전체 화면을 요청하지 않는다).
    const win = await c.eval(`({ outerBottom: screenY + outerHeight, availBottom: (screen.availTop ?? 0) + screen.availHeight, screenH: screen.height, vw: innerWidth, vh: innerHeight })`);
    const cv = (await hud()).canvas;
    check(
      '작업 표시줄이 보이는 창 · 게임 영역 = 창 크기',
      win.outerBottom <= win.availBottom + 8 && win.availBottom < win.screenH && cv.cw === win.vw && cv.ch === win.vh,
      `창 아래 ${win.outerBottom}px ≤ 작업 영역 ${win.availBottom}px (화면 ${win.screenH}px) · 캔버스 ${cv.w}×${cv.h}`,
    );
    result.window = { ...result.window, ...win, canvas: cv };
    await sleep(2500);
    await shot(c, '05-combat');
    result.firstScan = await c.eval('__v.scan()');

    // 6) 이번 판은 그대로 완주(성능 측정 포함), 이후 결과 화면에서 다시 도전으로 연속 진행
    const allFrames = [];
    for (let i = 0; i < RUNS; i++) {
      const { frames, ...run } = await playRun(c);
      allFrames.push(...(frames ?? []));
      result.runs.push(run);
      log(`판 ${i + 1}:`, run.outcome, JSON.stringify(run.stats));
      await shot(c, `10-result-${i + 1}`);
      await clickButton(c, '다시 도전');
      await waitFor(c, `__v.hud().hudVisible && __v.hud().screen === ''`, 5000, '다시 도전');
      const r = await hud();
      check(`판 ${i + 1} 후 다시 도전 초기화`, r.ammo === '6/6' && r.hp === 5 && r.time.includes('3:00'), `${r.ammo} hp${r.hp} ${r.time}`);
    }
    // 성능: 최대화 창(1920×1009) 전투 중 프레임 시간. 화면 인식으로 픽셀을 읽은 직후 프레임은 제외한다.
    result.perf = summarize(allFrames);
    if (RUNS > 0)
      check('성능: 최대화 창 프레임 시간 95백분위 20ms 이하, 측정 60초 이상', result.perf.p95Ms <= 20 && result.perf.totalSec >= 60, JSON.stringify(result.perf));

    // 7) 실패: 엄폐하지 않고 버틴다 → 임무 실패 → 다시 도전
    const failT0 = Date.now();
    await waitFor(c, `__v.hud().screen === '임무 실패'`, 120000, '임무 실패');
    await shot(c, '20-failed');
    const failText = (await hud()).screenText;
    check('피격으로 임무 실패 화면', true, `${((Date.now() - failT0) / 1000).toFixed(0)}초 · ${failText.slice(0, 80)}`);
    await clickButton(c, '다시 도전');
    await waitFor(c, `__v.hud().hudVisible && __v.hud().screen === ''`, 5000, '실패 후 다시 도전');
    const rf = await hud();
    check('실패 후 다시 도전 초기화', rf.ammo === '6/6' && rf.hp === 5, `${rf.ammo} hp${rf.hp} ${rf.time}`);

    const fs2 = await hud();

    // 9) 포커스 상실: 엄폐·방아쇠를 누른 채 창이 포커스를 잃는다 → 일시정지 → 재개 후 고착 없음
    await move(c, fs2.vw * 0.5, fs2.vh * 0.1);
    await key(c, 'Space', 'keyDown');
    await mouseDown(c);
    await sleep(200);
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    await c.eval(`window.dispatchEvent(new Event('blur'))`);
    await waitFor(c, `__v.hud().screen === '일시정지'`, 2000, '포커스 상실 일시정지');
    const blurText = (await hud()).screenText;
    await c.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    // 포커스를 잃은 동안 놓은 버튼은 게임에 전달되지 않는다고 가정: 놓지 않은 채 재개를 누른다.
    await c.eval(`document.querySelectorAll('#screens button')[0].click()`);
    await sleep(1200);
    const stuck = await hud();
    check('포커스 상실 시 일시정지, 재개 후 누르고 있던 엄폐·방아쇠 무시', blurText.includes('포커스') && !stuck.cover && stuck.ammo === '6/6', `엄폐 ${stuck.cover} 탄 ${stuck.ammo}`);
    await key(c, 'Space', 'keyUp');
    await mouseUp(c);
    await key(c, 'Space', 'keyDown');
    await sleep(300);
    const again = await hud();
    await key(c, 'Space', 'keyUp');
    check('버튼을 놓았다 다시 누르면 정상 동작', again.cover, again.stance);

    // 10) 정확도 측정 화면(T11용)을 마우스로 끝까지 진행한다. 마우스는 오차 0이어야 한다.
    await key(c, 'Escape', 'keyDown');
    await key(c, 'Escape', 'keyUp');
    await waitFor(c, `__v.hud().screen === '일시정지'`, 2000, '측정 전 일시정지');
    await clickButton(c, '메뉴로');
    await waitFor(c, `__v.hud().screen === 'TestGunGame'`, 2000, '메뉴');
    await clickButton(c, '정확도 측정');
    await waitFor(c, `__v.hud().screen === '정확도 측정'`, 2000, '정확도 측정 화면');
    await clickButton(c, '조준점 보며 측정');
    for (let i = 0; i < 90; i++) {
      const t = await waitFor(c, `(() => { const e = document.querySelector('#accuracy .target'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top }; })()`, 2000, '표적');
      await click(c, t.x, t.y);
      await sleep(40);
    }
    await waitFor(c, `__v.hud().screen.includes('조준점 보며')`, 3000, '조준 결과');
    await shot(c, '30-accuracy-result');
    const acc = await hud();
    check('정확도 측정(마우스): 9지점 × 10발, 오차 0', acc.screen.includes('통과') && acc.screenText.includes('오차 90백분위 0.00%'), acc.screenText.slice(0, 120));
    await clickButton(c, '다음: 방아쇠 시험');
    await sleep(300);
    const m = (await hud()).vw;
    await move(c, m * 0.5, 300);
    for (let i = 0; i < 30; i++) {
      await mouseDown(c);
      await sleep(30);
      await mouseUp(c);
      await sleep(70);
    }
    await mouseDown(c);
    await sleep(2000);
    await mouseUp(c);
    await sleep(100);
    await key(c, 'Space', 'keyDown');
    await sleep(150); // 게임은 프레임마다 누름 상태를 보므로 한 프레임보다 길게 누른다
    await key(c, 'Space', 'keyUp');
    await waitFor(c, `__v.hud().screen.includes('방아쇠 시험')`, 3000, '방아쇠 결과');
    const trig = await hud();
    check('방아쇠 시험(마우스): 30회 + 길게 1회 = 31회, 중복 없음', trig.screen === '방아쇠 시험 통과', trig.screenText.slice(0, 120));
    await clickButton(c, '다음: 연결 시험');
    await waitFor(c, `__v.hud().screen === '연결 시험'`, 2000, '연결 시험');
    await shot(c, '31-loss');
    await clickButton(c, '완료');
    await waitFor(c, `__v.hud().screen === 'TestGunGame'`, 2000, '측정 후 메뉴');

    // 11) 실행 파일이 기록 파일을 남겼는지
    await sleep(500);
    const logFile = path.join(dataDir, 'logs', 'hw-check.log');
    const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    const kinds = (k) => lines.filter((l) => l.kind === k);
    check(
      '실행 파일 기록(hw-check.log): 판 결과·일시정지·측정 결과',
      kinds('game-end').length === RUNS + 1 && kinds('pause').length >= 3 && kinds('accuracy-result')[0]?.pass === true && kinds('trigger-result')[0]?.pass === true,
      `${lines.length}줄 · game-end ${kinds('game-end').length} · pause ${kinds('pause').length} · accuracy ${kinds('accuracy-result').length} · trigger ${kinds('trigger-result').length}`,
    );
  } catch (e) {
    result.notes.push(`중단: ${e.message}`);
    log('중단', e.message);
    await shot(c, '99-abort').catch(() => undefined);
  }

  result.passed = result.checks.every((x) => x.ok) && result.notes.length === 0 && result.runs.every((r) => r.outcome === '스테이지 클리어');
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  log('오류', result.errors.length, result.errors.slice(0, 5));
  log(result.passed ? '전체 통과' : '실패 있음', path.join(OUT, 'result.json'));
  proc.kill();
  await sleep(500);
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
}

/** 화면 9지점에 마우스를 놓고 조준점 중심과의 차이를 잰다. */
async function checkAim(c, label, check) {
  const { vw, vh } = await c.eval('__v.hud()');
  let worst = 0;
  for (const fy of [0.15, 0.5, 0.85])
    for (const fx of [0.15, 0.5, 0.85]) {
      await move(c, vw * fx, vh * fy);
      await sleep(60);
      const ch = (await c.eval('__v.hud()')).crosshair;
      if (!ch) {
        worst = Infinity;
        continue;
      }
      worst = Math.max(worst, Math.hypot(ch.x - vw * fx, ch.y - vh * fy));
    }
  check(`좌표 변환(${label}, 9지점 조준점 = 마우스)`, worst <= 1.5, `최대 차이 ${worst.toFixed(2)}px · ${vw}×${vh}`);
}

/** 한 판을 끝까지 플레이한다. 경고가 보이거나 탄이 없으면 엄폐, 아니면 로봇 머리를 쏜다. */
async function playRun(c) {
  const t0 = Date.now();
  let covering = false;
  let shots = 0;
  let damagedInCover = 0;
  let lastHp = 5;
  await c.eval('__v.startFrames()');
  while (Date.now() - t0 < 6 * 60 * 1000) {
    const h = await c.eval('__v.hud()');
    if (h.screen === '스테이지 클리어' || h.screen === '임무 실패') {
      const frames = await c.eval('__v.stopFrames()');
      if (covering) await key(c, 'Space', 'keyUp');
      const stats = Object.fromEntries(
        [...h.screenText.matchAll(/(점수|플레이 시간|발사 수|명중 수|명중률|처치 수|머리 명중|피해 횟수)([\d,:%/]+)/g)].map((m) => [m[1], m[2]]),
      );
      return { outcome: h.screen, seconds: Math.round((Date.now() - t0) / 1000), botShots: shots, damagedInCover, stats, perf: summarize(frames), frames };
    }
    if (h.screen === '일시정지') {
      await clickButton(c, '재개');
      continue;
    }
    if (h.hp < lastHp && covering && h.cover) damagedInCover++;
    lastHp = h.hp;
    if (h.stance.includes('이동')) {
      if (covering) await key(c, 'Space', 'keyUp');
      covering = false;
      await sleep(100);
      continue;
    }
    // 탄이 없으면 엄폐해 장전한다. 장전이 끝날 때까지 유지한다.
    const reloading = h.ammo.startsWith('0/') || (covering && !h.ammo.startsWith('6/'));
    if (reloading) {
      if (!covering) await key(c, 'Space', 'keyDown');
      covering = true;
      await sleep(60);
      continue;
    }
    if (covering) {
      await key(c, 'Space', 'keyUp');
      covering = false;
      await sleep(250); // 엄폐 해제 후 카메라가 올라올 시간
      continue;
    }
    const s = await c.eval('__v.scan()');
    // 공격 예고를 띄운 적을 먼저 쏜다(처치하면 공격이 취소된다).
    const t = s.warnX !== null && s.targets.length ? [...s.targets].sort((a, b) => Math.abs(a.x - s.warnX) - Math.abs(b.x - s.warnX))[0] : s.targets[0];
    if (t) {
      await click(c, t.x * h.vw, t.y * h.vh);
      shots++;
      await sleep(90);
    } else await sleep(60);
  }
  return { outcome: '시간 초과(검증 스크립트)', seconds: 360, botShots: shots, damagedInCover, stats: {}, frames: await c.eval('__v.stopFrames()') };
}

function summarize(frames) {
  if (!frames || frames.length === 0) return null;
  const s = [...frames].sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    samples: s.length,
    totalSec: +(s.reduce((a, b) => a + b, 0) / 1000).toFixed(1),
    avgMs: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2),
    p50Ms: +pct(0.5).toFixed(2),
    p95Ms: +pct(0.95).toFixed(2),
    p99Ms: +pct(0.99).toFixed(2),
    maxMs: +s[s.length - 1].toFixed(2),
    over20ms: s.filter((v) => v > 20).length,
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

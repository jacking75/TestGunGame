// Wii 총 검증 앱의 흐름 확인: 실행 파일을 모의 입력(--sim, 마우스 = 총)으로 띄우고 16단계를 끝까지 진행한다.
// 실제 리모컨은 쓰지 않는다. 사용자 데이터를 건드리지 않도록 임시 데이터 폴더를 쓴다.
//
//   npm run hwtest:build && npm run hwtest:verify
//
// 결과: logs/hwtest/result.json, 단계별 화면 캡처. WebView2 디버깅 포트는 로컬 규칙(TCP 25001~25199) 안의 25005를 쓴다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 25005;
const OUT = path.resolve('logs/hwtest');
const EXE = path.resolve('hwtest/host/bin/Release/net48/WiiHwTest.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
      }
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
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
}

let c;
let view = { w: 0, h: 0 };
const mouse = { x: 0, y: 0 };
const BUTTON = { left: 1, right: 2 };

async function move(nx, ny) {
  mouse.x = nx * view.w;
  mouse.y = ny * view.h;
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mouse.x, y: mouse.y });
}
async function press(button = 'left') {
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mouse.x, y: mouse.y, button, buttons: BUTTON[button], clickCount: 1 });
}
async function release(button = 'left') {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mouse.x, y: mouse.y, button, buttons: 0, clickCount: 1 });
}
async function click(button = 'left', holdMs = 60) {
  await press(button);
  await sleep(holdMs);
  await release(button);
}
async function keyDown(code, k) {
  await c.send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: k });
}
async function keyUp(code, k) {
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: k });
}
async function key(code, k) {
  await keyDown(code, k);
  await sleep(60);
  await keyUp(code, k);
}
/** 9곳 정확도 표적을 표적당 n발씩 맞힌다 */
async function shootGrid(n) {
  for (const y of [0.2, 0.5, 0.8])
    for (const x of [0.2, 0.5, 0.8]) {
      await move(x + 0.004, y);
      await sleep(60);
      for (let k = 0; k < n; k++) {
        await click();
        await sleep(90);
      }
    }
}
const step = () => c.eval('window.__hwtest.runner.step');
const title = () => c.eval("document.querySelector('.say h1').textContent");

async function waitStep(id, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if ((await step()) === id) return;
    await sleep(100);
  }
  throw new Error(`단계 ${id}에 도달하지 못함 (현재 ${await step()}, 화면 "${await title()}")`);
}
async function shot(name) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wht-verify-'));
  const env = {
    ...process.env,
    WHT_DATA_DIR: dataDir,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} --autoplay-policy=no-user-gesture-required --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling`,
  };
  const proc = spawn(EXE, ['--sim'], { env, stdio: 'ignore' });
  const checks = [];
  try {
    let page;
    for (let i = 0; i < 100 && !page; i++) {
      await sleep(200);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        page = list.find((p) => p.type === 'page' && p.url.includes('hwtest.local'));
      } catch {
        // 아직 시작 중
      }
    }
    if (!page) throw new Error('검증 앱 페이지를 찾지 못함');
    c = await Cdp.connect(page.webSocketDebuggerUrl);
    for (let i = 0; i < 50 && !(await c.eval('!!window.__hwtest').catch(() => false)); i++) await sleep(100);
    view = await c.eval('({ w: window.innerWidth, h: window.innerHeight })');
    log('창 크기', view);
    await move(0.5, 0.5);

    await waitStep('feedback');
    for (let k = 0; k < 3; k++) {
      await sleep(700);
      await click();
    }
    await waitStep('sensor', 5000);
    await waitStep('calibrate');
    await shot('04-calibrate');
    for (const [x, y] of [[0.18, 0.18], [0.82, 0.18], [0.82, 0.82], [0.18, 0.82], [0.5, 0.5]]) {
      await move(x, y);
      await sleep(150);
      await click();
      await sleep(700);
    }
    for (const [id, n] of [['aim', 3], ['sight', 3]]) {
      await waitStep(id);
      await shot(`05-${id}`);
      await shootGrid(n);
      await sleep(500);
    }
    await waitStep('posture', 8000);
    await shot('07-posture');
    await click();
    await sleep(300);
    await shootGrid(1);
    await waitStep('trigger', 8000);
    for (let k = 0; k < 10; k++) {
      await click();
      await sleep(120);
    }
    await sleep(300);
    await click('left', 2300);
    await waitStep('buttons', 5000);
    await click('right', 1200);
    for (const [code, k] of [['Equal', '='], ['Minus', '-'], ['KeyH', 'h'], ['ArrowUp', 'ArrowUp'], ['ArrowDown', 'ArrowDown'], ['ArrowLeft', 'ArrowLeft']]) {
      await key(code, k);
      await sleep(120);
    }
    await shot('09-buttons');
    await key('ArrowRight', 'ArrowRight');
    await key('Digit1', '1');
    await waitStep('block', 6000);
    await key('KeyK', 'k');
    await sleep(1400);
    await click();
    await sleep(300);
    await shot('10-block');
    await key('KeyK', 'k');
    await waitStep('roll', 5000);
    await move(0.5, 0.55);
    await sleep(800);
    await key('KeyQ', 'q');
    await sleep(800);
    await key('KeyE', 'e');
    await sleep(800);
    await waitStep('move', 5000);
    await shot('12-move');
    for (const [code, k, x] of [['ArrowUp', 'ArrowUp', 0.3], ['ArrowLeft', 'ArrowLeft', 0.7]]) {
      await keyDown(code, k);
      await move(x, 0.55);
      await sleep(100);
      for (let n = 0; n < 10; n++) {
        await click();
        await sleep(100);
      }
      await keyUp(code, k);
      await sleep(200);
    }
    await sleep(600);
    await click();
    await waitStep('play', 5000);
    let shotPlay = false;
    for (let guard = 0; guard < 400 && (await step()) === 'play'; guard++) {
      const g = await c.eval('(() => { const p = window.__hwtest.runner.s.play; return p && { alive: p.alive, ammo: p.ammo, pause: p.pauseState }; })()');
      if (!g) {
        await sleep(100);
        continue;
      }
      if (!shotPlay && g.alive.length === 2) {
        await shot('13-play');
        shotPlay = true;
      }
      if (g.pause === 'ask') {
        await sleep(200);
        await key('Equal', '=');
      } else if (g.pause === 'paused') {
        await sleep(200);
        await click();
      } else if (g.ammo === 0) {
        await click('right', 1000);
      } else if (g.alive.length) {
        await move(g.alive[0].x, g.alive[0].y);
        await sleep(60);
        await click();
      }
      await sleep(80);
    }
    await waitStep('focus', 5000);
    await press();
    await keyDown('ArrowUp', 'ArrowUp');
    await c.eval("window.dispatchEvent(new Event('blur'))");
    await sleep(300);
    await release();
    await keyUp('ArrowUp', 'ArrowUp');
    await c.eval("window.dispatchEvent(new Event('focus'))");
    await sleep(200);
    await click();
    await waitStep('power', 6000);
    await sleep(300);
    await key('KeyP', 'p');
    await sleep(700);
    await key('KeyP', 'p');
    await waitStep('done', 6000);
    await sleep(800);
    await shot('16-done');

    const results = await c.eval('JSON.parse(JSON.stringify(window.__hwtest.runner.results))');
    for (const [id, r] of Object.entries(results)) checks.push({ id, pass: r.pass, text: r.text });
    const saved = fs.readdirSync(path.join(dataDir, 'results'));
    const logLines = fs.readFileSync(path.join(dataDir, 'logs', 'hw-test.log'), 'utf8').trim().split('\n').length;
    const recs = fs.existsSync(path.join(dataDir, 'recordings')) ? fs.readdirSync(path.join(dataDir, 'recordings')) : [];
    const ok = recs.length === 1 && checks.length === 15 && checks.every((x) => x.pass) && saved.length === 1;
    fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ ok, view, checks, savedResult: saved[0], recording: recs[0], logLines }, null, 2));
    for (const x of checks) log(x.pass ? '통과' : '미달', x.id, x.text);
    log(ok ? '흐름 확인 통과' : '흐름 확인 실패', `결과 파일 ${saved.length}개, 녹화 파일 ${recs.length}개, 기록 ${logLines}줄`);
    process.exitCode = ok ? 0 : 1;
  } catch (e) {
    log('오류', e.message);
    if (c) await shot('error').catch(() => undefined);
    process.exitCode = 1;
  } finally {
    proc.kill();
  }
}

main();

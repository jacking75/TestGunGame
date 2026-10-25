// 배포용 압축 파일 만들기: app:build 결과에서 실행에 필요한 파일만 모아 설치 없이 풀어서 실행하는 zip으로 묶는다.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const src = path.resolve('host/bin/Release/net10.0');
if (!fs.existsSync(path.join(src, 'TestGunGame.exe')) || !fs.existsSync(path.join(src, 'game', 'index.html'))) {
  execSync('npm run app:build', { stdio: 'inherit' });
}

const name = `TestGunGame-${pkg.version}`;
const outDir = path.resolve('release');
const stage = path.join(outDir, name);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

// 디버그 기호(.pdb)는 넣지 않는다. 나머지(실행 파일·.NET 런타임·Avalonia·WebView2 라이브러리·game 폴더)는 모두 필요하다.
for (const entry of fs.readdirSync(src)) {
  if (entry.endsWith('.pdb')) continue;
  fs.cpSync(path.join(src, entry), path.join(stage, entry), { recursive: true });
}
fs.writeFileSync(
  path.join(stage, '읽어보기.txt'),
  [
    'TestGunGame — Wii 리모컨 총 게임',
    '',
    '실행: 압축을 푼 폴더에서 TestGunGame.exe를 실행한다. 설치·드라이버·인증서가 필요 없다.',
    '필요: Windows 10/11(WebView2 런타임 기본 포함), 블루투스, Wii 리모컨(RVL-CNT-01), USB 센서바.',
    '처음 연결: 게임을 켠 뒤 리모컨 배터리 칸의 빨간 SYNC 버튼을 누른다. 다음부터는 게임을 켜고 아무 버튼이나 누르면 연결된다.',
    '리모컨 끄기: 전원 버튼으로는 꺼지지 않는다. 오래 쓰지 않을 때는 건전지를 뺀다.',
    '마우스·키보드로도 할 수 있다: 마우스 = 조준·발사, Space = 엄폐·장전, Esc = 일시정지.',
    '기록 파일: %LOCALAPPDATA%\\TestGunGame\\logs',
    '',
  ].join('\r\n'),
  'utf8',
);

const zip = path.join(outDir, `${name}.zip`);
fs.rmSync(zip, { force: true });
// Windows 10 이상에 들어 있는 tar(bsdtar)로 zip을 만든다. Git의 GNU tar가 먼저 잡히면 zip을 못 만들므로 경로를 지정한다.
const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
execSync(`"${tar}" -a -c -f "${zip}" -C "${outDir}" "${name}"`, { stdio: 'inherit' });
fs.rmSync(stage, { recursive: true, force: true });
console.log(`\n배포 압축 파일: ${zip} (${(fs.statSync(zip).size / 1024 / 1024).toFixed(1)}MB)`);

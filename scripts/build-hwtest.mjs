// Wii 총 검증 앱 만들기: 화면 빌드(hwtest/dist) → C# 실행 파일 빌드 → 화면을 실행 파일 옆 web 폴더로 복사
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
run('npx vite build --config hwtest/vite.config.ts');
run('dotnet build hwtest/host -c Release --nologo -v q');
const out = path.resolve('hwtest/host/bin/Release/net10.0');
const web = path.join(out, 'web');
fs.rmSync(web, { recursive: true, force: true });
fs.cpSync(path.resolve('hwtest/dist'), web, { recursive: true });
console.log(`\n검증 앱 실행 파일: ${path.join(out, 'WiiHwTest.exe')}`);

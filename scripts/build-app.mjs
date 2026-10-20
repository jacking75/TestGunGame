// 배포용 게임 실행 파일 만들기: 웹 빌드(dist) → C# 호스트 빌드 → dist를 실행 파일 옆 game 폴더로 복사
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
run('npm run build');
run('dotnet build host -c Release --nologo -v q');
const out = path.resolve('host/bin/Release/net48');
const game = path.join(out, 'game');
fs.rmSync(game, { recursive: true, force: true });
fs.cpSync(path.resolve('dist'), game, { recursive: true });
console.log(`\n게임 실행 파일: ${path.join(out, 'TestGunGame.exe')}`);

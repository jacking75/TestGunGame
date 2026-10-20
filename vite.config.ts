/// <reference types="vitest/config" />
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * 개발 서버 전용: 브라우저가 보낸 리모컨 진단 기록을 logs/hw-check.log에 한 줄씩 남긴다.
 * 실물 확인(T03·T04) 결과를 화면 숫자를 받아 적지 않고 파일로 판정하기 위한 것이다.
 */
function hardwareLog(): Plugin {
  const file = path.resolve('logs/hw-check.log');
  return {
    name: 'hardware-log',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__hwlog', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.appendFileSync(file, body.trim() + '\n');
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

// 개발 포트는 로컬 규칙(TCP 25001~25199) 안에서만 사용한다.
export default defineConfig({
  plugins: [hardwareLog()],
  server: { port: 25001, strictPort: true },
  preview: { port: 25002, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1024 },
  test: { environment: 'node' },
});

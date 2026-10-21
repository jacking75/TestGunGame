import path from 'node:path';
import { defineConfig } from 'vite';

// Wii 총 검증 앱(게임과 별개). 개발 포트는 로컬 규칙(TCP 25001~25199) 안에서 고른다.
export default defineConfig({
  root: path.resolve(__dirname),
  base: './',
  server: { port: 25004, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});

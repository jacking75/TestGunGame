/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// 개발 포트는 로컬 규칙(TCP 25001~25199) 안에서만 사용한다.
export default defineConfig({
  server: { port: 25001, strictPort: true },
  preview: { port: 25002, strictPort: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 1024 },
  test: { environment: 'node' },
});

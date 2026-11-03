import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

declare const process: { env: Record<string, string | undefined> };

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // 开发时把 API 请求代理到本地 Node 服务（npm run server / npm run dev:all）
      '/api': {
        target: process.env.STRU_API_URL ?? 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/ws': {
        target: process.env.STRU_API_URL ?? 'http://127.0.0.1:8787',
        ws: true,
        changeOrigin: true,
      },
    },
  },
});

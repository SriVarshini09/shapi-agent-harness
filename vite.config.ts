import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'web',
  build: { outDir: '../web-dist', emptyOutDir: true },
  server: { port: 5177, proxy: { '/api': 'http://127.0.0.1:3007' } },
});

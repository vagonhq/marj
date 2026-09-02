import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.MARJ_PORT ?? '4711';

export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true },
    },
  },
});

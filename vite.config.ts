import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command, mode }) => {
  const server =
    command === 'serve'
      ? (() => {
          const env = loadEnv(mode, process.cwd(), '');
          const backend = env.VITE_DEV_BACKEND_URL || 'http://127.0.0.1:8765';
          return {
            port: 5173,
            proxy: {
              '/api': { target: backend, changeOrigin: true },
              '/health': { target: backend, changeOrigin: true },
              '/ws': { target: backend, changeOrigin: true, ws: true },
            },
          };
        })()
      : undefined;

  return {
    plugins: [react()],
    server,
    build: {
      outDir: 'dist',
    },
  };
});

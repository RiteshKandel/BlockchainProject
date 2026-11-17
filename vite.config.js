import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: { exclude: ['ethers'] },
  server: { host: '127.0.0.1' }
});

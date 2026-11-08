import { defineConfig } from 'vite';

// base './' makes the build work from any GitHub Pages sub-path (user.github.io/repo/).
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});

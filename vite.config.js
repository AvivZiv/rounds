import { defineConfig } from 'vite';

// base './' makes the build work from any GitHub Pages sub-path (user.github.io/repo/).
export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  plugins: [devTreeGenerator()],
});

/**
 * Dev only: lets LOCAL MODE build knowledge trees by running the generator in-process
 * (Claude Code CLI under the developer's login). In production the laptop generator
 * (tools/generator.mjs) does this against Supabase.
 */
function devTreeGenerator() {
  return {
    name: 'rounds-dev-tree',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__tree', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
        let body = '';
        for await (const chunk of req) body += chunk;
        try {
          const { generate } = await import('./tools/tree-gen.mjs');
          const { item, ctx } = JSON.parse(body);
          const out = await generate(item, ctx);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(out));
        } catch (e) {
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    },
  };
}

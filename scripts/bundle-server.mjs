/**
 * Bundle server.js → build/server.js
 *
 * Resolves all src/lib/server/** and src/lib/shared/** TypeScript into a
 * single ESM file. Native addons and the SvelteKit handler stay external
 * so they resolve from node_modules / build/ at runtime.
 *
 * Run: `node scripts/bundle-server.mjs`  (called automatically by `pnpm build`)
 */

import { build } from 'esbuild';
import { resolve } from 'node:path';

/**
 * server.js imports `./build/handler.js` (correct at repo root). After
 * bundling into build/server.js the path must become `./handler.js`.
 * esbuild aliases can't use relative paths, so we use a resolve plugin.
 */
const handlerRewritePlugin = {
  name: 'rewrite-handler',
  setup(build) {
    build.onResolve({ filter: /^\.\/build\/handler\.js$/ }, () => ({
      path: './handler.js',
      external: true,
    }));
  },
};

await build({
  entryPoints: ['server.js'],
  outfile: 'build/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  plugins: [handlerRewritePlugin],

  // SvelteKit $shared alias → src/lib/shared
  alias: {
    $shared: resolve('src/lib/shared'),
  },

  // Keep native addons and npm packages external — they resolve from
  // node_modules at runtime. better-auth ships pre-compiled chunks that
  // pin to zod@4 (`.meta(…)`); inlining them here would resolve `import
  // 'zod'` to the app's top-level zod@3 and crash. Externalizing lets
  // Node's resolver hand better-auth its own zod@4 from its sub-tree.
  external: [
    'better-sqlite3',
    '@node-rs/argon2',
    'better-auth',
    'better-auth/cookies',
    'ws',
    'execa',
    'chokidar',
    'jsonc-parser',
    'strip-ansi',
    'ulid',
    'zod',
    'web-push',
    '@sveltejs/kit',
    // playwright pulls in chromium-bidi via dynamic require which esbuild
    // can't statically resolve — keep the entire package external so
    // Node's loader handles the chain at runtime.
    'playwright',
    'playwright-core',
  ],

  // Drop unused code; keep stack traces readable.
  treeShaking: true,
  sourcemap: true,
  minify: false,

  logLevel: 'warning',
  banner: {
    js: '// Multi-Agent Workbench — bundled production server entry\n',
  },
});

console.log('[maw] build/server.js bundled');

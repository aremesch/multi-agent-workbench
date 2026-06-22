/**
 * Bundle server.js → build/server.js
 *
 * Resolves all src/lib/server/** and src/lib/shared/** TypeScript into a
 * single ESM file. Every npm package and the SvelteKit handler stay external
 * so they resolve from node_modules / build/ at runtime (see the
 * `packages: 'external'` note below for why).
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

  // Externalize every npm package: leave all bare-specifier imports as
  // runtime imports resolved from node_modules and bundle only our own
  // source (relative imports + the $shared alias). node_modules is already
  // present at runtime (the deploy installs prod deps), so this changes
  // nothing about deployment — but it removes a whole class of boot crash.
  //
  // Three reasons a package MUST stay external, all covered by this:
  //   - Native addons (better-sqlite3, @node-rs/argon2) can't be bundled.
  //   - CJS deps that call require() dynamically — jsdom (via
  //     isomorphic-dompurify), @kwsites/file-exists (via simple-git),
  //     chromium-bidi (via playwright) — otherwise hit esbuild's __require2
  //     shim, which throws `Dynamic require of "X" is not supported` at
  //     runtime. This bit us three times; externalizing every package stops
  //     it recurring the next time such a dependency is added.
  //   - better-auth ships pre-compiled chunks pinned to zod@4 (`.meta(…)`);
  //     externalizing lets Node hand it its own zod@4 sub-tree instead of
  //     the app's top-level zod@3.
  packages: 'external',

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

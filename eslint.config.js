// Flat ESLint config (ESLint v9) for SvelteKit 2 + Svelte 5 (runes) + TS.
// Prettier owns formatting — eslint-config-prettier (applied last) switches
// off every stylistic rule so the two tools never fight.
import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import svelteConfig from './svelte.config.js';

export default ts.config(
  {
    // Never lint build output, SvelteKit's generated tree, test/coverage
    // artifacts, or the vendored shadcn-svelte components (generated upstream
    // code that must not be hand-edited — see CLAUDE.md).
    ignores: [
      'node_modules/',
      'build/',
      'dist/',
      '.svelte-kit/',
      'coverage/',
      'playwright-report/',
      'test-results/',
      'src/lib/components/ui/**'
    ]
  },

  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,

  {
    languageOptions: {
      // Server (node) and browser/client code share one config; provide both
      // global sets so neither side trips `no-undef`.
      globals: { ...globals.browser, ...globals.node }
    }
  },

  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: {
      parserOptions: {
        // <script lang="ts"> blocks go to the TS parser; svelteConfig lets the
        // Svelte parser resolve runes, preprocessors, and $-aliases.
        parser: ts.parser,
        svelteConfig
      }
    }
  },

  // Disable formatting rules that overlap with Prettier. Must stay after the
  // recommended sets so it can turn them back off.
  prettier,
  ...svelte.configs.prettier,

  // Project-specific overrides — last so they win over everything above.
  {
    rules: {
      // TypeScript already reports genuinely-undefined identifiers; `no-undef`
      // only adds false positives in this stack (e.g. DOM type names such as
      // NotificationPermission read as "undefined"). typescript-eslint's own
      // guidance is to disable it in TS projects.
      'no-undef': 'off',

      // SvelteKit's resolve()-everywhere rule would require rewriting every
      // goto()/href across the app (25 call sites). Too opinionated/invasive
      // for a lint baseline — leave navigation as-is.
      'svelte/no-navigation-without-resolve': 'off',

      // Real findings worth surfacing but not worth failing the build: they
      // ask for refactors or flag deliberate code. Keep them visible as warns.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-this-alias': 'warn',
      'no-regex-spaces': 'warn',
      // {@html} usages here are sanitized through isomorphic-dompurify.
      'svelte/no-at-html-tags': 'warn',
      'svelte/prefer-svelte-reactivity': 'warn',
      'svelte/prefer-writable-derived': 'warn',
      'svelte/no-unused-svelte-ignore': 'warn',

      // Surface dead code without failing the build; keep the conventional
      // leading-underscore opt-out for intentionally unused bindings.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ]
    }
  }
);

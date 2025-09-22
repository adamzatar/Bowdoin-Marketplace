// eslint.config.mjs
import js from '@eslint/js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import a11y from 'eslint-plugin-jsx-a11y';
import importPlugin from 'eslint-plugin-import';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, 'apps/web');

const IGNORE = [
  '**/node_modules',
  '**/.next',
  '**/dist',
  '**/coverage',
  '**/.turbo',
  '**/.cache',
  '**/build',
  'apps/web/public',
  'apps/web/tailwind.config.cjs',
  'apps/web/postcss.config.cjs',
  'packages/**/generated',
  'packages/**/dist',
];

const PACKAGE_DIRS = [
  '.',
  'apps/web',
  'packages/auth',
  'packages/config',
  'packages/contracts',
  'packages/db',
  'packages/email',
  'packages/observability',
  'packages/queue',
  'packages/rate-limit',
  'packages/security',
  'packages/storage',
  'packages/utils',
].map((dir) => join(__dirname, dir));

export default [
  // Root ignores
  { name: 'root-ignores', ignores: IGNORE },

  // Base JS recommended
  { name: 'javascript-recommended', ...js.configs.recommended },

  // TypeScript (type-aware)
  {
    name: 'typescript-type-aware',
    files: ['**/*.{ts,tsx,mts,cts}'],
    ignores: ['.storybook/**', 'packages/db/scripts/**'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.base.json', './apps/web/tsconfig.json', './packages/*/tsconfig.json'],
        tsconfigRootDir: __dirname,
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      import: importPlugin,
    },
    settings: {
      // Make eslint-plugin-import resolve TypeScript like tsc
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx', '.mts', '.cts'],
      },
      'import/extensions': ['.ts', '.tsx', '.js', '.mjs', '.cjs'],
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: [
            './tsconfig.base.json',
            './packages/*/tsconfig.json',
            './apps/*/tsconfig.json'
          ],
          // Avoid pulling stray tsconfig files from installed packages.
          disableFiles: ['**/node_modules/**'],
        },
        node: {
          extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs'],
          // Keep the resolver focused on workspace sources only.
          // No project lookup needed here.
        },
      },
    },
    rules: {
      // IMPORTANT: turn off base rule so TS-aware rule below is the only one active
      'no-unused-vars': 'off',

      // Core TypeScript strictness
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': ['error', { ignoreIIFE: true }],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/no-namespace': 'off',

      // Import hygiene
      'import/no-unresolved': 'error',
      'import/named': 'error',
      'import/no-duplicates': 'error',
      'import/export': 'error',
      'import/no-extraneous-dependencies': [
        'error',
        {
          // Default coverage for all packages (we override for web below)
          packageDir: PACKAGE_DIRS,
          devDependencies: [
            '**/*.{test,spec}.{ts,tsx,js,jsx}',
            '**/vitest.config.{ts,js,mts,cts}',
            '**/playwright.config.{ts,js}',
            '**/.storybook/**',
            '**/scripts/**',
            '**/eslint.config.{js,mjs,cjs}',
          ],
        },
      ],
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', ['parent', 'sibling', 'index'], 'object', 'type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],

      // General best practices
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'no-throw-literal': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'object-shorthand': ['error', 'always'],
    },
  },

  // React (Next.js app + any React in packages)
  {
    name: 'react',
    files: ['**/*.{tsx,jsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooks,
      'jsx-a11y': a11y,
    },
    languageOptions: { ecmaFeatures: { jsx: true } },
    settings: { react: { version: 'detect' } },
    rules: {
      'react/self-closing-comp': 'error',
      'react/jsx-key': ['error', { checkFragmentShorthand: true }],
      'react/jsx-no-duplicate-props': 'error',
      'react/no-unknown-property': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/anchor-is-valid': 'error',
      'jsx-a11y/aria-roles': 'error',
      'jsx-a11y/no-autofocus': ['warn', { ignoreNonDOM: true }],
      'jsx-a11y/no-redundant-roles': 'warn',
      'jsx-a11y/click-events-have-key-events': 'warn',
      'jsx-a11y/no-static-element-interactions': 'warn',
      'jsx-a11y/tabindex-no-positive': 'warn',

      // Next.js automatic React runtime
      'react/react-in-jsx-scope': 'off',
      'react/jsx-uses-react': 'off',
    },
  },

  // Libraries: prefer named exports
  {
    name: 'workspace-libs',
    files: ['packages/**/src/**/*.{ts,tsx}'],
    rules: { 'import/no-default-export': 'error' },
  },

  // Next.js app: allow default exports
  {
    name: 'next-app-allow-default-exports',
    files: ['apps/web/app/**/*.{ts,tsx}', 'apps/web/src/**/*.{ts,tsx}'],
    rules: { 'import/no-default-export': 'off' },
  },

  // ✅ Pin extraneous-deps to the web app’s own package.json
  {
    name: 'next-app-extraneous-deps',
    files: ['apps/web/app/**/*.{ts,tsx}'],
    settings: {
      'import/core-modules': ['next', 'next/headers'],
      // Ensure resolver uses the app’s tsconfig (helps import-plugin find types)
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
          project: [join(WEB_DIR, 'tsconfig.json')],
        },
        node: {
          extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs'],
          project: [join(WEB_DIR, 'tsconfig.json')],
        },
      },
    },
    rules: {
      'import/no-extraneous-dependencies': [
        'error',
        {
          // Only the web app package.json is authoritative for these files
          packageDir: [WEB_DIR],
          devDependencies: [
            // allow tests/configs in the app itself
            'apps/web/**/*.{test,spec}.{ts,tsx,js,jsx}',
            'apps/web/**/vitest.config.{ts,js,mts,cts}',
            'apps/web/**/playwright.config.{ts,js}',
            'apps/web/.storybook/**',
            'apps/web/**/eslint.config.{js,mjs,cjs}',
          ],
        },
      ],
    },
  },

  {
    name: 'app-web-security-subpaths',
    files: ['apps/web/src/middleware/cspHeaders.ts'],
    settings: {
      'import/core-modules': ['@bowdoin/security/csp', '@bowdoin/security/headers'],
    },
  },

  // Node/infra packages that use Node globals
  {
    name: 'node-globals-utils-and-infra',
    files: [
      'packages/utils/src/**/*.{ts,tsx}',
      'packages/rate-limit/src/**/*.{ts,tsx}',
      'packages/observability/src/**/*.{ts,tsx}',
      'packages/security/src/**/*.{ts,tsx}',
      'packages/storage/src/**/*.{ts,tsx}',
      'packages/config/src/**/*.{ts,tsx}',
    ],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        NodeJS: 'readonly',
        Headers: 'readonly',
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['info', 'warn', 'error'] }],
    },
  },

  // Non type-aware override for Storybook and DB scripts
  {
    name: 'non-type-aware-overrides',
    files: ['.storybook/**/*.{ts,tsx}', 'packages/db/scripts/**/*.{mts,ts}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: null,
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Build tools can use dev deps freely
  {
    name: 'build-tools-allow-dev-deps',
    files: ['**/tsup.config.{ts,js}'],
    rules: { 'import/no-extraneous-dependencies': 'off' },
  },

  // Scripts & config files: relaxed Node env
  {
    name: 'node-scripts',
    files: ['scripts/**/*.{ts,js,mjs,cjs}', '**/*.config.{ts,js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        module: 'readonly',
        require: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
];

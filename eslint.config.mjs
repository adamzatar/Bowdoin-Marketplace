// eslint.config.mjs
import js from '@eslint/js';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

import reactPlugin from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import a11y from 'eslint-plugin-jsx-a11y';
import importPlugin from 'eslint-plugin-import';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Common ignores across the workspace */
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

export default [
  // Root ignores
  { name: 'root-ignores', ignores: IGNORE },

  // Base JS recommended
  { name: 'javascript-recommended', ...js.configs.recommended },

  // TypeScript (type-aware) — exclude Storybook & DB scripts here; they get a non-type-aware override below
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
      'import/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx', '.mts', '.cts'],
      },
      'import/extensions': ['.js', '.mjs', '.ts', '.tsx'],
    },
    rules: {
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
          packageDir: [
            '.', // root
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
          ],
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
          groups: [
            'builtin',
            'external',
            'internal',
            ['parent', 'sibling', 'index'],
            'object',
            'type',
          ],
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
      // React core
      'react/self-closing-comp': 'error',
      'react/jsx-key': ['error', { checkFragmentShorthand: true }],
      'react/jsx-no-duplicate-props': 'error',
      'react/no-unknown-property': 'error',
      // Hooks
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // A11y essentials
      'jsx-a11y/alt-text': 'error',
      'jsx-a11y/anchor-is-valid': 'error',
      'jsx-a11y/aria-roles': 'error',
      'jsx-a11y/no-autofocus': ['warn', { ignoreNonDOM: true }],
      'jsx-a11y/no-redundant-roles': 'warn',
      'jsx-a11y/click-events-have-key-events': 'warn',
      'jsx-a11y/no-static-element-interactions': 'warn',
      'jsx-a11y/tabindex-no-positive': 'warn',

      // Next.js uses automatic React runtime — these should be off
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

  // Non type-aware override for Storybook and DB scripts (prevents parserOptions.project errors)
  {
    name: 'non-type-aware-overrides',
    files: ['.storybook/**/*.{ts,tsx}', 'packages/db/scripts/**/*.{mts,ts}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: null, // disable type-aware parsing for these utility files
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

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';

const IGNORES = [
  '**/node_modules/**',
  '**/.next/**',
  '**/dist/**',
  '**/build/**',
  '**/cdk.out/**',
  '**/.turbo/**',
  '**/*.d.ts',
];

const TS_PROJECTS = [
  'apps/*/tsconfig.json',
  'packages/*/tsconfig.json',
  'infra/tsconfig.json',
  'tsconfig.base.json',
];

export default [
  { ignores: IGNORES },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,mjs,cjs}'],
    plugins: { import: importPlugin },
    settings: {
      'import/resolver': {
        typescript: {
          project: TS_PROJECTS,
          alwaysTryTypes: true,
        },
        node: {
          extensions: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.json'],
        },
      },
    },
    rules: {
      'import/no-unresolved': ['error', { commonjs: true, caseSensitive: true }],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['apps/**/*.{ts,tsx,js,mjs,cjs}'],
    rules: {
      'import/no-internal-modules': [
        'error',
        {
          allow: [
            'next/server',
            'next/headers',
            'next/app',
            'next/navigation',
            'next-auth/react',
            '@bowdoin/observability',
            '@bowdoin/observability/logger',
            '@bowdoin/observability/audit',
            '@bowdoin/observability/metrics',
            '@bowdoin/observability/tracing',
            '@bowdoin/rate-limit',
            '@bowdoin/rate-limit/redisClient',
            '@bowdoin/rate-limit/tokenBucket',
            '@bowdoin/auth/nextauth',
            '@bowdoin/auth/utils/email-token-store',
            '@bowdoin/security/csp',
            '@bowdoin/security/headers',
            '@bowdoin/config/env',
            '@bowdoin/config/flags',
            '@bowdoin/contracts/schemas/*',
            '@bowdoin/email/sendVerificationEmail',
            'dotenv/config',
            '@bowdoin/queue/workers',
            '@/src/server',
            '@/middleware/cspHeaders',
          ],
        },
      ],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: [
      '**/*.config.{js,cjs,mjs,ts}',
      'apps/**/postcss.config.cjs',
      'apps/**/tailwind.config.cjs',
      'commitlint.config.mjs',
      'scripts/**/*.{js,ts,mjs,cjs}',
      'infra/**/*.{ts,js,mjs,cjs}',
    ],
    languageOptions: { sourceType: 'module' },
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      'import/no-extraneous-dependencies': ['error', { devDependencies: true }],
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  {
    files: ['packages/observability/**/*.{ts,tsx}', 'packages/queue/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    files: ['packages/**/*.{ts,tsx,js,mjs,cjs}'],
    rules: {
      'import/no-internal-modules': 'off',
    },
  },
];

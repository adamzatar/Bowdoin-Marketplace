module.exports = {
  rules: {
    'import/no-internal-modules': [
      'error',
      {
        forbid: [
          '@bowdoin/*/src/**',
          '@bowdoin/*/dist/**',
          '@bowdoin/*/build/**',
        ],
        allow: [
          '@bowdoin/observability/logger',
          '@bowdoin/observability/audit',
          '@bowdoin/observability/metrics',
          '@bowdoin/observability/tracing',
          '@bowdoin/rate-limit',
          '@bowdoin/rate-limit/redisClient',
          '@bowdoin/rate-limit/tokenBucket',
          '@bowdoin/email/sendVerificationEmail',
          '@bowdoin/contracts/schemas/*',
          '@bowdoin/config/env'
        ],
      },
    ],
    'import/no-unresolved': ['error', { commonjs: true, caseSensitive: true }],
  },
};
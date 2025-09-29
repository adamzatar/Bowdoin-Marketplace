// apps/web/next.config.mjs

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Transpile workspace packages so TS/ESM output is compatible in Next.
  transpilePackages: [
    '@bowdoin/config',
    '@bowdoin/contracts',
    '@bowdoin/db',
    '@bowdoin/email',
    '@bowdoin/observability',
    '@bowdoin/rate-limit',
    '@bowdoin/security',
    '@bowdoin/storage',
    '@bowdoin/utils',
    '@bowdoin/queue',
    '@bowdoin/auth', // NextAuth entrypoint
  ],

  // Sensible production defaults
  reactStrictMode: true,
  swcMinify: true,
  productionBrowserSourceMaps: false,
  output: 'standalone',

  // Friendlier ESM in monorepos without custom webpack
  experimental: {
    esmExternals: true,
  },

  // Keep builds strict (flip to `true` only to temporarily unblock CI)
  typescript: { ignoreBuildErrors: false },
  eslint: { ignoreDuringBuilds: true },

  // --- Fix: keep thread-stream worker resolved by Node, not bundled by Next ---
  webpack(config, { isServer }) {
    if (isServer) {
      // Preserve any existing externals (array or function)
      const prevExternals = config.externals ?? [];

      // Force these modules to remain CommonJS externals on the server:
      // - thread-stream: pino’s worker transport (spins up a worker thread)
      // - pino: logger (sometimes pulls transports that reference thread-stream)
      // - worker_threads: Node core (don’t let Webpack try to polyfill)
      const serverExternals = [
        { 'thread-stream': 'commonjs thread-stream' },
        { pino: 'commonjs pino' },
        { 'worker_threads': 'commonjs worker_threads' },
      ];

      if (Array.isArray(prevExternals)) {
        config.externals = [...prevExternals, ...serverExternals];
      } else if (typeof prevExternals === 'function') {
        config.externals = async (ctx, cb) => {
          prevExternals(ctx, (err, res) => {
            if (err) return cb(err);
            if (Array.isArray(res)) {
              cb(null, [...res, ...serverExternals]);
            } else if (res && typeof res === 'object') {
              cb(null, [res, ...serverExternals]);
            } else {
              cb(null, serverExternals);
            }
          });
        };
      } else {
        config.externals = serverExternals;
      }
    }

    return config;
  },
};

export default nextConfig;
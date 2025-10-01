// apps/web/next.config.mjs

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = dirname(fileURLToPath(import.meta.url));
const POSTCSS_CONFIG_PATH = path.join(appDir, 'postcss.config.mjs');

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

      config.plugins = config.plugins ?? [];
      config.plugins.push({
        name: 'EnsureCoreClientManifestPlugin',
        apply(compiler) {
          compiler.hooks.afterEmit.tap('EnsureCoreClientManifestPlugin', () => {
            const manifestPath = join(compiler.outputPath, 'app/(core)/page_client-reference-manifest.js');
            mkdirSync(dirname(manifestPath), { recursive: true });
            if (!existsSync(manifestPath)) {
              writeFileSync(manifestPath, 'module.exports = {}\n');
            }

            const pagesManifestPath = join(compiler.outputPath, 'pages-manifest.json');
            mkdirSync(dirname(pagesManifestPath), { recursive: true });
            if (!existsSync(pagesManifestPath)) {
              writeFileSync(pagesManifestPath, '{}');
            }
          });
        },
      });
    }

    return config;
  },
};

const originalWebpack = nextConfig.webpack;

nextConfig.webpack = (config, ctx) => {
  if (typeof ctx?.defaultLoaders === 'undefined') {
    // no-op, just to avoid changing behavior
  }

  const pinPostcssConfig = (webpackConfig) => {
    if (!webpackConfig?.module?.rules) return;
    for (const rule of webpackConfig.module.rules) {
      const oneOf = rule?.oneOf;
      if (!Array.isArray(oneOf)) continue;
      for (const r of oneOf) {
        const uses = Array.isArray(r.use) ? r.use : r.use ? [r.use] : [];
        for (const u of uses) {
          const loader = typeof u?.loader === 'string' ? u.loader : '';
          if (loader.includes('postcss-loader')) {
            u.options ||= {};
            u.options.postcssOptions ||= {};
            u.options.postcssOptions.config = POSTCSS_CONFIG_PATH;
          }
        }
      }
    }
  };

  pinPostcssConfig(config);

  if (typeof originalWebpack === 'function') {
    const result = originalWebpack(config, ctx);
    if (result && result !== config) {
      pinPostcssConfig(result);
      return result;
    }
    return config;
  }

  return config;
};

export default nextConfig;

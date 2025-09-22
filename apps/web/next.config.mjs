/** @type {import('next').NextConfig} */
const nextConfig = {
  // Be explicit: Next should transpile our workspace packages so ESM/TS output is compatible.
  // Include *all* internal packages that may be imported by the app (directly or indirectly).
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
    '@bowdoin/auth', // important: nextauth entrypoint lives here
  ],

  // Good production defaults
  reactStrictMode: true,
  swcMinify: true,
  productionBrowserSourceMaps: false, // flip to true if you want browser sourcemaps in prod
  output: 'standalone',               // simplifies Docker/container deploys

  // Make Next friendlier to monorepo ESM deps (esp. subpath exports)
  experimental: {
    esmExternals: true,
  },

  // Optional: small Webpack nits that help in monorepos
  webpack(config, { isServer }) {
    // Ensure symlinked workspace packages resolve to their source location correctly.
    config.resolve = config.resolve || {};
    config.resolve.symlinks = true;

    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      'node:crypto': 'crypto',
      'node:buffer': 'buffer',
      'node:path': 'path',
      'node:url': 'url',
      'node:fs': 'fs',
    };

    if (!isServer) {
      config.resolve.fallback = {
        ...(config.resolve.fallback ?? {}),
        crypto: false,
        fs: false,
        path: false,
        url: false,
        buffer: false,
      };
    }

    // Some server-only deps may try to resolve in the client bundle via deep imports.
    // Mark a few heavy/optional server libs as externals on client to avoid accidental bundling.
    config.externals = config.externals || [];

    if (isServer) {
      config.externals.push(
        { '@prisma/client': 'commonjs @prisma/client' },
        { '.prisma/client/default': 'commonjs .prisma/client/default' },
      );
    } else {
      config.externals.push(
        { redis: 'redis' },
        { '@prisma/client': '@prisma/client' },
      );
    }

    return config;
  },

  // Keep builds strict. (If you need to *temporarily* unblock CI, you can set these to true.)
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;

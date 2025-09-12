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
    esmExternals: 'loose', // allow ESM CJS interop for server deps
  },

  // Optional: small Webpack nits that help in monorepos
  webpack(config, { isServer }) {
    // Ensure symlinked workspace packages resolve to their source location correctly.
    config.resolve.symlinks = true;

    // Some server-only deps may try to resolve in the client bundle via deep imports.
    // Mark a few heavy/optional server libs as externals on client to avoid accidental bundling.
    if (!isServer) {
      config.externals = config.externals || [];
      config.externals.push(
        { redis: 'redis' },           // never bundle redis in the browser
        { '@prisma/client': '@prisma/client' }
      );
    }

    return config;
  },

  // Keep builds strict. (If you need to *temporarily* unblock CI, you can set these to true.)
  typescript: {
    ignoreBuildErrors: false,
  },
  eslint: {
    ignoreDuringBuilds: false,
  },
};

export default nextConfig;
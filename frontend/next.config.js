/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  experimental: {
    // Disable automatic static optimization for pages using client-side context
    missingSuspenseWithCSRBailout: false,
  },
  images: {
    unoptimized: true,
  },
  // Skip type checking and linting during build (already done in CI)
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  async rewrites() {
    const defaultBackendUrl =
      process.env.NODE_ENV === 'development'
        ? 'http://localhost:8000'
        : 'http://backend:8000';
    const backendUrl = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || defaultBackendUrl;
    return [
      {
        source: '/api/v1/:path*',
        destination: `${backendUrl}/api/v1/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;

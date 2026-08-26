/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@sentinel/core", "@sentinel/db", "@sentinel/agent"],
  experimental: { externalDir: true },
};

export default nextConfig;

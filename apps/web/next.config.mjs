/** @type {import('next').NextConfig} */
const nextConfig = {
  // ALL workspace packages that ship raw .ts entrypoints must be transpiled —
  // including @sentinel/shadow (imported directly by the request page) and
  // @sentinel/qodo (imported transitively via @sentinel/agent). Omitting one
  // lets Next externalize TypeScript that Node can't load at runtime.
  transpilePackages: [
    "@sentinel/core",
    "@sentinel/db",
    "@sentinel/agent",
    "@sentinel/shadow",
    "@sentinel/qodo",
  ],
  experimental: { externalDir: true },
};

export default nextConfig;

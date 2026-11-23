import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The workspace packages ship TypeScript source.
  transpilePackages: ["@rce/crdt", "@rce/client"],
  reactStrictMode: true,
};

export default nextConfig;

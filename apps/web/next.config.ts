import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@fair/shared", "@fair/pump-integration", "@fair/launchpad-client"]
};

export default nextConfig;

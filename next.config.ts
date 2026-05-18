import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd(),
  outputFileTracingExcludes: {
    "*": [".anyvoice/**/*"],
  },
};

export default nextConfig;

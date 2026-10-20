import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Overridable so a production build can be verified while `next dev` is
  // running and holding .next open (Windows locks files in it).
  distDir: process.env.NEXT_DIST_DIR || ".next",

  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "images.pexels.com",
        pathname: "/photos/**",
      },
    ],
  },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the screen-recording surface focused on the product UI.
  devIndicators: false,
  async rewrites() {
    return [
      {
        source: "/api/logos/:path*",
        destination: "https://seats.aero/static/carriersng/:path*",
      },
    ];
  },
};

export default nextConfig;

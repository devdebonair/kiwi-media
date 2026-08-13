const apiOrigin = process.env.KIWI_API_ORIGIN || "http://127.0.0.1:3333";

export default {
  output: "standalone",
  allowedDevOrigins: ["100.122.182.74", "cachyos-agents.tail46102b.ts.net"],
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiOrigin}/api/:path*` },
      { source: "/generated/:path*", destination: `${apiOrigin}/generated/:path*` },
    ];
  },
};

export default { serverExternalPackages: [], async rewrites() { return [{ source: "/api/:path*", destination: "http://127.0.0.1:8081/api/:path*" }]; } };

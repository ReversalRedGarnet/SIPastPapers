import type { NextConfig } from "next";

// No Content-Security-Policy here -- already assessed and deliberately
// skipped (see the full-site security audit): no third-party scripts, no
// CDN-loaded fonts (Public Sans is bundled via @fontsource, not fetched
// externally), and minimal client JS, so a CSP would have very little to
// restrict for the maintenance/breakage risk it'd add.
const securityHeaders = [
  // Stops a browser from ever guessing a response's MIME type from its
  // content and running/rendering it as something other than what the
  // Content-Type header says (e.g. treating a PDF as HTML).
  { key: "X-Content-Type-Options", value: "nosniff" },
  // This site has no session/auth state and every mutating action is a
  // real POST (no state-changing GET), so clickjacking impact is low --
  // still a one-line, zero-risk header against another site framing us.
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  // Sends the full URL only to our own origin; other-origin requests
  // (e.g. following an outbound link) get just the origin, not the exact
  // page/path a visitor came from.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Nothing on this site uses any of these browser features -- deny them
  // all rather than leaving them at the browser's (permissive) default.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;

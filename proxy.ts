// Gate the whole app behind the Google-OAuth allowlist defined in auth.ts.
// The `authorized` callback there decides; Auth.js redirects anonymous page
// requests to the Google sign-in flow automatically.
//
// Runs on the Node.js runtime: this app is served by `next start` and its libs
// use Node built-ins (node:fs, node:child_process, …), which the Edge runtime
// rejects.
export { auth as proxy } from "@/auth";

export const config = {
  // Run on everything except the Auth.js endpoints (the login flow itself),
  // Next internals, and static asset files. (Proxy always runs on Node.js, so
  // no runtime key — and our libs' node: built-ins are fine here.)
  matcher: [
    "/((?!api/auth|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|css|js|map)$).*)",
  ],
};

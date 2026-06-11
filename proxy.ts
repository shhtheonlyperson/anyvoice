import { NextResponse } from "next/server";
import { auth, isAllowedEmail } from "@/auth";
import { ANYVOICE_USER_HEADER, userIdForEmail } from "@/lib/user-session";
import { isWorkerMode, workerAuthFailure } from "@/lib/worker-proxy";

// Gate the whole app behind the Google-OAuth allowlist (see auth.ts) and inject
// the authenticated identity so voice data follows the Google account.
//
// Runs on the Node.js runtime (proxy always does), so the app's node: built-ins
// are fine here. All matched routes pass through this, and we OVERWRITE the
// identity header, so a client cannot spoof it.
export const proxy = auth((req) => {
  // Machine-to-machine Bearer auth is honored ONLY on a worker deployment
  // (ANYVOICE_WORKER_MODE=1), where the caller is the trusted Vercel frontend
  // and x-anyvoice-user carries the already-authenticated identity. The public
  // deployment never accepts Bearer callers — users go through OAuth, and the
  // identity header is overwritten below so a client cannot spoof it.
  const workerApiRequest =
    req.nextUrl.pathname.startsWith("/api/local-worker/") ||
    req.nextUrl.pathname === "/api/voice-profile/profiles" ||
    req.nextUrl.pathname === "/api/voice-profile/enroll/youtube";
  if (isWorkerMode() && workerApiRequest && req.headers.get("authorization")) {
    const authFailure = workerAuthFailure(req);
    if (authFailure) {
      return NextResponse.json(authFailure.body, { status: authFailure.statusCode });
    }
    return NextResponse.next({ request: { headers: new Headers(req.headers) } });
  }

  const isLocalhost = req.nextUrl.hostname === "localhost" || req.nextUrl.hostname === "127.0.0.1";
  const localRecordingControl =
    req.nextUrl.pathname === "/recording-kit-control" ||
    req.nextUrl.pathname.startsWith("/api/voice-profile/recording-kit") ||
    req.nextUrl.pathname === "/api/voice-profile/import";
  if (isLocalhost && localRecordingControl) {
    const headers = new Headers(req.headers);
    headers.set(ANYVOICE_USER_HEADER, userIdForEmail("shh@theonlyperson.com"));
    return NextResponse.next({ request: { headers } });
  }

  const email = req.auth?.user?.email;
  if (!isAllowedEmail(email)) {
    const url = new URL("/api/auth/signin", req.nextUrl.origin);
    url.searchParams.set("callbackUrl", req.nextUrl.href);
    return NextResponse.redirect(url);
  }
  const headers = new Headers(req.headers);
  headers.set(ANYVOICE_USER_HEADER, userIdForEmail(email as string));
  return NextResponse.next({ request: { headers } });
});

export const config = {
  // Run on everything except the Auth.js endpoints (the login flow itself),
  // Next internals, and static asset files.
  matcher: [
    "/((?!api/auth|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|otf|css|js|map)$).*)",
  ],
};

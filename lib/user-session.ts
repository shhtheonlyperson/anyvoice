import { createHash, randomUUID } from "node:crypto";

export const ANYVOICE_USER_COOKIE = "anyvoice_user_id";
/**
 * Authenticated identity injected by proxy.ts from the signed-in Google email.
 * When present (and valid) it overrides the anonymous cookie, so a person's
 * voices follow their Google account across devices/browsers. The proxy always
 * overwrites this header, so a client cannot spoof it.
 */
export const ANYVOICE_USER_HEADER = "x-anyvoice-user";

/**
 * Pin the two existing accounts to the anonymous ids their data already lives
 * under, so switching to email-based identity doesn't orphan voices built
 * before auth. Everyone else gets a deterministic id derived from their email.
 * (If this pairing is wrong, just swap the two ids.)
 */
const LEGACY_EMAIL_ALIASES: Record<string, string> = {
  "huge.huang@gmail.com": "av_ea1e0283-229e-439e-b317-2818a58a870b",
  "shh@theonlyperson.com": "av_4c49a011-8b45-4554-bf57-c8320f03f3c3",
};

/**
 * Stable AnyVoice user id for an authenticated email. Known accounts map to
 * their legacy anonymous id; anyone else gets a deterministic UUID-shaped id
 * derived from the email so the same account is the same user everywhere.
 */
export function userIdForEmail(email: string): string {
  const key = email.trim().toLowerCase();
  const alias = LEGACY_EMAIL_ALIASES[key];
  if (alias) return alias;
  const h = createHash("sha1").update(`anyvoice:${key}`).digest("hex");
  const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  return `av_${uuid}`;
}

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const USER_ID_PATTERN = /^av_[a-f0-9-]{36}$/i;

export interface AnyVoiceUserSession {
  userId: string;
  shouldSetCookie: boolean;
}

function isValidUserId(value: string): boolean {
  return USER_ID_PATTERN.test(value);
}

function createUserId(): string {
  return `av_${randomUUID()}`;
}

export function readAnyVoiceUserId(req: Request): string | null {
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName !== ANYVOICE_USER_COOKIE) continue;
    const value = decodeURIComponent(rawValue.join("=") || "");
    return isValidUserId(value) ? value : null;
  }

  return null;
}

export function getOrCreateAnyVoiceUserSession(req: Request): AnyVoiceUserSession {
  // Authenticated identity (set by the proxy from the Google email) wins, so
  // data is keyed to the account rather than the per-browser anonymous cookie.
  const headerId = req.headers.get(ANYVOICE_USER_HEADER);
  if (headerId && isValidUserId(headerId)) return { userId: headerId, shouldSetCookie: false };

  const existing = readAnyVoiceUserId(req);
  if (existing) return { userId: existing, shouldSetCookie: false };
  return { userId: createUserId(), shouldSetCookie: true };
}

export function anyVoiceUserCookieHeader(userId: string): string {
  const secure = process.env.VERCEL ? "; Secure" : "";
  return [
    `${ANYVOICE_USER_COOKIE}=${encodeURIComponent(userId)}`,
    "Path=/",
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
    "HttpOnly",
    secure.trim(),
  ]
    .filter(Boolean)
    .join("; ");
}

export function withAnyVoiceUserCookie(response: Response, session: AnyVoiceUserSession): Response {
  if (session.shouldSetCookie) {
    response.headers.append("Set-Cookie", anyVoiceUserCookieHeader(session.userId));
  }
  return response;
}

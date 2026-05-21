import { randomUUID } from "node:crypto";

export const ANYVOICE_USER_COOKIE = "anyvoice_user_id";

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

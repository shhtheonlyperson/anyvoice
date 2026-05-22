import { describe, expect, it } from "vitest";
import {
  ANYVOICE_USER_COOKIE,
  ANYVOICE_USER_HEADER,
  getOrCreateAnyVoiceUserSession,
  userIdForEmail,
} from "@/lib/user-session";

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/runs", { headers });
}

describe("userIdForEmail", () => {
  it("pins known accounts to their legacy anonymous ids (no data orphaning)", () => {
    expect(userIdForEmail("huge.huang@gmail.com")).toBe("av_ea1e0283-229e-439e-b317-2818a58a870b");
    expect(userIdForEmail("shh@theonlyperson.com")).toBe("av_4c49a011-8b45-4554-bf57-c8320f03f3c3");
  });

  it("is case-insensitive on the email", () => {
    expect(userIdForEmail("Huge.Huang@Gmail.com")).toBe(userIdForEmail("huge.huang@gmail.com"));
  });

  it("derives a stable, valid id for unknown emails", () => {
    const a = userIdForEmail("someone@example.com");
    const b = userIdForEmail("someone@example.com");
    expect(a).toBe(b);
    expect(a).toMatch(/^av_[a-f0-9-]{36}$/);
    expect(a).not.toBe(userIdForEmail("other@example.com"));
  });
});

describe("getOrCreateAnyVoiceUserSession", () => {
  it("prefers the authenticated identity header over the cookie", () => {
    const headerId = "av_ea1e0283-229e-439e-b317-2818a58a870b";
    const s = getOrCreateAnyVoiceUserSession(
      req({
        [ANYVOICE_USER_HEADER]: headerId,
        cookie: `${ANYVOICE_USER_COOKIE}=av_11111111-1111-1111-1111-111111111111`,
      }),
    );
    expect(s).toEqual({ userId: headerId, shouldSetCookie: false });
  });

  it("ignores an invalid header and falls back to the cookie", () => {
    const cookieId = "av_11111111-1111-1111-1111-111111111111";
    const s = getOrCreateAnyVoiceUserSession(
      req({ [ANYVOICE_USER_HEADER]: "not-a-valid-id", cookie: `${ANYVOICE_USER_COOKIE}=${cookieId}` }),
    );
    expect(s).toEqual({ userId: cookieId, shouldSetCookie: false });
  });

  it("creates a fresh anonymous id when neither header nor cookie is present", () => {
    const s = getOrCreateAnyVoiceUserSession(req({}));
    expect(s.shouldSetCookie).toBe(true);
    expect(s.userId).toMatch(/^av_[a-f0-9-]{36}$/);
  });
});

import { expect, test } from "@playwright/test";
import { PUBLIC_PORT, WORKER_PORT } from "../playwright.config";

/**
 * @smoke suite: proves the production build boots in both deployment modes
 * and the security perimeter holds.
 *
 * Public mode (port PUBLIC_PORT): every request goes through the Google-OAuth
 * allowlist — a Bearer token must NOT bypass it, even a valid worker token.
 * Worker mode (port WORKER_PORT, ANYVOICE_WORKER_MODE=1): the worker API
 * surface accepts exactly the configured Bearer token; everything else still
 * falls through to OAuth.
 */

const PUBLIC = `http://127.0.0.1:${PUBLIC_PORT}`;
const WORKER = `http://127.0.0.1:${WORKER_PORT}`;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

test("@smoke public: anonymous app shell redirects to sign-in", async ({ request }) => {
  const res = await request.get(`${PUBLIC}/`, { maxRedirects: 0 });
  expect(REDIRECT_STATUSES).toContain(res.status());
  expect(res.headers()["location"]).toContain("/api/auth/signin");
});

test("@smoke public: sign-in page renders with the Google provider", async ({ page }) => {
  await page.goto(`${PUBLIC}/api/auth/signin`);
  await expect(page.getByText(/google/i).first()).toBeVisible();
});

test("@smoke public: anonymous API request is gated by OAuth, not served", async ({ request }) => {
  const res = await request.get(`${PUBLIC}/api/voice-profile/profiles`, { maxRedirects: 0 });
  expect(REDIRECT_STATUSES).toContain(res.status());
  expect(res.headers()["location"]).toContain("/api/auth/signin");
});

test("@smoke public: a valid worker Bearer token does NOT bypass OAuth", async ({ request }) => {
  const res = await request.get(`${PUBLIC}/api/voice-profile/profiles`, {
    maxRedirects: 0,
    headers: {
      authorization: "Bearer e2e-worker-token",
      "x-anyvoice-user": "av_00000000-0000-0000-0000-000000000000",
    },
  });
  expect(REDIRECT_STATUSES).toContain(res.status());
  expect(res.headers()["location"]).toContain("/api/auth/signin");
});

test("@smoke worker: rejects a wrong Bearer token", async ({ request }) => {
  const res = await request.get(`${WORKER}/api/voice-profile/profiles`, {
    maxRedirects: 0,
    headers: { authorization: "Bearer wrong-token" },
  });
  expect(res.status()).toBe(401);
  const body = await res.json();
  expect(body.status).toBe("error");
});

test("@smoke worker: serves profiles with the valid Bearer token", async ({ request }) => {
  const res = await request.get(`${WORKER}/api/voice-profile/profiles`, {
    maxRedirects: 0,
    headers: { authorization: "Bearer e2e-worker-token" },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.profiles)).toBe(true);
  expect(body.profiles.some((p: { id: string }) => p.id === "local-default")).toBe(true);
});

test("@smoke worker: requests without a token still fall through to OAuth", async ({ request }) => {
  const res = await request.get(`${WORKER}/api/voice-profile/profiles`, { maxRedirects: 0 });
  expect(REDIRECT_STATUSES).toContain(res.status());
  expect(res.headers()["location"]).toContain("/api/auth/signin");
});

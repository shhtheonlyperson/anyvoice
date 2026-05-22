import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

/**
 * Google-OAuth gate for the app. Only these accounts may sign in; everyone else
 * is denied at the `signIn` callback (Auth.js then shows AccessDenied). This is
 * a hard allowlist — adding a user means editing this list (or ANYVOICE_ALLOWED_EMAILS).
 */
const STATIC_ALLOWED_EMAILS = ["huge.huang@gmail.com", "shh@theonlyperson.com"];

function allowedEmails(): Set<string> {
  const extra = (process.env.ANYVOICE_ALLOWED_EMAILS ?? "")
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...STATIC_ALLOWED_EMAILS.map((e) => e.toLowerCase()), ...extra]);
}

export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowedEmails().has(email.toLowerCase());
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // JWT sessions — no database, which suits the device-local deployment.
  session: { strategy: "jwt" },
  // The app sits behind a tunnel/proxy at voice.theonlyperson.com; trust the
  // forwarded host so callback URLs resolve correctly.
  trustHost: true,
  providers: [
    Google({
      // Force the account chooser so a wrong Google login can be corrected.
      authorization: { params: { prompt: "select_account" } },
    }),
  ],
  callbacks: {
    // Hard allowlist: only the permitted, verified Google emails get in.
    async signIn({ profile }) {
      return Boolean(profile?.email_verified) && isAllowedEmail(profile?.email);
    },
    // Used by middleware (see middleware.ts) — a session means authorized.
    authorized({ auth: session }) {
      return isAllowedEmail(session?.user?.email);
    },
  },
});

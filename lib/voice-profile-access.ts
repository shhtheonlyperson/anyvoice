import { userCanAccessVoiceProfile } from "@/lib/voice-profile-registry";
import { withAnyVoiceUserCookie, type AnyVoiceUserSession } from "@/lib/user-session";

/**
 * Authorization guard for profile-scoped API routes. Returns a ready-to-send
 * 404 response when the session user may not access `profileId`, or `null` when
 * access is allowed and the route should proceed.
 *
 * A 404 (rather than 403) is used deliberately so the endpoint does not confirm
 * that another user's profile id exists. The returned response carries the user
 * cookie so session continuity is preserved on denial.
 */
export async function guardVoiceProfileAccess(
  session: AnyVoiceUserSession,
  profileId: string,
): Promise<Response | null> {
  if (await userCanAccessVoiceProfile(profileId, session.userId)) return null;
  return withAnyVoiceUserCookie(
    Response.json({ status: "error", message: "voice profile not found" }, { status: 404 }),
    session,
  );
}

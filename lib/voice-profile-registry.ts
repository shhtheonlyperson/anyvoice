import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import type { CloneEnv } from "@/lib/clone-config";
import {
  assertSafeProfileId,
  buildVoiceProfileSummary,
  DEFAULT_VOICE_PROFILE_ID,
  voiceProfileManifestPath,
  voiceProfileRoot,
} from "@/lib/voice-profile";

/**
 * Lightweight registry of named voice profiles so a user can build and switch
 * between several voices (their own, a YouTuber's, …). Each profile lives at
 * `<voices>/<id>/` with a `meta.json` (id + display name + owner) alongside the
 * built `profile.json` manifest. The legacy "local-default" profile has no
 * meta.json and is surfaced synthetically for backward compatibility.
 */

export interface VoiceProfileMeta {
  id: string;
  displayName: string;
  userId?: string;
  createdAt: string;
  /**
   * Stable 16-bit fingerprint seed for the generative VoiceMark. Persisted on
   * create; deterministically derived from the id for legacy profiles that
   * predate this field so the mark survives reloads either way.
   */
  hash: number;
}

export interface VoiceProfileListItem extends VoiceProfileMeta {
  status: "ready" | "needs_enrollment";
  /** ≥1 passing clip — enough to generate. */
  usable: boolean;
  /** Meets the full strict curated bar. */
  studioGrade: boolean;
  /**
   * Meets *this* profile's own requirement tier (strict for local-default,
   * lenient minClips:1 for imports) — i.e. no more clips are needed. The Build
   * UI uses this for the "ready/done" state so an imported voice that has met
   * its lighter bar isn't nagged for studio-grade coverage it will never reach.
   */
  meetsRequirements: boolean;
  clipCount: number;
}

/**
 * Deterministic 16-bit fingerprint seed derived from a profile id. Stable across
 * processes/reloads so the VoiceMark for a legacy profile (no persisted hash)
 * always renders identically. FNV-1a folded to 16 bits.
 */
export function voiceProfileHashFromId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 16) ^ h) & 0xffff || 0x4a7d;
}

/** Default display name for the legacy/default profile (zh-Hant default app locale). */
const DEFAULT_DISPLAY_NAME = "我的聲音";

function metaPathForProfile(profileIdInput: string, env: CloneEnv = process.env): string {
  const profileId = assertSafeProfileId(profileIdInput);
  const root = voiceProfileRoot(env);
  const metaJson = path.resolve(root, profileId, "meta.json");
  const relative = path.relative(root, metaJson);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("profile path must stay inside the AnyVoice profile root");
  }
  return metaJson;
}

export async function loadVoiceProfileMeta(
  profileId: string,
  env: CloneEnv = process.env,
): Promise<VoiceProfileMeta | null> {
  try {
    const parsed = JSON.parse(await readFile(metaPathForProfile(profileId, env), "utf-8")) as Partial<VoiceProfileMeta>;
    if (!parsed || typeof parsed.id !== "string" || typeof parsed.displayName !== "string") return null;
    return {
      id: parsed.id,
      displayName: parsed.displayName,
      userId: typeof parsed.userId === "string" ? parsed.userId : undefined,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date(0).toISOString(),
      hash:
        typeof parsed.hash === "number" && Number.isFinite(parsed.hash)
          ? parsed.hash & 0xffff
          : voiceProfileHashFromId(parsed.id),
    };
  } catch {
    return null;
  }
}

async function writeVoiceProfileMeta(meta: VoiceProfileMeta, env: CloneEnv = process.env): Promise<VoiceProfileMeta> {
  const metaJson = metaPathForProfile(meta.id, env);
  await mkdir(path.dirname(metaJson), { recursive: true });
  await writeFile(metaJson, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
  return meta;
}

async function readManifestStatus(
  profileId: string,
  env: CloneEnv = process.env,
): Promise<{
  status: "ready" | "needs_enrollment";
  usable: boolean;
  studioGrade: boolean;
  meetsRequirements: boolean;
  clipCount: number;
} | null> {
  // Return null only when no manifest file exists, so manifest-less created
  // profiles stay needs-clip. When a manifest exists, recompute usable/
  // studioGrade/status/clip-count authoritatively from the same source of truth
  // as the detail route (buildVoiceProfileSummary) instead of trusting the
  // persisted/back-filled manifest fields. This keeps list==detail for legacy
  // manifests written before the two-status model.
  try {
    await access(voiceProfileManifestPath(profileId, env));
  } catch {
    return null;
  }
  const summary = await buildVoiceProfileSummary({ env, profileId });
  return {
    status: summary.status,
    usable: summary.usable,
    studioGrade: summary.studioGrade,
    // No outstanding clips against this profile's own requirement tier.
    meetsRequirements: summary.summary.remainingClipsNeeded === 0,
    clipCount: summary.clips.length,
  };
}

/** True when this user may see/use the profile (its own, or a legacy shared one). */
function ownsProfile(meta: VoiceProfileMeta | null, userId: string): boolean {
  return !meta?.userId || meta.userId === userId;
}

/**
 * Authorization gate for any profile-scoped API route. Resolves the profile's
 * owner from its meta.json and returns whether `userId` may read or mutate it.
 *
 * Untagged profiles (the legacy `local-default`, and any profile created before
 * account tagging) have no `userId` and stay shared, preserving the single-user
 * and pre-migration flows. Account-tagged profiles are owner-locked: a caller
 * who supplies someone else's `profileId` is rejected. The proxy sets the
 * authenticated id from the Google email and cannot be spoofed, so this is a
 * real cross-account boundary, not just UI hiding.
 */
export async function userCanAccessVoiceProfile(
  profileId: string,
  userId: string,
  env: CloneEnv = process.env,
): Promise<boolean> {
  try {
    const meta = await loadVoiceProfileMeta(profileId, env);
    return ownsProfile(meta, userId);
  } catch {
    // A malformed/unsafe id resolves to no owner; treat it as shared so the
    // downstream route can apply its own id validation and 404 handling.
    return true;
  }
}

/**
 * List the voice profiles visible to a user. Always returns at least the
 * default profile so the UI has something to bind to.
 */
export async function listVoiceProfiles(userId: string, env: CloneEnv = process.env): Promise<VoiceProfileListItem[]> {
  const root = voiceProfileRoot(env);
  let dirs: string[] = [];
  try {
    dirs = await readdir(root);
  } catch {
    dirs = [];
  }

  const items: VoiceProfileListItem[] = [];
  let sawDefault = false;
  for (const id of dirs.sort()) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) continue;
    const meta = await loadVoiceProfileMeta(id, env);
    // Cheap ownership check before the (run-scanning) status recompute.
    if (!ownsProfile(meta, userId)) continue;
    const manifest = await readManifestStatus(id, env);
    // A real profile has either a meta.json or a built manifest. Skip junk dirs.
    if (!meta && !manifest && id !== DEFAULT_VOICE_PROFILE_ID) continue;
    if (id === DEFAULT_VOICE_PROFILE_ID) sawDefault = true;
    items.push({
      id,
      displayName: meta?.displayName ?? (id === DEFAULT_VOICE_PROFILE_ID ? DEFAULT_DISPLAY_NAME : id),
      userId: meta?.userId,
      createdAt: meta?.createdAt ?? new Date(0).toISOString(),
      hash: meta?.hash ?? voiceProfileHashFromId(id),
      status: manifest?.status ?? "needs_enrollment",
      usable: manifest?.usable ?? false,
      studioGrade: manifest?.studioGrade ?? false,
      meetsRequirements: manifest?.meetsRequirements ?? false,
      clipCount: manifest?.clipCount ?? 0,
    });
  }

  // Guarantee a default profile entry even on a fresh install.
  if (!sawDefault) {
    items.unshift({
      id: DEFAULT_VOICE_PROFILE_ID,
      displayName: DEFAULT_DISPLAY_NAME,
      createdAt: new Date(0).toISOString(),
      hash: voiceProfileHashFromId(DEFAULT_VOICE_PROFILE_ID),
      status: "needs_enrollment",
      usable: false,
      studioGrade: false,
      meetsRequirements: false,
      clipCount: 0,
    });
  }

  // Default first, then newest-created first.
  items.sort((a, b) => {
    if (a.id === DEFAULT_VOICE_PROFILE_ID) return -1;
    if (b.id === DEFAULT_VOICE_PROFILE_ID) return 1;
    return b.createdAt.localeCompare(a.createdAt);
  });
  return items;
}

export async function createVoiceProfile(
  { userId, displayName }: { userId: string; displayName: string },
  env: CloneEnv = process.env,
): Promise<VoiceProfileMeta> {
  const name = displayName.trim() || DEFAULT_DISPLAY_NAME;
  const id = `vp_${nanoid(8)}`;
  return writeVoiceProfileMeta(
    { id, displayName: name, userId, createdAt: new Date().toISOString(), hash: voiceProfileHashFromId(id) },
    env,
  );
}

export async function renameVoiceProfile(
  { id, userId, displayName }: { id: string; userId: string; displayName: string },
  env: CloneEnv = process.env,
): Promise<VoiceProfileMeta | null> {
  const safeId = assertSafeProfileId(id);
  const existing = await loadVoiceProfileMeta(safeId, env);
  if (!ownsProfile(existing, userId)) return null;
  const name = displayName.trim();
  if (!name) return existing;
  return writeVoiceProfileMeta(
    {
      id: safeId,
      displayName: name,
      userId: existing?.userId ?? userId,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      hash: existing?.hash ?? voiceProfileHashFromId(safeId),
    },
    env,
  );
}

export async function deleteVoiceProfile(id: string, userId: string, env: CloneEnv = process.env): Promise<boolean> {
  const safeId = assertSafeProfileId(id);
  const existing = await loadVoiceProfileMeta(safeId, env);
  if (!ownsProfile(existing, userId)) return false;
  const dir = path.dirname(voiceProfileManifestPath(safeId, env));
  await rm(dir, { recursive: true, force: true });
  return true;
}

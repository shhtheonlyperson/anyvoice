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
}

export interface VoiceProfileListItem extends VoiceProfileMeta {
  status: "ready" | "needs_enrollment";
  /** ≥1 passing clip — enough to generate. */
  usable: boolean;
  /** Meets the full strict curated bar. */
  studioGrade: boolean;
  clipCount: number;
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
    clipCount: summary.clips.length,
  };
}

/** True when this user may see/use the profile (its own, or a legacy shared one). */
function ownsProfile(meta: VoiceProfileMeta | null, userId: string): boolean {
  return !meta?.userId || meta.userId === userId;
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
      status: manifest?.status ?? "needs_enrollment",
      usable: manifest?.usable ?? false,
      studioGrade: manifest?.studioGrade ?? false,
      clipCount: manifest?.clipCount ?? 0,
    });
  }

  // Guarantee a default profile entry even on a fresh install.
  if (!sawDefault) {
    items.unshift({
      id: DEFAULT_VOICE_PROFILE_ID,
      displayName: DEFAULT_DISPLAY_NAME,
      createdAt: new Date(0).toISOString(),
      status: "needs_enrollment",
      usable: false,
      studioGrade: false,
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
  return writeVoiceProfileMeta({ id, displayName: name, userId, createdAt: new Date().toISOString() }, env);
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

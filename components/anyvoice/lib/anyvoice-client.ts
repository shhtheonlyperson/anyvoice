/* Typed client wrapping the existing route handlers. Components never call
   routes ad hoc — they go through here. */

export interface ProfileListItem {
  id: string;
  displayName: string;
  status: "ready" | "needs_enrollment";
  usable: boolean;
  studioGrade: boolean;
  clipCount: number;
  hash: number;
}

export interface RunItem {
  id: string;
  status: "ready" | "needs_worker" | "error";
  voiceName: string;
  targetText: string;
  audioUrl?: string;
  createdAt: string;
}

/** GET /api/voice-profile/profiles */
export async function fetchProfiles(): Promise<ProfileListItem[]> {
  const res = await fetch("/api/voice-profile/profiles", { cache: "no-store" });
  if (!res.ok) return [];
  const payload = (await res.json()) as { profiles?: ProfileListItem[] };
  return payload.profiles ?? [];
}

/** GET /api/runs — recent generations (only ready runs with audio are useful). */
export async function fetchRuns(limit = 12): Promise<RunItem[]> {
  const res = await fetch(`/api/runs?limit=${limit}`, { cache: "no-store" });
  if (!res.ok) return [];
  const payload = (await res.json()) as { items?: RunItem[] };
  return (payload.items ?? []).filter((it) => it.status === "ready" && it.audioUrl);
}

export interface GenerateResult {
  status: "ready" | "needs_worker" | "error";
  audioUrl?: string;
  jobId?: string;
  message?: string;
}

/**
 * POST /api/clone/stream with a profile reference. Drains the ndjson stream,
 * forwarding progress to `onProgress`, and resolves with the terminal payload.
 * Falls back to a plain JSON response if the worker does not stream.
 */
export async function generateFromProfile(
  args: { profileId: string; targetText: string; quality?: string; pronunciationOverrides?: string },
  onProgress?: (phase: string, done?: number, total?: number) => void,
): Promise<GenerateResult> {
  const form = new FormData();
  form.set("targetText", args.targetText);
  form.set("consent", "yes");
  form.set("quality", args.quality ?? "balanced");
  form.set("useVoiceProfile", "yes");
  form.set("profileId", args.profileId);
  if (args.pronunciationOverrides?.trim()) form.set("pronunciationOverrides", args.pronunciationOverrides);

  const res = await fetch("/api/clone/stream", { method: "POST", body: form });
  const contentType = res.headers.get("content-type") || "";

  if (contentType.includes("application/x-ndjson") && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminal: GenerateResult | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.status === "progress") {
            onProgress?.(String(parsed.phase ?? ""), Number(parsed.done), Number(parsed.total));
          } else if (parsed.status === "ready" || parsed.status === "needs_worker" || parsed.status === "error") {
            terminal = parsed as unknown as GenerateResult;
          }
        } catch {
          /* ignore malformed line */
        }
      }
    }
    return terminal ?? { status: "error", message: "no terminal payload" };
  }

  const payload = (await res.json()) as GenerateResult;
  return payload;
}

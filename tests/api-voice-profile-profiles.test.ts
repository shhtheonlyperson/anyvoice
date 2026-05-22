// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/voice-profile-registry", () => ({
  listVoiceProfiles: vi.fn(),
  createVoiceProfile: vi.fn(),
  renameVoiceProfile: vi.fn(),
  deleteVoiceProfile: vi.fn(),
}));

import { GET, POST } from "@/app/api/voice-profile/profiles/route";
import { DELETE, PATCH } from "@/app/api/voice-profile/profiles/[id]/route";
import { ANYVOICE_USER_COOKIE } from "@/lib/user-session";
import {
  createVoiceProfile,
  deleteVoiceProfile,
  listVoiceProfiles,
  renameVoiceProfile,
} from "@/lib/voice-profile-registry";

const listMock = vi.mocked(listVoiceProfiles);
const createMock = vi.mocked(createVoiceProfile);
const renameMock = vi.mocked(renameVoiceProfile);
const deleteMock = vi.mocked(deleteVoiceProfile);

function jsonReq(method: string, body?: unknown): import("next/server").NextRequest {
  return new Request("http://localhost/api/voice-profile/profiles", {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => vi.clearAllMocks());

describe("/api/voice-profile/profiles", () => {
  it("GET lists profiles and sets the user cookie", async () => {
    listMock.mockResolvedValue([
      { id: "local-default", displayName: "我的聲音", status: "ready", usable: true, studioGrade: true, meetsRequirements: true, clipCount: 5, createdAt: "1970-01-01T00:00:00.000Z", hash: 0x4a7d },
      { id: "vp_a", displayName: "Sunny", status: "needs_enrollment", usable: false, studioGrade: false, meetsRequirements: false, clipCount: 0, createdAt: "2026-05-21T00:00:00.000Z", hash: 0x2b5e },
    ]);
    const res = await GET(jsonReq("GET"));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain(`${ANYVOICE_USER_COOKIE}=`);
    const body = await res.json();
    expect(body.profiles).toHaveLength(2);
    expect(body.profiles[0].id).toBe("local-default");
  });

  it("POST creates a named profile", async () => {
    createMock.mockResolvedValue({ id: "vp_new", displayName: "新聲音", userId: "u", createdAt: "now", hash: 0x1234 });
    const res = await POST(jsonReq("POST", { displayName: "新聲音" }));
    expect(res.status).toBe(201);
    expect((await res.json()).profile.id).toBe("vp_new");
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ displayName: "新聲音" }));
  });

  it("POST rejects a blank name", async () => {
    const res = await POST(jsonReq("POST", { displayName: "  " }));
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("PATCH renames; 404 when not found", async () => {
    renameMock.mockResolvedValueOnce({ id: "vp_a", displayName: "X", userId: "u", createdAt: "now", hash: 0x1234 });
    const ok = await PATCH(jsonReq("PATCH", { displayName: "X" }), { params: Promise.resolve({ id: "vp_a" }) });
    expect(ok.status).toBe(200);

    renameMock.mockResolvedValueOnce(null);
    const missing = await PATCH(jsonReq("PATCH", { displayName: "X" }), { params: Promise.resolve({ id: "ghost" }) });
    expect(missing.status).toBe(404);
  });

  it("DELETE removes the owner's profile", async () => {
    deleteMock.mockResolvedValue(true);
    const res = await DELETE(jsonReq("DELETE"), { params: Promise.resolve({ id: "vp_a" }) });
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(true);
    expect(deleteMock).toHaveBeenCalledWith("vp_a", expect.any(String));
  });
});

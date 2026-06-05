export interface BrowserRecordingDraftCaptureSettings {
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  sampleRate?: number;
  channelCount?: number;
}

export interface BrowserRecordingDraftMetadata {
  profileId: string;
  pack: string;
  lineIndex: number;
  transcript: string;
  fileName: string;
  mimeType: string;
  size: number;
  durationSec: number;
  activeVoiceSec?: number | null;
  recordedAt: string;
  captureSettings: BrowserRecordingDraftCaptureSettings | null;
  enrollmentStatus: "draft" | "submitted" | "rejected" | "error";
  enrollmentMessage?: string;
}

export interface BrowserRecordingDraft extends BrowserRecordingDraftMetadata {
  blob?: Blob | null;
}

const METADATA_PREFIX = "anyvoice:recordingDrafts:v1:";
const DB_NAME = "anyvoice-browser-recording-drafts-v1";
const STORE_NAME = "drafts";

function hasWindowStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function browserRecordingDraftKey(profileId: string, pack: string, lineIndex: number): string {
  return `${profileId}:${pack}:${lineIndex}`;
}

function metadataStorageKey(profileId: string, pack: string): string {
  return `${METADATA_PREFIX}${profileId}:${pack}`;
}

function readMetadataIndex(profileId: string, pack: string): Record<string, BrowserRecordingDraftMetadata> {
  if (!hasWindowStorage()) return {};
  try {
    const raw = window.localStorage.getItem(metadataStorageKey(profileId, pack));
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, BrowserRecordingDraftMetadata>
      : {};
  } catch {
    return {};
  }
}

function writeMetadataIndex(profileId: string, pack: string, index: Record<string, BrowserRecordingDraftMetadata>): void {
  if (!hasWindowStorage()) return;
  try {
    window.localStorage.setItem(metadataStorageKey(profileId, pack), JSON.stringify(index));
  } catch {
    // The draft blob is best-effort. Enrollment still proceeds with the live File.
  }
}

function openDraftDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
    };
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve(request.result);
  });
}

async function putBlob(key: string, blob: Blob): Promise<void> {
  const db = await openDraftDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({ key, blob });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}

async function getBlob(key: string): Promise<Blob | null> {
  const db = await openDraftDb();
  if (!db) return null;
  const blob = await new Promise<Blob | null>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => {
      const row = request.result as { blob?: Blob } | undefined;
      resolve(row?.blob instanceof Blob ? row.blob : null);
    };
    request.onerror = () => resolve(null);
  });
  db.close();
  return blob;
}

async function deleteBlob(key: string): Promise<void> {
  const db = await openDraftDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}

export async function saveBrowserRecordingDraft(args: {
  profileId: string;
  pack: string;
  lineIndex: number;
  transcript: string;
  file: File;
  durationSec: number;
  activeVoiceSec?: number | null;
  captureSettings: BrowserRecordingDraftCaptureSettings | null;
}): Promise<BrowserRecordingDraft> {
  const key = browserRecordingDraftKey(args.profileId, args.pack, args.lineIndex);
  const metadata: BrowserRecordingDraftMetadata = {
    profileId: args.profileId,
    pack: args.pack,
    lineIndex: args.lineIndex,
    transcript: args.transcript,
    fileName: args.file.name,
    mimeType: args.file.type || "application/octet-stream",
    size: args.file.size,
    durationSec: args.durationSec,
    activeVoiceSec: typeof args.activeVoiceSec === "number" && Number.isFinite(args.activeVoiceSec)
      ? Math.max(0, args.activeVoiceSec)
      : null,
    recordedAt: new Date().toISOString(),
    captureSettings: args.captureSettings,
    enrollmentStatus: "draft",
  };
  const index = readMetadataIndex(args.profileId, args.pack);
  index[String(args.lineIndex)] = metadata;
  writeMetadataIndex(args.profileId, args.pack, index);
  await putBlob(key, args.file);
  return { ...metadata, blob: args.file };
}

export async function updateBrowserRecordingDraft(args: {
  profileId: string;
  pack: string;
  lineIndex: number;
  patch: Partial<Pick<BrowserRecordingDraftMetadata, "enrollmentStatus" | "enrollmentMessage">>;
}): Promise<void> {
  const index = readMetadataIndex(args.profileId, args.pack);
  const current = index[String(args.lineIndex)];
  if (!current) return;
  index[String(args.lineIndex)] = { ...current, ...args.patch };
  writeMetadataIndex(args.profileId, args.pack, index);
}

export async function loadBrowserRecordingDrafts(profileId: string, pack: string): Promise<BrowserRecordingDraft[]> {
  const rows = Object.values(readMetadataIndex(profileId, pack))
    .filter((row) => row.profileId === profileId && row.pack === pack && Number.isInteger(row.lineIndex))
    .sort((a, b) => a.lineIndex - b.lineIndex);
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      blob: await getBlob(browserRecordingDraftKey(profileId, pack, row.lineIndex)),
    })),
  );
}

export async function loadBrowserRecordingDraft(
  profileId: string,
  pack: string,
  lineIndex: number,
): Promise<BrowserRecordingDraft | null> {
  const metadata = readMetadataIndex(profileId, pack)[String(lineIndex)];
  if (!metadata) return null;
  return {
    ...metadata,
    blob: await getBlob(browserRecordingDraftKey(profileId, pack, lineIndex)),
  };
}

export async function deleteBrowserRecordingDraft(profileId: string, pack: string, lineIndex: number): Promise<void> {
  const index = readMetadataIndex(profileId, pack);
  delete index[String(lineIndex)];
  writeMetadataIndex(profileId, pack, index);
  await deleteBlob(browserRecordingDraftKey(profileId, pack, lineIndex));
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { modelId, runsRoot, type CloneEnv } from "@/lib/clone-config";
import type { CloneInput, CloneProfileReference, QualityPreset, SourceKind } from "@/lib/clone-request";
import { prepareVoiceText, type PreparedVoiceText, type PronunciationOverride } from "@/lib/text-prep";
import type {
  CloneReadyPayload,
  CloneWorkerMissingPayload,
  EffectiveParams,
  ReferenceQuality,
} from "@/lib/clone-runner";

export type RunHistoryStatus = "ready" | "needs_worker" | "error";

export interface RunHistoryRecord {
  id: string;
  userId: string;
  status: RunHistoryStatus;
  modelId: string;
  voiceName: string;
  voiceType: string;
  voiceSize: number;
  sourceKind?: SourceKind;
  targetText: string;
  promptTranscript: string;
  quality: QualityPreset;
  pronunciationOverrides?: PronunciationOverride[];
  profileReference?: CloneProfileReference;
  textPreparation?: RunHistoryTextPreparation;
  audioUrl?: string;
  referenceQuality?: ReferenceQuality;
  targetLanguage?: string | null;
  effectiveParams?: EffectiveParams;
  message?: string;
  createdAt: string;
  completedAt?: string;
}

export interface RunHistoryItem {
  id: string;
  status: RunHistoryStatus;
  modelId: string;
  voiceName: string;
  sourceKind?: SourceKind;
  targetText: string;
  promptTranscript: string;
  quality: QualityPreset;
  pronunciationOverrides?: PronunciationOverride[];
  profileReference?: CloneProfileReference;
  textPreparation?: RunHistoryTextPreparation;
  audioUrl?: string;
  referenceQuality?: ReferenceQuality;
  targetLanguage?: string | null;
  effectiveParams?: EffectiveParams;
  message?: string;
  createdAt: string;
  completedAt?: string;
}

interface RunHistoryStore {
  version: 1;
  records: RunHistoryRecord[];
}

export interface RunHistoryTextPreparation {
  targetText: PreparedVoiceText;
  promptTranscript: PreparedVoiceText;
}

const MAX_RECORDS_PER_USER = 50;
const MAX_RECORDS_TOTAL = 1000;

let historyWriteQueue: Promise<void> = Promise.resolve();

export function historyFilePath(env: CloneEnv = process.env): string {
  if (env.ANYVOICE_HISTORY_FILE) {
    return path.isAbsolute(env.ANYVOICE_HISTORY_FILE)
      ? env.ANYVOICE_HISTORY_FILE
      : path.join(process.cwd(), env.ANYVOICE_HISTORY_FILE);
  }

  return path.join(path.dirname(path.resolve(runsRoot(env))), "run-history.json");
}

function emptyStore(): RunHistoryStore {
  return { version: 1, records: [] };
}

function isRecord(value: unknown): value is RunHistoryRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<RunHistoryRecord>;
  return (
    typeof record.id === "string" &&
    typeof record.userId === "string" &&
    (record.status === "ready" || record.status === "needs_worker" || record.status === "error") &&
    typeof record.modelId === "string" &&
    typeof record.voiceName === "string" &&
    typeof record.voiceType === "string" &&
    typeof record.voiceSize === "number" &&
    typeof record.targetText === "string" &&
    typeof record.promptTranscript === "string" &&
    (record.quality === "speed" || record.quality === "balanced" || record.quality === "quality") &&
    typeof record.createdAt === "string"
  );
}

async function readHistoryStore(file = historyFilePath()): Promise<RunHistoryStore> {
  try {
    const text = await readFile(file, "utf-8");
    const parsed = JSON.parse(text) as Partial<RunHistoryStore>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) return emptyStore();
    return { version: 1, records: parsed.records.filter(isRecord) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return emptyStore();
    }
    return emptyStore();
  }
}

async function writeHistoryStore(store: RunHistoryStore, file = historyFilePath()): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpFile, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  await rename(tmpFile, file);
}

function compareNewestFirst(a: RunHistoryRecord, b: RunHistoryRecord): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}

function pruneRecords(records: RunHistoryRecord[]): RunHistoryRecord[] {
  const counts = new Map<string, number>();
  return records
    .sort(compareNewestFirst)
    .filter((record) => {
      const count = counts.get(record.userId) ?? 0;
      if (count >= MAX_RECORDS_PER_USER) return false;
      counts.set(record.userId, count + 1);
      return true;
    })
    .slice(0, MAX_RECORDS_TOTAL);
}

function enqueueHistoryWrite(update: () => Promise<void>): Promise<void> {
  const next = historyWriteQueue.then(update, update);
  historyWriteQueue = next.catch(() => {});
  return next;
}

async function waitForPendingWrites(): Promise<void> {
  await historyWriteQueue.catch(() => {});
}

export async function saveRunHistory(record: RunHistoryRecord): Promise<void> {
  await enqueueHistoryWrite(async () => {
    const store = await readHistoryStore();
    const records = store.records.filter((item) => !(item.id === record.id && item.userId === record.userId));
    records.unshift(record);
    await writeHistoryStore({ version: 1, records: pruneRecords(records) });
  });
}

export async function listRunsForUser(userId: string, limit = 20): Promise<RunHistoryItem[]> {
  await waitForPendingWrites();
  const store = await readHistoryStore();
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  return store.records
    .filter((record) => record.userId === userId)
    .sort(compareNewestFirst)
    .slice(0, safeLimit)
    .map(toRunHistoryItem);
}

export async function findRunForUser(jobId: string, userId: string): Promise<RunHistoryRecord | null> {
  await waitForPendingWrites();
  const store = await readHistoryStore();
  return store.records.find((record) => record.id === jobId && record.userId === userId) ?? null;
}

export async function findRunById(jobId: string): Promise<RunHistoryRecord | null> {
  await waitForPendingWrites();
  const store = await readHistoryStore();
  return store.records.find((record) => record.id === jobId) ?? null;
}

export async function deleteRunForUser(userId: string, jobId: string): Promise<boolean> {
  let deleted = false;
  await enqueueHistoryWrite(async () => {
    const store = await readHistoryStore();
    const records = store.records.filter((record) => {
      const shouldDelete = record.userId === userId && record.id === jobId;
      if (shouldDelete) deleted = true;
      return !shouldDelete;
    });
    await writeHistoryStore({ version: 1, records });
  });
  return deleted;
}

function toRunHistoryItem(record: RunHistoryRecord): RunHistoryItem {
  return {
    id: record.id,
    status: record.status,
    modelId: record.modelId,
    voiceName: record.voiceName,
    sourceKind: record.sourceKind,
    targetText: record.targetText,
    promptTranscript: record.promptTranscript,
    quality: record.quality,
    pronunciationOverrides: record.pronunciationOverrides,
    profileReference: record.profileReference,
    textPreparation: record.textPreparation,
    audioUrl: record.audioUrl,
    referenceQuality: record.referenceQuality,
    targetLanguage: record.targetLanguage,
    effectiveParams: record.effectiveParams,
    message: record.message,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
  };
}

function baseHistoryRecord(userId: string, jobId: string, input: CloneInput, status: RunHistoryStatus): RunHistoryRecord {
  const createdAt = new Date().toISOString();
  const textPreparation: RunHistoryTextPreparation = {
    targetText: prepareVoiceText(input.targetText, {
      pronunciationOverrides: input.pronunciationOverrides,
      autoApplyPresetPronunciations: true,
    }),
    promptTranscript: prepareVoiceText(input.promptTranscript),
  };
  return {
    id: jobId,
    userId,
    status,
    modelId: modelId(),
    voiceName: input.voice.name || "reference.audio",
    voiceType: input.voice.type || "application/octet-stream",
    voiceSize: input.voice.size,
    sourceKind: input.sourceKind,
    targetText: input.targetText,
    promptTranscript: input.promptTranscript,
    quality: input.quality,
    pronunciationOverrides: input.pronunciationOverrides,
    profileReference: input.profileReference,
    textPreparation,
    createdAt,
  };
}

export function createReadyHistoryRecord(
  userId: string,
  input: CloneInput,
  payload: CloneReadyPayload,
): RunHistoryRecord {
  return {
    ...baseHistoryRecord(userId, payload.jobId, input, "ready"),
    modelId: payload.modelId,
    audioUrl: payload.audioUrl,
    referenceQuality: payload.referenceQuality,
    targetLanguage: payload.targetLanguage,
    effectiveParams: payload.effectiveParams,
    completedAt: new Date().toISOString(),
  };
}

export function createWorkerMissingHistoryRecord(
  userId: string,
  input: CloneInput,
  payload: CloneWorkerMissingPayload,
): RunHistoryRecord {
  return {
    ...baseHistoryRecord(userId, payload.jobId, input, "needs_worker"),
    modelId: payload.modelId,
    message: payload.message,
  };
}

export function createErrorHistoryRecord(
  userId: string,
  jobId: string,
  input: CloneInput,
  message: string,
): RunHistoryRecord {
  return {
    ...baseHistoryRecord(userId, jobId, input, "error"),
    message,
  };
}

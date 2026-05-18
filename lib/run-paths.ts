import path from "node:path";
import { runsRoot } from "./clone-config";

export function safeRunDir(jobId: string): string {
  const root = path.resolve(runsRoot());
  const target = path.resolve(root, jobId);
  if (!target.startsWith(root + path.sep)) {
    throw new Error("invalid job id");
  }
  return target;
}

export function safeRunFile(jobId: string, fileName: string): string {
  const dir = safeRunDir(jobId);
  const target = path.resolve(dir, fileName);
  if (!target.startsWith(dir + path.sep)) {
    throw new Error("invalid run file");
  }
  return target;
}

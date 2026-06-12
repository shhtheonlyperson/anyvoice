import { existsSync } from "node:fs";

const SHARED_VOXCPM_PYTHON = "/Users/shh/proj/shh-voxcpm-service/.venv/bin/python";

type PythonEnv = Record<string, string | undefined>;
type PathExists = (path: string) => boolean;

function present(value: string | undefined): string | null {
  const trimmed = (value || "").trim();
  return trimmed ? trimmed : null;
}

export function voxcpmPython(env: PythonEnv = process.env, exists: PathExists = existsSync): string {
  // The shared service venv is machine infrastructure (like .env.local) —
  // candidates are existence-gated so CI and fresh checkouts degrade to a
  // PATH-resolved python3 instead of spawning a nonexistent interpreter.
  return (
    present(env.ANYVOICE_VOXCPM_PYTHON) ||
    (exists(SHARED_VOXCPM_PYTHON) ? SHARED_VOXCPM_PYTHON : null) ||
    present(env.PYTHON) ||
    "python3"
  );
}

export function asrPython(env: PythonEnv = process.env, exists: PathExists = existsSync): string {
  return present(env.ANYVOICE_ASR_PYTHON) || voxcpmPython(env, exists);
}

const SHARED_VOXCPM_PYTHON = "/Users/shh/proj/shh-voxcpm-service/.venv/bin/python";

type PythonEnv = Record<string, string | undefined>;

function present(value: string | undefined): string | null {
  const trimmed = (value || "").trim();
  return trimmed ? trimmed : null;
}

export function voxcpmPython(env: PythonEnv = process.env): string {
  return present(env.ANYVOICE_VOXCPM_PYTHON) || SHARED_VOXCPM_PYTHON;
}

export function asrPython(env: PythonEnv = process.env): string {
  return present(env.ANYVOICE_ASR_PYTHON) || voxcpmPython(env) || present(env.PYTHON) || "python3";
}

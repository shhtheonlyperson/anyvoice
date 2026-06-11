#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BASENAME_BYTES = 240;
const DEFAULT_MAX_PATH_BYTES = 900;

const args = process.argv.slice(2);
let fix = false;
let includeUntracked = false;
let json = false;
let maxBasenameBytes = DEFAULT_MAX_BASENAME_BYTES;
let maxPathBytes = DEFAULT_MAX_PATH_BYTES;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--fix") {
    fix = true;
  } else if (arg === "--include-untracked") {
    includeUntracked = true;
  } else if (arg === "--json") {
    json = true;
  } else if (arg === "--max-basename-bytes") {
    maxBasenameBytes = Number(args[++i]);
  } else if (arg === "--max-path-bytes") {
    maxPathBytes = Number(args[++i]);
  } else if (arg === "-h" || arg === "--help") {
    usage();
    process.exit(0);
  } else {
    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(2);
  }
}

if (!Number.isInteger(maxBasenameBytes) || maxBasenameBytes <= 0) {
  throw new Error(`Invalid --max-basename-bytes: ${maxBasenameBytes}`);
}

if (!Number.isInteger(maxPathBytes) || maxPathBytes <= 0) {
  throw new Error(`Invalid --max-path-bytes: ${maxPathBytes}`);
}

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const tracked = gitLsFiles([]);
const untracked = includeUntracked
  ? gitLsFiles(["--others", "--exclude-standard"])
  : [];

const entries = [
  ...tracked.map((file) => ({ file, tracked: true })),
  ...untracked.map((file) => ({ file, tracked: false })),
];

const violations = entries
  .map(({ file, tracked }) => {
    const basename = path.basename(file);
    const basenameBytes = Buffer.byteLength(basename, "utf8");
    const pathBytes = Buffer.byteLength(file, "utf8");
    const reasons = [];

    if (basenameBytes > maxBasenameBytes) {
      reasons.push(`basename_bytes=${basenameBytes}>${maxBasenameBytes}`);
    }
    if (pathBytes > maxPathBytes) {
      reasons.push(`path_bytes=${pathBytes}>${maxPathBytes}`);
    }

    return {
      file,
      tracked,
      basenameBytes,
      pathBytes,
      reasons,
    };
  })
  .filter((entry) => entry.reasons.length > 0)
  .sort((a, b) => b.basenameBytes - a.basenameBytes || b.pathBytes - a.pathBytes);

if (violations.length === 0) {
  if (!json) {
    console.log(
      `Vercel path-length check passed: basename<=${maxBasenameBytes} bytes, path<=${maxPathBytes} bytes.`
    );
  } else {
    console.log(JSON.stringify({ ok: true, violations: [] }));
  }
  process.exit(0);
}

if (fix) {
  const renamed = [];
  const occupied = new Set(entries.map((entry) => entry.file));

  for (const violation of violations) {
    const nextFile = nextSafeName(violation.file, occupied);
    occupied.delete(violation.file);
    occupied.add(nextFile);

    if (violation.tracked) {
      run("git", ["mv", "--", violation.file, nextFile]);
    } else {
      fs.renameSync(path.join(repoRoot, violation.file), path.join(repoRoot, nextFile));
    }

    renamed.push({ ...violation, nextFile });
  }

  if (json) {
    console.log(JSON.stringify({ ok: true, renamed }, null, 2));
  } else {
    console.log(`Renamed ${renamed.length} Vercel-unsafe path(s):`);
    for (const entry of renamed) {
      console.log(`- ${entry.file}`);
      console.log(`  -> ${entry.nextFile}`);
    }
  }
  process.exit(0);
}

if (json) {
  console.log(JSON.stringify({ ok: false, violations }, null, 2));
} else {
  console.error(
    `Vercel path-length check failed: ${violations.length} path(s) exceed safe limits.`
  );
  console.error(
    `Limit: basename<=${maxBasenameBytes} bytes, path<=${maxPathBytes} bytes.`
  );
  console.error("");
  for (const entry of violations) {
    console.error(
      `- basename=${entry.basenameBytes} path=${entry.pathBytes} ${entry.file}`
    );
    console.error(`  ${entry.reasons.join(", ")}`);
  }
  console.error("");
  console.error("Fix: node scripts/check_vercel_path_lengths.mjs --fix");
}

process.exit(1);

function usage() {
  console.log(`Usage: node scripts/check_vercel_path_lengths.mjs [options]

Fails when tracked files have path components likely to break Vercel repo unpack.

Options:
  --fix                    Rename unsafe paths with git mv / fs.renameSync.
  --include-untracked      Also inspect untracked files.
  --json                   Emit JSON.
  --max-basename-bytes N   Default ${DEFAULT_MAX_BASENAME_BYTES}.
  --max-path-bytes N       Default ${DEFAULT_MAX_PATH_BYTES}.
`);
}

function gitLsFiles(extraArgs) {
  const out = execFileSync("git", ["ls-files", "-z", ...extraArgs], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return out.split("\0").filter(Boolean);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${commandArgs.join(" ")} failed\n${result.stdout}${result.stderr}`
    );
  }
}

function nextSafeName(file, occupied) {
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const originalStem = path.basename(file, ext);
  const hash = crypto.createHash("sha1").update(file).digest("hex").slice(0, 10);
  const fallbackStem = slug(path.basename(dir)) || "file";
  const baseStem = slug(originalStem) || fallbackStem;
  const suffix = `--${hash}`;
  const maxStemBytes = maxBasenameBytes - Buffer.byteLength(ext + suffix, "utf8");
  const safeStem = truncateUtf8(baseStem, Math.max(8, maxStemBytes));

  let candidate = path.join(dir, `${safeStem}${suffix}${ext}`);
  let counter = 2;
  while (occupied.has(candidate)) {
    const counterSuffix = `--${hash}-${counter}`;
    const counterMaxStemBytes =
      maxBasenameBytes - Buffer.byteLength(ext + counterSuffix, "utf8");
    candidate = path.join(
      dir,
      `${truncateUtf8(baseStem, Math.max(8, counterMaxStemBytes))}${counterSuffix}${ext}`
    );
    counter += 1;
  }

  return candidate;
}

function slug(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function truncateUtf8(value, maxBytes) {
  let out = "";
  for (const char of value) {
    const next = out + char;
    if (Buffer.byteLength(next, "utf8") > maxBytes) {
      break;
    }
    out = next;
  }
  return out || "file";
}

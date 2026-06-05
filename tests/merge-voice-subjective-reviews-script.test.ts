// @vitest-environment node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "merge_voice_subjective_reviews.py");

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-merge-review-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function blindOrderKey(caseId: string, repeat: number, cloneMode: string, outputWav: string): string {
  return createHash("sha256").update(`${caseId}\0${repeat}\0${cloneMode}\0${outputWav}`, "utf8").digest("hex");
}

type Report = {
  groups: Array<{
    cloneMode: string;
    case: { id: string; text: string };
    renders: Array<{ caseId: string; cloneMode: string; repeat: number; status: string; outputWav: string }>;
  }>;
};

async function writeReport(dir: string, caseIds: string[]): Promise<{ reportPath: string; report: Report; reportSha256: string }> {
  await mkdir(dir, { recursive: true });
  const groups: Report["groups"] = [];
  for (const cloneMode of ["prompt", "hifi"]) {
    for (const caseId of caseIds) {
      const renders = [];
      for (const repeat of [1]) {
        const audioPath = path.join(dir, `${cloneMode}-${caseId}-r${repeat}.wav`);
        await writeFile(audioPath, Buffer.from(`${cloneMode} ${caseId} ${repeat}\n`));
        renders.push({
          caseId,
          cloneMode,
          repeat,
          status: "ready",
          outputWav: audioPath,
        });
      }
      groups.push({
        cloneMode,
        case: { id: caseId, text: `text for ${caseId}` },
        renders,
      });
    }
  }
  const report = { version: 1, groups };
  const reportPath = path.join(dir, "report.json");
  const text = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(reportPath, text, "utf-8");
  return { reportPath, report, reportSha256: sha256Text(text) };
}

function labelsFor(report: Report, caseId: string, repeat: number): { candidate: string; baseline: string } {
  const samples = report.groups
    .flatMap((group) => group.renders)
    .filter((render) => render.caseId === caseId && render.repeat === repeat)
    .map((render) => ({ cloneMode: render.cloneMode, outputWav: render.outputWav }))
    .sort((a, b) => blindOrderKey(caseId, repeat, a.cloneMode, a.outputWav).localeCompare(
      blindOrderKey(caseId, repeat, b.cloneMode, b.outputWav),
    ));
  const labelFor = (cloneMode: string) => String.fromCharCode(65 + samples.findIndex((sample) => sample.cloneMode === cloneMode));
  return { candidate: labelFor("hifi"), baseline: labelFor("prompt") };
}

function choiceForRole(report: Report, caseId: string, role: "candidate" | "baseline" | "tie" | "rerender"): string {
  if (role === "tie" || role === "rerender") return role;
  return labelsFor(report, caseId, 1)[role];
}

async function writeReview({
  reviewPath,
  reportPath,
  report,
  reportSha256,
  selections,
}: {
  reviewPath: string;
  reportPath: string;
  report: Report;
  reportSha256: string;
  selections: Record<string, "candidate" | "baseline" | "tie" | "rerender" | "missing">;
}): Promise<void> {
  const choices: Record<string, string> = {};
  let candidateWins = 0;
  let baselineWins = 0;
  let ties = 0;
  let rerenders = 0;
  let reviewedRounds = 0;
  const choiceKeys = Object.keys(selections).map((caseId) => `winner-${caseId}-r01`);
  const missingChoices = [];
  for (const [caseId, role] of Object.entries(selections)) {
    const key = `winner-${caseId}-r01`;
    if (role === "missing") {
      missingChoices.push(key);
      continue;
    }
    reviewedRounds += 1;
    choices[key] = choiceForRole(report, caseId, role);
    if (role === "candidate") candidateWins += 1;
    if (role === "baseline") baselineWins += 1;
    if (role === "tie") ties += 1;
    if (role === "rerender") rerenders += 1;
  }
  const reasons = [];
  if (missingChoices.length || rerenders) reasons.push("subjective_review_incomplete_or_rerender");
  if (baselineWins > candidateWins) reasons.push("subjective_review_baseline_preferred_over_candidate");
  await writeFile(
    reviewPath,
    `${JSON.stringify({
      version: 1,
      status: reasons.length ? "review" : "pass",
      reasons,
      report: reportPath,
      reportPath,
      reportSha256,
      expectedSaveAs: reviewPath,
      choiceKeys,
      reviewedAt: "2026-06-04T00:00:00.000Z",
      stats: {
        rounds: choiceKeys.length,
        reviewedRounds,
        candidateWins,
        baselineWins,
        ties,
        rerenders,
        candidateWinRate: choiceKeys.length ? candidateWins / choiceKeys.length : 0,
        minCandidateWinRate: 0.8,
        reportSha256,
      },
      missingChoices,
      invalidChoices: [],
      choices,
    }, null, 2)}\n`,
    "utf-8",
  );
}

describe("merge_voice_subjective_reviews.py", () => {
  it("merges rerender review choices by candidate/baseline role instead of copying blind labels", async () => {
    const base = await writeReport(path.join(tmpRoot, "base"), ["needs_fix"]);
    const replacement = await writeReport(path.join(tmpRoot, "replacement"), ["needs_fix"]);
    const baseReview = path.join(tmpRoot, "base", "review.json");
    const replacementReview = path.join(tmpRoot, "replacement", "review.json");
    await writeReview({
      reviewPath: baseReview,
      reportPath: base.reportPath,
      report: base.report,
      reportSha256: base.reportSha256,
      selections: { needs_fix: "rerender" },
    });
    await writeReview({
      reviewPath: replacementReview,
      reportPath: replacement.reportPath,
      report: replacement.report,
      reportSha256: replacement.reportSha256,
      selections: { needs_fix: "candidate" },
    });
    const out = path.join(tmpRoot, "base", "report.review.json");

    const { stdout } = await execFileAsync(python, [
      script,
      "--base-review",
      baseReview,
      "--base-report",
      base.reportPath,
      "--replacement-review",
      replacementReview,
      "--replacement-report",
      replacement.reportPath,
      "--out",
      out,
    ]);

    expect(JSON.parse(stdout)).toMatchObject({
      status: "written",
      reviewStatus: "pass",
      replacedChoices: 1,
      stats: {
        candidateWins: 1,
        baselineWins: 0,
      },
    });
    const merged = JSON.parse(await readFile(out, "utf-8"));
    expect(merged.choices["winner-needs_fix-r01"]).toBe(labelsFor(base.report, "needs_fix", 1).candidate);
    expect(merged.merge.replacedChoices[0]).toMatchObject({
      replacementRole: "candidate",
      oldChoice: "rerender",
      mergedChoice: labelsFor(base.report, "needs_fix", 1).candidate,
    });
  });

  it("can explicitly fill accidental missing choices as ties while merging rerenders", async () => {
    const base = await writeReport(path.join(tmpRoot, "base"), ["needs_fix", "accidental_missing"]);
    const replacement = await writeReport(path.join(tmpRoot, "replacement"), ["needs_fix"]);
    const baseReview = path.join(tmpRoot, "base", "review.json");
    const replacementReview = path.join(tmpRoot, "replacement", "review.json");
    await writeReview({
      reviewPath: baseReview,
      reportPath: base.reportPath,
      report: base.report,
      reportSha256: base.reportSha256,
      selections: { needs_fix: "rerender", accidental_missing: "missing" },
    });
    await writeReview({
      reviewPath: replacementReview,
      reportPath: replacement.reportPath,
      report: replacement.report,
      reportSha256: replacement.reportSha256,
      selections: { needs_fix: "tie" },
    });
    const out = path.join(tmpRoot, "base", "report.review.json");

    const { stdout } = await execFileAsync(python, [
      script,
      "--base-review",
      baseReview,
      "--base-report",
      base.reportPath,
      "--replacement-review",
      replacementReview,
      "--replacement-report",
      replacement.reportPath,
      "--out",
      out,
      "--fill-missing",
      "tie",
    ]);

    expect(JSON.parse(stdout)).toMatchObject({
      status: "written",
      reviewStatus: "pass",
      stats: {
        candidateWins: 0,
        baselineWins: 0,
        ties: 2,
        rerenders: 0,
      },
      filledMissingChoices: ["winner-accidental_missing-r01"],
    });
    const merged = JSON.parse(await readFile(out, "utf-8"));
    expect(merged.choices["winner-needs_fix-r01"]).toBe("tie");
    expect(merged.choices["winner-accidental_missing-r01"]).toBe("tie");
  });

  it("blocks a replacement review that is not bound to its replacement report", async () => {
    const base = await writeReport(path.join(tmpRoot, "base"), ["needs_fix"]);
    const replacement = await writeReport(path.join(tmpRoot, "replacement"), ["needs_fix"]);
    const baseReview = path.join(tmpRoot, "base", "review.json");
    const replacementReview = path.join(tmpRoot, "replacement", "review.json");
    await writeReview({
      reviewPath: baseReview,
      reportPath: base.reportPath,
      report: base.report,
      reportSha256: base.reportSha256,
      selections: { needs_fix: "rerender" },
    });
    await writeReview({
      reviewPath: replacementReview,
      reportPath: replacement.reportPath,
      report: replacement.report,
      reportSha256: "0".repeat(64),
      selections: { needs_fix: "tie" },
    });

    await expect(
      execFileAsync(python, [
        script,
        "--base-review",
        baseReview,
        "--base-report",
        base.reportPath,
        "--replacement-review",
        replacementReview,
        "--replacement-report",
        replacement.reportPath,
        "--out",
        path.join(tmpRoot, "base", "report.review.json"),
      ]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("replacement_review_report_sha256_mismatch"),
    });
  });
});

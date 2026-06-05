// @vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const python = process.env.PYTHON || "python3";
const script = path.join(process.cwd(), "scripts", "serve_voice_review.py");

let tmpRoot: string;
const children: ChildProcessWithoutNullStreams[] = [];
const servers: net.Server[] = [];

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function waitForServer(child: ChildProcessWithoutNullStreams): Promise<{ url: string; reviewJson: string }> {
  let buffer = "";
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`server did not start: ${buffer}`)), 5000);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const line = buffer.split(/\r?\n/).find((entry) => entry.trim().startsWith("{"));
      if (!line) return;
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(error);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      reject(new Error(`server exited before ready: ${code}; ${buffer}`));
    });
  });
}

async function reservePort(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected TCP server address");
  servers.push(server);
  return { server, port: address.port };
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(os.tmpdir(), "anyvoice-review-server-"));
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill();
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("serve_voice_review.py", () => {
  it("serves report.html and saves a bound review.json payload", async () => {
    const reportJson = path.join(tmpRoot, "report.json");
    const reportHtml = path.join(tmpRoot, "report.html");
    const reportText = `${JSON.stringify({ version: 1, groups: [] }, null, 2)}\n`;
    await writeFile(reportJson, reportText, "utf-8");
    await writeFile(reportHtml, "<!doctype html><h1>review</h1>\n", "utf-8");

    const child = spawn(python, [script, "--report-html", reportHtml, "--port", "0"]);
    children.push(child);
    const ready = await waitForServer(child);

    const page = await fetch(ready.url);
    await expect(page.text()).resolves.toContain("review");

    const review = {
      version: 1,
      status: "pass",
      reasons: [],
      report: reportJson,
      reportPath: reportJson,
      reportSha256: sha256Text(reportText),
      expectedSaveAs: ready.reviewJson,
      choiceKeys: [],
      reviewedAt: "2026-06-04T00:00:00.000Z",
      stats: {
        rounds: 0,
        reviewedRounds: 0,
        candidateWins: 0,
        baselineWins: 0,
        ties: 0,
        rerenders: 0,
        candidateWinRate: 0,
        minCandidateWinRate: 0.8,
        reportSha256: sha256Text(reportText),
      },
      missingChoices: [],
      invalidChoices: [],
      choices: {},
    };

    const response = await fetch(new URL("/review", ready.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `${JSON.stringify(review)}\n`,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "saved", path: ready.reviewJson });

    await expect(readFile(ready.reviewJson, "utf-8")).resolves.toContain('"status": "pass"');
  });

  it("rejects review payloads that are not bound to the served report", async () => {
    const reportJson = path.join(tmpRoot, "report.json");
    const reportHtml = path.join(tmpRoot, "report.html");
    await writeFile(reportJson, '{"version":1}\n', "utf-8");
    await writeFile(reportHtml, "<!doctype html><h1>review</h1>\n", "utf-8");

    const child = spawn(python, [script, "--report-html", reportHtml, "--port", "0"]);
    children.push(child);
    const ready = await waitForServer(child);

    const response = await fetch(new URL("/review", ready.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `${JSON.stringify({
        status: "pass",
        reasons: [],
        reportPath: reportJson,
        reportSha256: "0".repeat(64),
        expectedSaveAs: ready.reviewJson,
        stats: {
          rounds: 0,
          reviewedRounds: 0,
          candidateWins: 0,
          baselineWins: 0,
          ties: 0,
          rerenders: 0,
          candidateWinRate: 0,
          minCandidateWinRate: 0.8,
          reportSha256: "0".repeat(64),
        },
        missingChoices: [],
        invalidChoices: [],
        choices: {},
      })}\n`,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("reportSha256"),
    });
  });

  it("rejects incomplete review payloads before writing review.json", async () => {
    const reportJson = path.join(tmpRoot, "report.json");
    const reportHtml = path.join(tmpRoot, "report.html");
    const reportText = '{"version":1}\n';
    await writeFile(reportJson, reportText, "utf-8");
    await writeFile(reportHtml, "<!doctype html><h1>review</h1>\n", "utf-8");

    const child = spawn(python, [script, "--report-html", reportHtml, "--port", "0"]);
    children.push(child);
    const ready = await waitForServer(child);

    const response = await fetch(new URL("/review", ready.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `${JSON.stringify({
        status: "pass",
        reasons: [],
        reportPath: reportJson,
        reportSha256: sha256Text(reportText),
        expectedSaveAs: ready.reviewJson,
        choices: {},
      })}\n`,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("stats"),
    });
  });

  it("tries the next port when the requested port is already in use", async () => {
    const reportJson = path.join(tmpRoot, "report.json");
    const reportHtml = path.join(tmpRoot, "report.html");
    await writeFile(reportJson, '{"version":1}\n', "utf-8");
    await writeFile(reportHtml, "<!doctype html><h1>review</h1>\n", "utf-8");
    const { port } = await reservePort();

    const child = spawn(python, [script, "--report-html", reportHtml, "--port", String(port), "--port-retries", "2"]);
    children.push(child);
    const ready = await waitForServer(child);

    const servedUrl = new URL(ready.url);
    expect(servedUrl.port).not.toBe(String(port));
    expect(Number(servedUrl.port)).toBeGreaterThan(port);
    const page = await fetch(ready.url);
    await expect(page.text()).resolves.toContain("review");
  });
});

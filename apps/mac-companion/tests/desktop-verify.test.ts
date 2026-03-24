import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

function resolveVerifierScriptPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "scripts",
    "verify-desktop-visible.mjs",
  );
}

test("desktop verifier writes a passing report when OCR text contains the expected message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-desktop-verify-pass-"));
  const reportPath = join(dir, "report.json");
  const screenshotPath = join(dir, "capture.png");
  const verifierPath = resolveVerifierScriptPath();

  const { stdout } = await execFileAsync(process.execPath, [
    verifierPath,
    "--app-name",
    "Codex",
    "--expected-text",
    "visible debug text",
    "--delay-ms",
    "1",
    "--report-path",
    reportPath,
    "--screenshot-path",
    screenshotPath,
  ], {
    env: {
      ...process.env,
      CODEX_VERIFY_SKIP_SESSION_PROBE: "1",
      CODEX_VERIFY_SKIP_ACTIVATION: "1",
      CODEX_VERIFY_SKIP_SCREENSHOT: "1",
      CODEX_VERIFY_MOCK_OCR_TEXT: "prefix visible debug text suffix",
    },
  });

  const report = JSON.parse(await readFile(reportPath, "utf8")) as {
    matched: boolean;
    ocrMocked: boolean;
    screenshotSkipped: boolean;
    ocrText: string;
  };
  const stdoutJson = JSON.parse(stdout) as { matched: boolean };

  assert.equal(stdoutJson.matched, true);
  assert.equal(report.matched, true);
  assert.equal(report.ocrMocked, true);
  assert.equal(report.screenshotSkipped, true);
  assert.match(report.ocrText, /visible debug text/);
});

test("desktop verifier writes a failure report when screenshot capture fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-remote-desktop-verify-fail-"));
  const reportPath = join(dir, "report.json");
  const screenshotPath = join(dir, "capture.png");
  const verifierPath = resolveVerifierScriptPath();

  await assert.rejects(
    execFileAsync(process.execPath, [
      verifierPath,
      "--app-name",
      "Codex",
      "--expected-text",
      "visible debug text",
      "--delay-ms",
      "1",
      "--report-path",
      reportPath,
      "--screenshot-path",
      screenshotPath,
    ], {
      env: {
        ...process.env,
        CODEX_VERIFY_SKIP_SESSION_PROBE: "1",
        CODEX_VERIFY_SKIP_ACTIVATION: "1",
        CODEX_VERIFY_MOCK_CAPTURE_ERROR: "mock screencapture denied by test",
      },
    }),
    /mock screencapture denied by test/,
  );

  const report = JSON.parse(await readFile(reportPath, "utf8")) as {
    matched: boolean;
    captureError?: string;
    error: string;
  };

  assert.equal(report.matched, false);
  assert.match(report.captureError ?? "", /mock screencapture denied by test/);
  assert.match(report.error, /mock screencapture denied by test/);
});

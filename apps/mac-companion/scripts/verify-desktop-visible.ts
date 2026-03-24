#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  buildDesktopVerificationFailure,
  formatDesktopVerificationFailure,
} from "../src/desktop/verification-diagnostics.js";

const execFileAsync = promisify(execFile);

interface VerifyArgs {
  appName: string;
  expectedText: string;
  screenshotPath: string;
  reportPath: string;
  delayMs: number;
}

interface OcrResult {
  text?: string;
  lines?: string[];
}

interface DesktopVerificationReport {
  appName: string;
  expectedText: string;
  matched: boolean;
  screenshotPath: string;
  reportPath: string;
  frontWindowTitle: string;
  activationErrors: string[];
  recognizedLines: string[];
  recognizedTextPreview: string;
  createdAt: string;
  failure?: ReturnType<typeof buildDesktopVerificationFailure>;
}

function parseArgs(argv: string[]): VerifyArgs {
  const args: VerifyArgs = {
    appName: process.env.CODEX_MAC_APP_NAME ?? "Codex",
    expectedText: process.env.DESKTOP_VERIFY_TEXT ?? "",
    screenshotPath: "",
    reportPath: "",
    delayMs: Number.parseInt(process.env.DESKTOP_VERIFY_DELAY_MS ?? "1800", 10),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];
    if (current === "--app-name" && next) {
      args.appName = next;
      index += 1;
    } else if (current === "--expected-text" && next) {
      args.expectedText = next;
      index += 1;
    } else if (current === "--screenshot-path" && next) {
      args.screenshotPath = next;
      index += 1;
    } else if (current === "--report-path" && next) {
      args.reportPath = next;
      index += 1;
    } else if (current === "--delay-ms" && next) {
      args.delayMs = Number.parseInt(next, 10);
      index += 1;
    }
  }

  return args;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeReport(
  reportPath: string,
  report: DesktopVerificationReport,
): Promise<void> {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

async function activateApp(appName: string): Promise<string[]> {
  const errors: string[] = [];

  try {
    await execFileAsync("open", ["-a", appName]);
  } catch {
    errors.push(`open -a ${appName} failed`);
  }

  try {
    await execFileAsync("osascript", [
      "-e",
      `tell application "${appName}" to activate`,
    ]);
  } catch (error) {
    errors.push(`osascript activate failed: ${extractErrorMessage(error)}`);
  }

  return errors;
}

async function readFrontWindowTitle(appName: string): Promise<string> {
  const script = `
tell application "System Events"
  tell process "${appName}"
    try
      return name of front window
    on error
      return ""
    end try
  end tell
end tell
`;
  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script]);
    return stdout.trim();
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.expectedText) {
    throw new Error("Expected text is required. Pass --expected-text or DESKTOP_VERIFY_TEXT.");
  }

  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repoRoot = resolve(appRoot, "..", "..");
  const logsDir = join(repoRoot, "logs", "e2e");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = args.screenshotPath || join(logsDir, `desktop-${timestamp}.png`);
  const reportPath = args.reportPath || join(logsDir, `desktop-${timestamp}.json`);

  await mkdir(dirname(screenshotPath), { recursive: true });
  await mkdir(dirname(reportPath), { recursive: true });

  const activationErrors = await activateApp(args.appName);
  await new Promise((resolveDelay) => setTimeout(resolveDelay, args.delayMs));

  const frontWindowTitle = await readFrontWindowTitle(args.appName);
  const baseReport = {
    appName: args.appName,
    expectedText: args.expectedText,
    screenshotPath,
    reportPath,
    frontWindowTitle,
    activationErrors,
    createdAt: new Date().toISOString(),
  };

  try {
    await execFileAsync("screencapture", ["-x", screenshotPath]);
  } catch (error) {
    const message = activationErrors.length
      ? `${activationErrors.join("\n")}\n${extractErrorMessage(error)}`
      : extractErrorMessage(error);
    const failure = buildDesktopVerificationFailure("screenshot", message);
    const report: DesktopVerificationReport = {
      ...baseReport,
      matched: false,
      recognizedLines: [],
      recognizedTextPreview: "",
      failure,
    };
    await writeReport(reportPath, report);
    throw new Error(formatDesktopVerificationFailure("screenshot", message));
  }

  let ocr: OcrResult;
  try {
    const { stdout } = await execFileAsync("swift", [
      join(appRoot, "scripts", "ocr-screenshot.swift"),
      screenshotPath,
    ]);
    ocr = JSON.parse(stdout) as OcrResult;
  } catch (error) {
    const message = extractErrorMessage(error);
    const failure = buildDesktopVerificationFailure("ocr", message);
    const report: DesktopVerificationReport = {
      ...baseReport,
      matched: false,
      recognizedLines: [],
      recognizedTextPreview: "",
      failure,
    };
    await writeReport(reportPath, report);
    throw new Error(formatDesktopVerificationFailure("ocr", message));
  }

  const normalizedExpected = normalizeText(args.expectedText);
  const normalizedRecognized = normalizeText(ocr.text ?? "");
  const matched = normalizedRecognized.includes(normalizedExpected);
  const report: DesktopVerificationReport = {
    ...baseReport,
    matched,
    recognizedLines: ocr.lines ?? [],
    recognizedTextPreview: (ocr.text ?? "").slice(0, 500),
  };

  if (!matched) {
    report.failure = {
      stage: "match",
      message: `Expected text not visible: ${args.expectedText}`,
      diagnosis: {
        code: "unknown",
        summary: "The screenshot was captured, but the expected text was not visible in the OCR result.",
        suggestedAction:
          "Open the saved screenshot and compare it with the recognized text preview to see what the desktop actually showed.",
      },
    };
    await writeReport(reportPath, report);
    throw new Error(`Desktop verification failed. Expected text not visible: ${args.expectedText}`);
  }

  await writeReport(reportPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(extractErrorMessage(error));
  process.exitCode = 1;
});

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface DesktopVerificationAttemptReport {
  matched?: boolean;
  failure?: {
    stage?: string;
    message?: string;
    diagnosis?: {
      code?: string;
      summary?: string;
      suggestedAction?: string;
    };
  };
}

interface RunDesktopVerificationOptions {
  nodePath: string;
  macCompanionDir: string;
  logsDir: string;
  traceId: string;
  uniqueMessage: string;
  projectTitle: string;
  chatTitle: string;
  desktopVerifyDelayMs: number;
  commandTimeoutMs: number;
  appName: string;
  appPath: string;
  bundleId: string;
  attempts?: number;
  retryDelayMs?: number;
}

interface ExecFileAsyncResult {
  stdout: string;
}

interface RunDesktopVerificationDependencies {
  execFileAsyncFn?: (
    file: string,
    args: string[],
    options: {
      cwd: string;
      timeout: number;
      killSignal: "SIGKILL";
    },
  ) => Promise<ExecFileAsyncResult>;
  readJSONFileFn?: <T>(path: string) => Promise<T | null>;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface RunDesktopVerificationResult {
  desktopVerification: DesktopVerificationAttemptReport | null;
  lastDesktopError: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function readJSONFile<T>(path: string): Promise<T | null> {
  try {
    const contents = await readFile(path, "utf8");
    return JSON.parse(contents) as T;
  } catch {
    return null;
  }
}

function looksLikeTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const killed = "killed" in error && Boolean((error as Error & { killed?: boolean }).killed);
  const signal = "signal" in error ? (error as Error & { signal?: string }).signal : undefined;
  return killed || signal === "SIGKILL" || /timed out/i.test(error.message);
}

function createSyntheticFailureReport(
  error: unknown,
  commandTimeoutMs: number,
): DesktopVerificationAttemptReport {
  const isTimeout = looksLikeTimeout(error);
  const errorMessage = error instanceof Error ? error.message : String(error);

  return {
    matched: false,
    failure: {
      stage: isTimeout ? "verifier_timeout" : "verifier_process",
      message: isTimeout
        ? `Desktop verifier timed out after ${commandTimeoutMs}ms before writing an attempt report.`
        : "Desktop verifier exited before writing an attempt report.",
      diagnosis: {
        code: isTimeout ? "verifier_timeout" : "verifier_process_failed",
        summary: isTimeout
          ? "The final desktop verifier did not finish in time."
          : "The final desktop verifier failed before it could persist its own report.",
        suggestedAction: `Inspect the debug-loop report and verifier stderr. Last process error: ${errorMessage}`,
      },
    },
  };
}

function describeDesktopError(
  error: unknown,
  attemptReport: DesktopVerificationAttemptReport | null,
): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const diagnosis = attemptReport?.failure?.diagnosis;
  if (diagnosis?.summary && diagnosis.suggestedAction) {
    return `${diagnosis.summary} ${diagnosis.suggestedAction}\n\n${errorMessage}`;
  }
  return errorMessage;
}

export async function runDesktopVerificationLoop(
  options: RunDesktopVerificationOptions,
  dependencies: RunDesktopVerificationDependencies = {},
): Promise<RunDesktopVerificationResult> {
  const execFileAsyncFn = dependencies.execFileAsyncFn ?? execFileAsync;
  const readJSONFileFn = dependencies.readJSONFileFn ?? readJSONFile;
  const sleepFn = dependencies.sleepFn ?? sleep;
  const attempts = options.attempts ?? 4;
  const retryDelayMs = options.retryDelayMs ?? 1500;

  let desktopVerification: DesktopVerificationAttemptReport | null = null;
  let lastDesktopError = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const desktopReportPath = join(options.logsDir, `desktop-verify-${options.traceId}-attempt-${attempt}.json`);
    const desktopScreenshotPath = join(options.logsDir, `desktop-verify-${options.traceId}-attempt-${attempt}.png`);
    try {
      const { stdout } = await execFileAsyncFn(options.nodePath, [
        "scripts/verify-desktop-visible.mjs",
        "--app-name",
        options.appName,
        "--app-path",
        options.appPath,
        "--bundle-id",
        options.bundleId,
        "--expected-text",
        options.uniqueMessage,
        "--project-title",
        options.projectTitle,
        "--chat-title",
        options.chatTitle,
        "--delay-ms",
        String(options.desktopVerifyDelayMs),
        "--report-path",
        desktopReportPath,
        "--screenshot-path",
        desktopScreenshotPath,
      ], {
        cwd: options.macCompanionDir,
        timeout: options.commandTimeoutMs,
        killSignal: "SIGKILL",
      });
      desktopVerification = JSON.parse(stdout) as DesktopVerificationAttemptReport;
      lastDesktopError = "";
      break;
    } catch (error) {
      const attemptReport = await readJSONFileFn<DesktopVerificationAttemptReport>(desktopReportPath);
      desktopVerification = attemptReport ?? createSyntheticFailureReport(error, options.commandTimeoutMs);
      lastDesktopError = describeDesktopError(error, desktopVerification);

      if (attempt < attempts) {
        await sleepFn(retryDelayMs);
      }
    }
  }

  return {
    desktopVerification,
    lastDesktopError,
  };
}

import type { DesktopVerificationAttemptReport } from "./desktop-verification.js";
import type { RolloutVerificationResult } from "./rollout-verification.js";

export interface ClosedLoopGateOptions {
  reportPath: string;
  streamEventCount: number;
  rolloutVerification: RolloutVerificationResult;
  desktopVerification: DesktopVerificationAttemptReport | null;
  requireVisibleUi?: boolean;
}

export interface ClosedLoopGateResult {
  passed: boolean;
  visibleUiMatched: boolean;
  warnings: string[];
  failureMessage?: string;
}

export function evaluateClosedLoopGate(
  options: ClosedLoopGateOptions,
): ClosedLoopGateResult {
  const warnings: string[] = [];
  const visibleUiMatched = options.desktopVerification?.matched === true;

  if (options.streamEventCount === 0) {
    return {
      passed: false,
      visibleUiMatched,
      warnings,
      failureMessage: `No stream events were observed. Report: ${options.reportPath}`,
    };
  }

  if (!options.rolloutVerification.rolloutPath) {
    return {
      passed: false,
      visibleUiMatched,
      warnings,
      failureMessage: `No Codex rollout file was found for the desktop chat. Report: ${options.reportPath}`,
    };
  }

  if (!options.rolloutVerification.userMessageFound) {
    return {
      passed: false,
      visibleUiMatched,
      warnings,
      failureMessage: `The unique debug message was not found in the Codex rollout history. Report: ${options.reportPath}`,
    };
  }

  if (!visibleUiMatched) {
    warnings.push(
      "Visible Codex UI did not show the unique text during OCR. Runtime and rollout proof passed, but live desktop refresh still looks best-effort.",
    );
  }

  if (options.requireVisibleUi && !visibleUiMatched) {
    return {
      passed: false,
      visibleUiMatched,
      warnings,
      failureMessage: `Visible desktop verification did not pass. Report: ${options.reportPath}`,
    };
  }

  return {
    passed: true,
    visibleUiMatched,
    warnings,
  };
}

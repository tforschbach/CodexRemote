export type DesktopVerificationStage = "activate" | "screenshot" | "ocr" | "match";

export type DesktopVerificationFailureCode =
  | "missing_display"
  | "screen_recording_permission"
  | "automation_permission"
  | "unknown";

export interface DesktopVerificationFailureDiagnosis {
  code: DesktopVerificationFailureCode;
  summary: string;
  suggestedAction: string;
}

export interface DesktopVerificationFailureDetails {
  stage: DesktopVerificationStage;
  message: string;
  diagnosis: DesktopVerificationFailureDiagnosis;
}

function normalizeMessage(message: string): string {
  return message.trim().toLowerCase();
}

export function diagnoseDesktopVerificationFailure(
  message: string,
): DesktopVerificationFailureDiagnosis {
  const normalized = normalizeMessage(message);

  if (
    normalized.includes("screen recording") ||
    normalized.includes("not authorized to capture screen") ||
    normalized.includes("user declined screenshot")
  ) {
    return {
      code: "screen_recording_permission",
      summary: "macOS blocked screen capture for this process.",
      suggestedAction:
        "Allow Screen Recording for the terminal or agent host in System Settings, then rerun the debug loop.",
    };
  }

  if (
    normalized.includes("could not create image from display") ||
    normalized.includes("execution error: an error of type -10827") ||
    normalized.includes("launchservices returned an error")
  ) {
    return {
      code: "missing_display",
      summary: "This process does not have access to an active macOS desktop session.",
      suggestedAction:
        "Run the debug loop inside a logged-in Mac session with a visible desktop, then retry.",
    };
  }

  if (
    normalized.includes("not authorized to send apple events") ||
    normalized.includes("not permitted to send keystrokes") ||
    normalized.includes("assistive access")
  ) {
    return {
      code: "automation_permission",
      summary: "macOS blocked UI automation for this process.",
      suggestedAction:
        "Allow Automation and Accessibility for the terminal or agent host, then rerun the debug loop.",
    };
  }

  return {
    code: "unknown",
    summary: "Desktop verification failed for an unknown environment reason.",
    suggestedAction:
      "Inspect the per-attempt report in logs/e2e and the original stderr to isolate the failing macOS command.",
  };
}

export function buildDesktopVerificationFailure(
  stage: DesktopVerificationStage,
  message: string,
): DesktopVerificationFailureDetails {
  return {
    stage,
    message,
    diagnosis: diagnoseDesktopVerificationFailure(message),
  };
}

export function formatDesktopVerificationFailure(
  stage: DesktopVerificationStage,
  message: string,
): string {
  const failure = buildDesktopVerificationFailure(stage, message);
  return `Desktop verification failed during ${stage}: ${failure.diagnosis.summary} ${failure.diagnosis.suggestedAction} Original error: ${message.trim()}`;
}

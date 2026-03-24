import { strict as assert } from "node:assert";
import test from "node:test";

import {
  diagnoseDesktopVerificationFailure,
  formatDesktopVerificationFailure,
} from "../src/desktop/verification-diagnostics.js";

test("diagnoseDesktopVerificationFailure explains missing display access", () => {
  const diagnosis = diagnoseDesktopVerificationFailure(
    "Command failed: screencapture -x /tmp/check.png\ncould not create image from display\n",
  );

  assert.equal(diagnosis.code, "missing_display");
  assert.match(diagnosis.summary, /active macos desktop session/i);
  assert.match(diagnosis.suggestedAction, /logged-in mac session/i);
});

test("diagnoseDesktopVerificationFailure explains screen recording permission failures", () => {
  const diagnosis = diagnoseDesktopVerificationFailure(
    "Screen Recording permission denied for Terminal while capturing the desktop.",
  );

  assert.equal(diagnosis.code, "screen_recording_permission");
  assert.match(diagnosis.suggestedAction, /screen recording/i);
});

test("formatDesktopVerificationFailure includes the actionable diagnosis", () => {
  const formatted = formatDesktopVerificationFailure(
    "screenshot",
    "execution error: An error of type -10827 has occurred. (-10827)",
  );

  assert.match(formatted, /failed during screenshot/i);
  assert.match(formatted, /active macos desktop session/i);
  assert.match(formatted, /original error/i);
});

import { strict as assert } from "node:assert";
import test from "node:test";

import { evaluateClosedLoopGate } from "../src/debug-loop/loop-gate.js";

test("evaluateClosedLoopGate passes when stream and rollout proof pass even if visible OCR misses", () => {
  const result = evaluateClosedLoopGate({
    reportPath: "/tmp/report.json",
    streamEventCount: 4,
    rolloutVerification: {
      rolloutPath: "/tmp/rollout.jsonl",
      messageCount: 12,
      userMessageFound: true,
    },
    desktopVerification: {
      matched: false,
    },
  });

  assert.equal(result.passed, true);
  assert.equal(result.visibleUiMatched, false);
  assert.equal(result.warnings.length, 1);
});

test("evaluateClosedLoopGate fails when rollout proof is missing", () => {
  const result = evaluateClosedLoopGate({
    reportPath: "/tmp/report.json",
    streamEventCount: 4,
    rolloutVerification: {
      messageCount: 0,
      userMessageFound: false,
    },
    desktopVerification: {
      matched: true,
    },
  });

  assert.equal(result.passed, false);
  assert.match(result.failureMessage ?? "", /rollout/i);
});

test("evaluateClosedLoopGate can still require visible UI explicitly", () => {
  const result = evaluateClosedLoopGate({
    reportPath: "/tmp/report.json",
    streamEventCount: 4,
    rolloutVerification: {
      rolloutPath: "/tmp/rollout.jsonl",
      messageCount: 12,
      userMessageFound: true,
    },
    desktopVerification: {
      matched: false,
    },
    requireVisibleUi: true,
  });

  assert.equal(result.passed, false);
  assert.match(result.failureMessage ?? "", /Visible desktop verification/i);
});

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveDebugLoopTargets,
  selectDebugLoopProject,
} from "../src/desktop/debug-loop-targets.js";

test("resolveDebugLoopTargets keeps desktop verification on the selected project", () => {
  const targets = resolveDebugLoopTargets(
    "/Users/example/CascadeProjects/Codex Mobile App",
    "/tmp/codex-remote-debug-workspace/workspace",
  );

  assert.deepEqual(targets, {
    exerciseCwd: "/tmp/codex-remote-debug-workspace/workspace",
    desktopCwd: "/Users/example/CascadeProjects/Codex Mobile App",
    usesSeparateDesktopChat: true,
  });
});

test("resolveDebugLoopTargets reuses one chat when both paths are the same", () => {
  const targets = resolveDebugLoopTargets(
    "/Users/example/CascadeProjects/Codex Mobile App",
    "/Users/example/CascadeProjects/Codex Mobile App",
  );

  assert.deepEqual(targets, {
    exerciseCwd: "/Users/example/CascadeProjects/Codex Mobile App",
    desktopCwd: "/Users/example/CascadeProjects/Codex Mobile App",
    usesSeparateDesktopChat: false,
  });
});

test("selectDebugLoopProject prefers the current repo cwd over list order", () => {
  const selected = selectDebugLoopProject(
    [
      {
        id: "fludge",
        cwd: "/Users/example/CascadeProjects/fludge",
        title: "fludge",
      },
      {
        id: "codex-mobile",
        cwd: "/Users/example/CascadeProjects/Codex Mobile App",
        title: "Codex Mobile App",
      },
    ],
    {
      preferredCwd: "/Users/example/CascadeProjects/Codex Mobile App",
    },
  );

  assert.equal(selected?.id, "codex-mobile");
});

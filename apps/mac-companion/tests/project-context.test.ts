import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { LocalProjectContextStore, testing } from "../src/context/project-context.js";

const execFileAsync = promisify(execFile);

test("parseGitStatus reads staged, unstaged and untracked entries", () => {
  const parsed = testing.parseGitStatus(["M  staged.txt", " M dirty.txt", "?? fresh.txt"].join("\n"));

  assert.deepEqual(parsed, [
    {
      path: "staged.txt",
      indexStatus: "M",
      workingTreeStatus: " ",
    },
    {
      path: "dirty.txt",
      indexStatus: " ",
      workingTreeStatus: "M",
    },
    {
      path: "fresh.txt",
      indexStatus: "?",
      workingTreeStatus: "?",
    },
  ]);
});

test("LocalProjectContextStore reads Codex config and git context", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-remote-project-context-"));
  const codexHome = join(root, ".codex");
  const repo = join(root, "demo-project");
  await mkdir(codexHome, { recursive: true });
  await mkdir(repo, { recursive: true });

  await writeFile(join(codexHome, "config.toml"), [
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    'model = "gpt-5.4"',
    'model_reasoning_effort = "xhigh"',
    '',
    `[projects."${repo}"]`,
    'trust_level = "trusted"',
    '',
  ].join("\n"));

  await execFileAsync("git", ["init", "-b", "main", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "codex@example.com"]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Codex Remote"]);

  await writeFile(join(repo, "staged.txt"), "base\n");
  await writeFile(join(repo, "dirty.txt"), "base\n");
  await execFileAsync("git", ["-C", repo, "add", "staged.txt", "dirty.txt"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "init"]);

  await writeFile(join(repo, "staged.txt"), "base\nnext\n");
  await execFileAsync("git", ["-C", repo, "add", "staged.txt"]);
  await writeFile(join(repo, "dirty.txt"), "base\nchanged\n");
  await writeFile(join(repo, "fresh.txt"), "new\n");

  const store = new LocalProjectContextStore(codexHome);
  const context = await store.loadProjectContext({
    projectId: "project-1",
    cwd: repo,
  });

  assert.equal(context.runtimeMode, "local");
  assert.equal(context.approvalPolicy, "never");
  assert.equal(context.sandboxMode, "workspace-write");
  assert.equal(context.model, "gpt-5.4");
  assert.equal(context.modelReasoningEffort, "xhigh");
  assert.equal(context.trustLevel, "trusted");
  assert.equal(context.git.isRepository, true);
  assert.equal(context.git.branch, "main");
  assert.equal(context.git.changedFiles, 3);
  assert.equal(context.git.stagedFiles, 1);
  assert.equal(context.git.unstagedFiles, 1);
  assert.equal(context.git.untrackedFiles, 1);
  assert.deepEqual(
    context.git.changedPaths.map((file) => file.path).sort(),
    ["dirty.txt", "fresh.txt", "staged.txt"],
  );
});

test("LocalProjectContextStore lists branches and checks out an existing branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-remote-project-branches-"));
  const codexHome = join(root, ".codex");
  const repo = join(root, "demo-project");
  await mkdir(codexHome, { recursive: true });
  await mkdir(repo, { recursive: true });

  await execFileAsync("git", ["init", "-b", "main", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "codex@example.com"]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Codex Remote"]);
  await writeFile(join(repo, "README.md"), "base\n");
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "init"]);
  await execFileAsync("git", ["-C", repo, "checkout", "-b", "feature/mobile"]);
  await execFileAsync("git", ["-C", repo, "checkout", "main"]);

  const store = new LocalProjectContextStore(codexHome);
  const branches = await store.loadGitBranches({ cwd: repo });

  assert.deepEqual(
    branches.map((branch) => ({ name: branch.name, isCurrent: branch.isCurrent })),
    [
      { name: "main", isCurrent: true },
      { name: "feature/mobile", isCurrent: false },
    ],
  );

  const git = await store.checkoutGitBranch({
    cwd: repo,
    branch: "feature/mobile",
  });

  assert.equal(git.branch, "feature/mobile");
});

test("LocalProjectContextStore renders diff output and commits staged changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-remote-project-diff-"));
  const codexHome = join(root, ".codex");
  const repo = join(root, "demo-project");
  await mkdir(codexHome, { recursive: true });
  await mkdir(repo, { recursive: true });

  await execFileAsync("git", ["init", "-b", "main", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "codex@example.com"]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Codex Remote"]);
  await writeFile(join(repo, "tracked.txt"), "base\n");
  await execFileAsync("git", ["-C", repo, "add", "tracked.txt"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "init"]);

  await writeFile(join(repo, "tracked.txt"), "base\nnext\n");
  await execFileAsync("git", ["-C", repo, "add", "tracked.txt"]);
  await writeFile(join(repo, "local-only.txt"), "fresh\n");

  const store = new LocalProjectContextStore(codexHome);
  const diff = await store.loadGitDiff({ cwd: repo });

  assert.equal(diff.path, null);
  assert.equal(diff.truncated, false);
  assert.match(diff.text, /## Staged changes/);
  assert.match(diff.text, /tracked\.txt/);
  assert.match(diff.text, /## Untracked files/);
  assert.deepEqual(diff.untrackedPaths, ["local-only.txt"]);

  const committed = await store.commitGitChanges({
    cwd: repo,
    message: "Commit from remote",
  });

  assert.equal(committed.branch, "main");
  assert.equal(committed.summary, "Commit from remote");

  const head = await execFileAsync("git", ["-C", repo, "log", "-1", "--pretty=%s"]);
  assert.equal(head.stdout.trim(), "Commit from remote");
});

test("updateTopLevelConfigAssignments replaces and inserts runtime config values", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-remote-config-update-"));
  const configPath = join(root, ".codex", "config.toml");
  await mkdir(join(root, ".codex"), { recursive: true });
  await writeFile(configPath, [
    'model = "gpt-5.4"',
    '',
    '[projects."/tmp/project"]',
    'trust_level = "trusted"',
    '',
  ].join("\n"));

  const updated = await testing.updateTopLevelConfigAssignments(configPath, {
    approval_policy: "on-request",
    sandbox_mode: "danger-full-access",
  });

  const contents = await readFile(configPath, "utf8");
  assert.match(contents, /approval_policy = "on-request"/);
  assert.match(contents, /sandbox_mode = "danger-full-access"/);
  assert.match(contents, /\[projects\."\/tmp\/project"\]/);
  assert.equal(updated.approvalPolicy, "on-request");
  assert.equal(updated.sandboxMode, "danger-full-access");
});

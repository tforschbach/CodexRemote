import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 4_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
const DIFF_LIMIT_CHARS = 64_000;

export const SUPPORTED_APPROVAL_POLICIES = [
  "untrusted",
  "on-failure",
  "on-request",
  "never",
] as const;

export const SUPPORTED_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;

type SupportedApprovalPolicy = (typeof SUPPORTED_APPROVAL_POLICIES)[number];
type SupportedSandboxMode = (typeof SUPPORTED_SANDBOX_MODES)[number];

export interface GitChangedFile {
  path: string;
  indexStatus: string;
  workingTreeStatus: string;
}

export interface GitBranch {
  name: string;
  isCurrent: boolean;
}

export interface GitContextSnapshot {
  isRepository: boolean;
  branch: string | null;
  changedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  changedPaths: GitChangedFile[];
}

export interface ProjectContextSnapshot {
  projectId: string;
  cwd: string;
  runtimeMode: "local";
  approvalPolicy: string | null;
  sandboxMode: string | null;
  model: string | null;
  modelReasoningEffort: string | null;
  trustLevel: string | null;
  git: GitContextSnapshot;
}

export interface GitDiffSnapshot {
  path: string | null;
  text: string;
  truncated: boolean;
  untrackedPaths: string[];
}

export interface GitCommitResult {
  branch: string | null;
  commitHash: string;
  summary: string;
}

export interface RuntimeConfigSnapshot {
  approvalPolicy: string | null;
  sandboxMode: string | null;
  model: string | null;
  modelReasoningEffort: string | null;
}

export interface ProjectContextStore {
  loadProjectContext(input: { projectId: string; cwd: string }): Promise<ProjectContextSnapshot>;
  loadGitBranches(input: { cwd: string }): Promise<GitBranch[]>;
  loadGitDiff(input: { cwd: string; path?: string }): Promise<GitDiffSnapshot>;
  checkoutGitBranch(input: { cwd: string; branch: string }): Promise<GitContextSnapshot>;
  commitGitChanges(input: { cwd: string; message: string }): Promise<GitCommitResult>;
  updateRuntimeConfig(input: {
    approvalPolicy?: string;
    sandboxMode?: string;
  }): Promise<RuntimeConfigSnapshot>;
}

interface ParsedCodexConfig {
  approvalPolicy: string | null;
  sandboxMode: string | null;
  model: string | null;
  modelReasoningEffort: string | null;
  projectTrustLevels: Record<string, string>;
}

export class LocalProjectContextStore implements ProjectContextStore {
  private readonly codexHomePath: string;

  public constructor(codexHomePath: string) {
    this.codexHomePath = codexHomePath;
  }

  public async loadProjectContext(input: { projectId: string; cwd: string }): Promise<ProjectContextSnapshot> {
    const [config, git] = await Promise.all([readCodexConfig(this.configPath), readGitContext(input.cwd)]);

    return {
      projectId: input.projectId,
      cwd: input.cwd,
      runtimeMode: "local",
      approvalPolicy: config.approvalPolicy,
      sandboxMode: config.sandboxMode,
      model: config.model,
      modelReasoningEffort: config.modelReasoningEffort,
      trustLevel: config.projectTrustLevels[input.cwd] ?? null,
      git,
    };
  }

  public async loadGitBranches(input: { cwd: string }): Promise<GitBranch[]> {
    await assertGitRepository(input.cwd);
    const result = await runGitOrThrow(input.cwd, [
      "branch",
      "--format=%(refname:short)\t%(HEAD)",
    ]);

    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [rawName = "", rawHeadMarker = ""] = line.split("\t");
        const name = rawName.trim();
        return {
          name,
          isCurrent: rawHeadMarker === "*",
        } satisfies GitBranch;
      })
      .filter((branch) => branch.name.length > 0)
      .sort((left, right) => {
        if (left.isCurrent && !right.isCurrent) {
          return -1;
        }
        if (!left.isCurrent && right.isCurrent) {
          return 1;
        }
        return left.name.localeCompare(right.name);
      });
  }

  public async loadGitDiff(input: { cwd: string; path?: string }): Promise<GitDiffSnapshot> {
    await assertGitRepository(input.cwd);

    const pathArgs = input.path ? ["--", input.path] : [];
    const [staged, unstaged, status] = await Promise.all([
      runGitOrThrow(input.cwd, ["diff", "--cached", "--no-ext-diff", "--patch", ...pathArgs], {
        maxBuffer: GIT_MAX_BUFFER,
      }),
      runGitOrThrow(input.cwd, ["diff", "--no-ext-diff", "--patch", ...pathArgs], {
        maxBuffer: GIT_MAX_BUFFER,
      }),
      runGitOrThrow(input.cwd, ["status", "--porcelain=v1", ...(input.path ? ["--", input.path] : [])]),
    ]);

    const parsedStatus = parseGitStatus(status.stdout);
    const untrackedPaths = parsedStatus
      .filter((file) => file.indexStatus === "?" && file.workingTreeStatus === "?")
      .map((file) => file.path);

    const rendered = renderDiffText({
      path: input.path ?? null,
      stagedText: staged.stdout,
      unstagedText: unstaged.stdout,
      untrackedPaths,
    });

    return {
      path: input.path ?? null,
      text: rendered.text,
      truncated: rendered.truncated,
      untrackedPaths,
    };
  }

  public async checkoutGitBranch(input: { cwd: string; branch: string }): Promise<GitContextSnapshot> {
    await assertGitRepository(input.cwd);
    assertSupportedBranchName(input.branch);
    await runGitOrThrow(input.cwd, ["checkout", input.branch]);
    return readGitContext(input.cwd);
  }

  public async commitGitChanges(input: { cwd: string; message: string }): Promise<GitCommitResult> {
    await assertGitRepository(input.cwd);
    const message = input.message.trim();
    if (!message) {
      throw new Error("Commit message is required");
    }

    const stagedStatus = await runGit(input.cwd, ["diff", "--cached", "--quiet", "--exit-code"]);
    if (stagedStatus.ok) {
      throw new Error("There are no staged changes to commit");
    }

    await runGitOrThrow(input.cwd, ["commit", "-m", message], {
      timeout: 8_000,
      maxBuffer: GIT_MAX_BUFFER,
    });

    const [branchResult, logResult] = await Promise.all([
      runGitOrThrow(input.cwd, ["branch", "--show-current"]),
      runGitOrThrow(input.cwd, ["log", "-1", "--pretty=format:%H%n%s"]),
    ]);

    const [commitHash = "", summary = ""] = logResult.stdout.trim().split(/\r?\n/, 2);
    return {
      branch: branchResult.stdout.trim() || null,
      commitHash,
      summary,
    };
  }

  public async updateRuntimeConfig(input: {
    approvalPolicy?: string;
    sandboxMode?: string;
  }): Promise<RuntimeConfigSnapshot> {
    if (input.approvalPolicy !== undefined) {
      assertSupportedApprovalPolicy(input.approvalPolicy);
    }
    if (input.sandboxMode !== undefined) {
      assertSupportedSandboxMode(input.sandboxMode);
    }

    const updated = await updateTopLevelConfigAssignments(this.configPath, {
      approval_policy: input.approvalPolicy,
      sandbox_mode: input.sandboxMode,
    });

    return {
      approvalPolicy: updated.approvalPolicy,
      sandboxMode: updated.sandboxMode,
      model: updated.model,
      modelReasoningEffort: updated.modelReasoningEffort,
    };
  }

  private get configPath(): string {
    return join(this.codexHomePath, "config.toml");
  }
}

async function readCodexConfig(configPath: string): Promise<ParsedCodexConfig> {
  try {
    await access(configPath, constants.R_OK);
  } catch {
    return emptyConfig();
  }

  const file = await readFile(configPath, "utf8");
  const lines = file.split(/\r?\n/);

  const parsed: ParsedCodexConfig = emptyConfig();
  let currentSection: string | null = null;
  let currentProjectPath: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const projectSectionMatch = line.match(/^\[projects\."(.+)"\]$/);
    if (projectSectionMatch) {
      currentSection = "project";
      currentProjectPath = projectSectionMatch[1] ?? null;
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      currentSection = line.slice(1, -1);
      currentProjectPath = null;
      continue;
    }

    const assignmentMatch = line.match(/^([A-Za-z0-9_\-.]+)\s*=\s*(.+)$/);
    if (!assignmentMatch) {
      continue;
    }

    const key = assignmentMatch[1] ?? "";
    const value = parseTomlScalar(assignmentMatch[2] ?? "");
    if (value === null) {
      continue;
    }

    if (currentSection === null) {
      switch (key) {
        case "approval_policy":
          parsed.approvalPolicy = value;
          break;
        case "sandbox_mode":
          parsed.sandboxMode = value;
          break;
        case "model":
          parsed.model = value;
          break;
        case "model_reasoning_effort":
          parsed.modelReasoningEffort = value;
          break;
        default:
          break;
      }
      continue;
    }

    if (currentSection === "project" && currentProjectPath && key === "trust_level") {
      parsed.projectTrustLevels[currentProjectPath] = value;
    }
  }

  return parsed;
}

function parseTomlScalar(rawValue: string): string | null {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  const stringMatch = trimmed.match(/^"(.*)"$/);
  if (stringMatch) {
    return stringMatch[1] ?? null;
  }

  const bareMatch = trimmed.match(/^([A-Za-z0-9_\-.]+)$/);
  if (bareMatch) {
    return bareMatch[1] ?? null;
  }

  return null;
}

async function updateTopLevelConfigAssignments(
  configPath: string,
  updates: Record<string, string | undefined>,
): Promise<ParsedCodexConfig> {
  await mkdir(dirname(configPath), { recursive: true });

  let file = "";
  try {
    file = await readFile(configPath, "utf8");
  } catch {
    file = "";
  }

  const lines = file ? file.split(/\r?\n/) : [];
  const firstSectionIndex = lines.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("[") && trimmed.endsWith("]");
  });

  const appliedKeys = new Set<string>();
  let insideTopLevel = true;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim() ?? "";
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      insideTopLevel = false;
      continue;
    }

    if (!insideTopLevel) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z0-9_\-.]+)\s*=\s*(.+)$/);
    if (!match) {
      continue;
    }

    const key = match[1] ?? "";
    const nextValue = updates[key];
    if (nextValue === undefined) {
      continue;
    }

    lines[index] = `${key} = "${nextValue}"`;
    appliedKeys.add(key);
  }

  const missingAssignments = Object.entries(updates)
    .filter(([key, value]) => value !== undefined && !appliedKeys.has(key))
    .map(([key, value]) => `${key} = "${value}"`);

  if (missingAssignments.length > 0) {
    const insertionIndex = firstSectionIndex >= 0 ? firstSectionIndex : lines.length;
    if (insertionIndex > 0 && lines[insertionIndex - 1] !== "") {
      missingAssignments.unshift("");
    }
    lines.splice(insertionIndex, 0, ...missingAssignments);
  }

  const nextFile = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  await writeFile(configPath, nextFile, "utf8");
  return readCodexConfig(configPath);
}

function emptyConfig(): ParsedCodexConfig {
  return {
    approvalPolicy: null,
    sandboxMode: null,
    model: null,
    modelReasoningEffort: null,
    projectTrustLevels: {},
  };
}

async function readGitContext(cwd: string): Promise<GitContextSnapshot> {
  const insideWorkTree = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!insideWorkTree.ok || insideWorkTree.stdout.trim() !== "true") {
    return {
      isRepository: false,
      branch: null,
      changedFiles: 0,
      stagedFiles: 0,
      unstagedFiles: 0,
      untrackedFiles: 0,
      changedPaths: [],
    };
  }

  const [branchResult, statusResult] = await Promise.all([
    runGit(cwd, ["branch", "--show-current"]),
    runGit(cwd, ["status", "--porcelain=v1"]),
  ]);

  const branch = branchResult.ok ? branchResult.stdout.trim() || "HEAD" : null;
  const changedPaths = parseGitStatus(statusResult.ok ? statusResult.stdout : "");

  let stagedFiles = 0;
  let unstagedFiles = 0;
  let untrackedFiles = 0;

  for (const file of changedPaths) {
    if (file.indexStatus !== " " && file.indexStatus !== "?") {
      stagedFiles += 1;
    }

    if (file.workingTreeStatus !== " ") {
      if (file.indexStatus === "?" && file.workingTreeStatus === "?") {
        untrackedFiles += 1;
      } else {
        unstagedFiles += 1;
      }
    }
  }

  return {
    isRepository: true,
    branch,
    changedFiles: changedPaths.length,
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    changedPaths,
  };
}

function parseGitStatus(stdout: string): GitChangedFile[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      if (line.startsWith("?? ")) {
        const path = line.slice(3);
        return {
          path,
          indexStatus: "?",
          workingTreeStatus: "?",
        } satisfies GitChangedFile;
      }

      const indexStatus = line[0] ?? " ";
      const workingTreeStatus = line[1] ?? " ";
      const path = line.slice(3).split(" -> ").at(-1) ?? line.slice(3);
      return {
        path,
        indexStatus,
        workingTreeStatus,
      } satisfies GitChangedFile;
    });
}

function renderDiffText(input: {
  path: string | null;
  stagedText: string;
  unstagedText: string;
  untrackedPaths: string[];
}): { text: string; truncated: boolean } {
  const sections: string[] = [];

  if (input.path) {
    sections.push(`# Diff for ${input.path}`);
  } else {
    sections.push("# Combined diff");
  }

  if (input.stagedText.trim()) {
    sections.push("## Staged changes", input.stagedText.trimEnd());
  }

  if (input.unstagedText.trim()) {
    sections.push("## Unstaged changes", input.unstagedText.trimEnd());
  }

  if (input.untrackedPaths.length > 0) {
    sections.push(
      "## Untracked files",
      "Git does not produce a patch for untracked files until they are staged.",
      ...input.untrackedPaths.map((path) => `?? ${path}`),
    );
  }

  if (sections.length === 1) {
    sections.push("No diff available.");
  }

  const text = sections.join("\n\n").trim();
  if (text.length <= DIFF_LIMIT_CHARS) {
    return {
      text,
      truncated: false,
    };
  }

  return {
    text: `${text.slice(0, DIFF_LIMIT_CHARS)}\n\n[Diff truncated]`,
    truncated: true,
  };
}

function assertSupportedApprovalPolicy(value: string): asserts value is SupportedApprovalPolicy {
  if (SUPPORTED_APPROVAL_POLICIES.includes(value as SupportedApprovalPolicy)) {
    return;
  }
  throw new Error(`Unsupported approval policy: ${value}`);
}

function assertSupportedSandboxMode(value: string): asserts value is SupportedSandboxMode {
  if (SUPPORTED_SANDBOX_MODES.includes(value as SupportedSandboxMode)) {
    return;
  }
  throw new Error(`Unsupported sandbox mode: ${value}`);
}

function assertSupportedBranchName(value: string): void {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Branch name is required");
  }

  if (trimmed.includes("..") || trimmed.includes(" ") || trimmed.startsWith("-")) {
    throw new Error(`Unsafe branch name: ${value}`);
  }
}

async function assertGitRepository(cwd: string): Promise<void> {
  const insideWorkTree = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!insideWorkTree.ok || insideWorkTree.stdout.trim() !== "true") {
    throw new Error("Project is not a Git repository");
  }
}

async function runGit(cwd: string, args: string[], options?: {
  timeout?: number;
  maxBuffer?: number;
}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("git", ["-C", cwd, ...args], {
      timeout: options?.timeout ?? GIT_TIMEOUT_MS,
      maxBuffer: options?.maxBuffer ?? GIT_MAX_BUFFER,
    });
    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const typed = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: typed.stdout ?? "",
      stderr: typed.stderr ?? "",
    };
  }
}

async function runGitOrThrow(cwd: string, args: string[], options?: {
  timeout?: number;
  maxBuffer?: number;
}): Promise<{ stdout: string; stderr: string }> {
  const result = await runGit(cwd, args, options);
  if (result.ok) {
    return {
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  const detail = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
  throw new Error(detail);
}

export const testing = {
  parseGitStatus,
  parseTomlScalar,
  renderDiffText,
  updateTopLevelConfigAssignments,
};

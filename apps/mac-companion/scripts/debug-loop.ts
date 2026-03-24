import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { WebSocket } from "ws";

import { loadConfig } from "../src/config.js";
import {
  evaluateClosedLoopGate,
} from "../src/debug-loop/loop-gate.js";
import {
  runDesktopVerificationLoop,
  type DesktopVerificationAttemptReport,
} from "../src/debug-loop/desktop-verification.js";
import { waitForRolloutVerification } from "../src/debug-loop/rollout-verification.js";
import {
  resolveDebugLoopTargets,
  selectDebugLoopProject,
} from "../src/desktop/debug-loop-targets.js";
import { RolloutHistoryStore } from "../src/history/rollout-history.js";

const execFileAsync = promisify(execFile);

interface Project {
  id: string;
  cwd: string;
  title: string;
}

interface ChatThread {
  id: string;
  projectId: string;
  title: string;
  preview: string;
  updatedAt: number;
}

interface ProjectContextEnvelope {
  data: {
    projectId: string;
    cwd: string;
    approvalPolicy: string | null;
    sandboxMode: string | null;
    git: {
      branch: string | null;
      changedFiles: number;
      stagedFiles: number;
      unstagedFiles: number;
      untrackedFiles: number;
    };
  };
}

interface DebugWorkspace {
  cwd: string;
  checkoutBranch: string;
  diffPath: string;
  commitMessage: string;
}

interface StreamEventEnvelope {
  event: string;
  chatId: string;
  payload: unknown;
  timestamp: number;
}

interface PairingRequestResponse {
  pairingId: string;
  nonce: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function normalizeUrl(value: string): URL {
  const url = new URL(value);
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "";
  }
  return url;
}

async function requestJSON(url: URL, options: RequestInit): Promise<unknown> {
  const response = await fetch(url, options);
  const raw = await response.text();
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`Expected JSON from ${url.pathname}, received: ${raw.slice(0, 120)}`);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function readJSONFile<T>(path: string): Promise<T | null> {
  try {
    const contents = await readFile(path, "utf8");
    return JSON.parse(contents) as T;
  } catch {
    return null;
  }
}

async function createDebugGitWorkspace(traceId: string): Promise<DebugWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "codex-remote-debug-workspace-"));
  const repo = join(root, "workspace");
  const checkoutBranch = "feature/remote-debug";
  const commitMessage = `Remote debug commit ${traceId.slice(-6)}`;
  await mkdir(repo, { recursive: true });

  await execFileAsync("git", ["init", "-b", "main", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "codex-remote@example.com"]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "Codex Remote Debug"]);
  await writeFile(join(repo, "README.md"), "# Codex Remote Debug\n");
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "Initial debug workspace"]);
  await execFileAsync("git", ["-C", repo, "checkout", "-b", checkoutBranch]);
  await execFileAsync("git", ["-C", repo, "checkout", "main"]);

  await writeFile(join(repo, "README.md"), "# Codex Remote Debug\n\nChanged from the debug loop.\n");
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await writeFile(join(repo, "notes.txt"), "Untracked notes from the debug loop.\n");

  return {
    cwd: repo,
    checkoutBranch,
    diffPath: "README.md",
    commitMessage,
  };
}

async function waitForStreamEvent(
  wsUrl: URL,
  token: string,
  timeoutMs: number,
): Promise<{ events: StreamEventEnvelope[]; terminalEvent?: StreamEventEnvelope }> {
  const events: StreamEventEnvelope[] = [];

  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(wsUrl, {
      headers: {
        authorization: `Bearer ${token}`,
      },
    });
    let settled = false;

    const timeout = setTimeout(() => {
      socket.close();
      if (!settled) {
        settled = true;
        resolvePromise({ events });
      }
    }, timeoutMs);

    socket.on("message", (payload) => {
      try {
        const parsed = JSON.parse(payload.toString()) as StreamEventEnvelope;
        events.push(parsed);
        if (
          parsed.event === "turn_completed" ||
          parsed.event === "approval_required" ||
          parsed.event === "error"
        ) {
          clearTimeout(timeout);
          socket.close();
          if (!settled) {
            settled = true;
            resolvePromise({ events, terminalEvent: parsed });
          }
        }
      } catch (error) {
        clearTimeout(timeout);
        socket.close();
        if (!settled) {
          settled = true;
          rejectPromise(error);
        }
      }
    });

    socket.on("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        rejectPromise(error);
      }
    });

    socket.on("close", () => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        resolvePromise({ events });
      }
    });
  });
}

async function autoApprovePairingDialog(timeoutSeconds: number): Promise<void> {
  const script = `
tell application "System Events"
  repeat ${timeoutSeconds * 4} times
    repeat with processName in {"osascript", "node", "Codex"}
      try
        tell process processName
          if exists (button "Allow" of window 1) then
            click button "Allow" of window 1
            return "clicked"
          end if
        end tell
      end try
    end repeat
    delay 0.25
  end repeat
end tell
return "timeout"
`;

  const { stdout } = await execFileAsync("osascript", ["-e", script]);
  if (!stdout.includes("clicked")) {
    throw new Error("Auto-approve pairing dialog timed out");
  }
}

async function issueTokenViaPairing(companionUrl: URL, traceId: string): Promise<{ token: string; deviceId: string }> {
  const pairing = await requestJSON(new URL("/v1/pairing/request", companionUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-trace-id": traceId,
    },
    body: JSON.stringify({}),
  }) as PairingRequestResponse;

  const approvePromise = autoApprovePairingDialog(30);
  const issued = await requestJSON(new URL("/v1/pairing/confirm", companionUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-codex-trace-id": traceId,
    },
    body: JSON.stringify({
      pairingId: pairing.pairingId,
      nonce: pairing.nonce,
      deviceName: "Codex Debug Loop",
    }),
  }) as { token: string; deviceId: string };

  await approvePromise.catch(() => undefined);
  return issued;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const logsDir = join(repoRoot, "logs", "e2e");
  await mkdir(logsDir, { recursive: true });

  const traceId = process.env.DEBUG_TRACE_ID ?? `debug-${randomUUID()}`;
  const companionUrl = normalizeUrl(process.env.COMPANION_URL ?? `http://127.0.0.1:${config.port}`);
  const timeoutMs = Number.parseInt(process.env.DEBUG_TIMEOUT_MS ?? "20000", 10);
  const desktopVerifyDelayMs = Number.parseInt(process.env.DESKTOP_VERIFY_DELAY_MS ?? "1800", 10);
  const desktopVerifyCommandTimeoutMs = Number.parseInt(
    process.env.DESKTOP_VERIFY_COMMAND_TIMEOUT_MS ?? "30000",
    10,
  );
  const rolloutVerifyTimeoutMs = Number.parseInt(
    process.env.ROLLOUT_VERIFY_TIMEOUT_MS ?? "5000",
    10,
  );
  const expectedProjectMatch = (process.env.DEBUG_PROJECT_MATCH ?? "").toLowerCase();
  const requireVisibleUi = process.env.DEBUG_REQUIRE_VISIBLE_UI === "1";
  const uniqueMessage = process.env.DEBUG_MESSAGE ?? `codex-remote-debug-${traceId.slice(-8)}`;
  const reportPath = join(logsDir, `debug-loop-${traceId}.json`);
  const report: Record<string, unknown> = {
    traceId,
    companionUrl: companionUrl.toString(),
    message: uniqueMessage,
    reportPath,
    createdAt: new Date().toISOString(),
  };
  const useTempGitWorkspace = process.env.DEBUG_USE_TEMP_GIT_WORKSPACE !== "0";
  const historyStore = new RolloutHistoryStore(config.codexSessionsPath);

  const { token, deviceId } = process.env.COMPANION_TOKEN
    ? { token: process.env.COMPANION_TOKEN, deviceId: "external-token" }
    : await (async () => {
      try {
        report.tokenAcquisition = "debug-endpoint";
        return await requestJSON(new URL("/v1/debug/issue-token", companionUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-codex-trace-id": traceId,
          },
          body: JSON.stringify({ deviceName: "Codex Debug Loop" }),
        }) as { token: string; deviceId: string };
      } catch {
        report.tokenAcquisition = "pairing-fallback";
        return issueTokenViaPairing(companionUrl, traceId);
      }
    })();
  report.deviceId = deviceId;

  try {
    const projectsEnvelope = await requestJSON(new URL("/v1/projects", companionUrl), {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "x-codex-trace-id": traceId,
      },
    }) as { data: Project[] };

    const project = selectDebugLoopProject(projectsEnvelope.data, {
      explicitProjectId: process.env.DEBUG_PROJECT_ID,
      explicitProjectMatch: expectedProjectMatch,
      preferredCwd: repoRoot,
    });
    report.projectsReturned = projectsEnvelope.data.length;
    const debugWorkspace = useTempGitWorkspace ? await createDebugGitWorkspace(traceId) : null;
    if (debugWorkspace) {
      report.debugWorkspace = debugWorkspace;
    }

    if (!project && !debugWorkspace) {
      throw new Error("No project available for debug loop.");
    }
    report.project = project ?? { id: "temp-git-workspace", cwd: debugWorkspace?.cwd ?? "", title: "Debug workspace" };

    const debugTargets = resolveDebugLoopTargets(project.cwd, debugWorkspace?.cwd ?? null);

    const createdChatEnvelope = await requestJSON(new URL("/v1/chats", companionUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-codex-trace-id": traceId,
      },
      body: JSON.stringify({ cwd: debugTargets.exerciseCwd }),
    }) as { data: ChatThread };

    const exerciseChatId = createdChatEnvelope.data.id;
    const exerciseProjectId = createdChatEnvelope.data.projectId;
    report.exerciseChatId = exerciseChatId;
    report.exerciseProjectId = exerciseProjectId;
    report.debugTargets = debugTargets;

    const initialContext = await requestJSON(
      new URL(`/v1/projects/${encodeURIComponent(exerciseProjectId)}/context`, companionUrl),
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${token}`,
          "x-codex-trace-id": traceId,
        },
      },
    ) as ProjectContextEnvelope;
    report.initialProjectContext = initialContext.data;

    if (debugWorkspace) {
      const branchesEnvelope = await requestJSON(
        new URL(`/v1/projects/${encodeURIComponent(exerciseProjectId)}/git/branches`, companionUrl),
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${token}`,
            "x-codex-trace-id": traceId,
          },
        },
      ) as { data: Array<{ name: string; isCurrent: boolean }> };

      const combinedDiffEnvelope = await requestJSON(
        new URL(`/v1/projects/${encodeURIComponent(exerciseProjectId)}/git/diff`, companionUrl),
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${token}`,
            "x-codex-trace-id": traceId,
          },
        },
      ) as { data: { text: string; truncated: boolean } };

      const fileDiffEnvelope = await requestJSON(
        new URL(`/v1/projects/${encodeURIComponent(exerciseProjectId)}/git/diff?path=${encodeURIComponent(debugWorkspace.diffPath)}`, companionUrl),
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${token}`,
            "x-codex-trace-id": traceId,
          },
        },
      ) as { data: { path: string | null; text: string } };

      const checkoutEnvelope = await requestJSON(
        new URL(`/v1/projects/${encodeURIComponent(exerciseProjectId)}/git/checkout`, companionUrl),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-codex-trace-id": traceId,
          },
          body: JSON.stringify({ branch: debugWorkspace.checkoutBranch }),
        },
      ) as { data: { branch: string | null } };

      const committedEnvelope = await requestJSON(
        new URL(`/v1/projects/${encodeURIComponent(exerciseProjectId)}/git/commit`, companionUrl),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-codex-trace-id": traceId,
          },
          body: JSON.stringify({ message: debugWorkspace.commitMessage }),
        },
      ) as { data: { commitHash: string; summary: string } };

      const runtimeConfigEnvelope = await requestJSON(new URL("/v1/runtime/config", companionUrl), {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-codex-trace-id": traceId,
        },
        body: JSON.stringify({
          approvalPolicy: initialContext.data.approvalPolicy,
          sandboxMode: initialContext.data.sandboxMode,
        }),
      }) as { data: { approvalPolicy: string | null; sandboxMode: string | null } };

      const finalContext = await requestJSON(
        new URL(`/v1/projects/${encodeURIComponent(exerciseProjectId)}/context`, companionUrl),
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${token}`,
            "x-codex-trace-id": traceId,
          },
        },
      ) as ProjectContextEnvelope;

      report.gitExercise = {
        branches: branchesEnvelope.data,
        combinedDiffPreview: combinedDiffEnvelope.data.text.slice(0, 400),
        combinedDiffTruncated: combinedDiffEnvelope.data.truncated,
        fileDiffPreview: fileDiffEnvelope.data.text.slice(0, 400),
        checkoutBranch: checkoutEnvelope.data.branch,
        commitHash: committedEnvelope.data.commitHash,
        commitSummary: committedEnvelope.data.summary,
        finalContext: finalContext.data.git,
      };
      report.runtimeConfigRoundTrip = runtimeConfigEnvelope.data;
    }

    const desktopChatEnvelope = debugTargets.usesSeparateDesktopChat
      ? await requestJSON(new URL("/v1/chats", companionUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-codex-trace-id": traceId,
        },
        body: JSON.stringify({ cwd: debugTargets.desktopCwd }),
      }) as { data: ChatThread }
      : createdChatEnvelope;

    const chatId = desktopChatEnvelope.data.id;
    const projectId = desktopChatEnvelope.data.projectId;
    report.chatId = chatId;
    report.projectId = projectId;
    report.desktopChatSource = debugTargets.usesSeparateDesktopChat
      ? "created-chat"
      : "exercise-chat";

    await requestJSON(new URL(`/v1/chats/${encodeURIComponent(chatId)}/activate`, companionUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "x-codex-trace-id": traceId,
      },
    });

    const wsUrl = new URL(`/v1/stream?chatId=${encodeURIComponent(chatId)}`, companionUrl);
    wsUrl.protocol = companionUrl.protocol === "https:" ? "wss:" : "ws:";

    const streamPromise = waitForStreamEvent(wsUrl, token, timeoutMs);
    await sleep(250);

    await requestJSON(new URL(`/v1/chats/${encodeURIComponent(chatId)}/messages`, companionUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-codex-trace-id": traceId,
      },
      body: JSON.stringify({ text: uniqueMessage }),
    });

    const streamResult = await streamPromise;
    report.streamEvents = streamResult.events;
    report.terminalStreamEvent = streamResult.terminalEvent;

    const chatsEnvelope = await requestJSON(new URL(`/v1/chats?projectId=${encodeURIComponent(projectId)}`, companionUrl), {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "x-codex-trace-id": traceId,
      },
    }) as { data: ChatThread[] };

    const matchingChat = chatsEnvelope.data.find((entry) => entry.id === chatId);
    const traceLogLines = await readTraceLogLines(config.traceLogPath, traceId);
    report.chatAfterSend = matchingChat;
    report.traceLogLines = traceLogLines;

    const rolloutVerification = await waitForRolloutVerification({
      historyStore,
      chatId,
      expectedUserMessage: uniqueMessage,
      timeoutMs: rolloutVerifyTimeoutMs,
    });
    report.rolloutVerification = rolloutVerification;

    const { desktopVerification, lastDesktopError } = await runDesktopVerificationLoop({
      nodePath: process.execPath,
      macCompanionDir: join(repoRoot, "apps", "mac-companion"),
      logsDir,
      traceId,
      uniqueMessage,
      projectTitle: project.title,
      chatTitle: matchingChat?.title ?? desktopChatEnvelope.data.title,
      desktopVerifyDelayMs,
      commandTimeoutMs: desktopVerifyCommandTimeoutMs,
      appName: process.env.CODEX_MAC_APP_NAME ?? "Codex",
      appPath: process.env.CODEX_MAC_APP_PATH ?? "",
      bundleId: process.env.CODEX_MAC_BUNDLE_ID ?? "",
    });
    report.desktopVerification = desktopVerification;
    report.desktopVerificationError = lastDesktopError || undefined;

    const closedLoop = evaluateClosedLoopGate({
      reportPath,
      streamEventCount: streamResult.events.length,
      rolloutVerification,
      desktopVerification,
      requireVisibleUi,
    });
    report.closedLoop = closedLoop;

    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    if (!closedLoop.passed) {
      throw new Error(closedLoop.failureMessage ?? `Closed loop verification did not pass. Report: ${reportPath}`);
    }

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    report.traceLogLines = await readTraceLogLines(config.traceLogPath, traceId);
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    throw error;
  } finally {
    if (!process.env.COMPANION_TOKEN) {
      await requestJSON(new URL("/v1/pairing/revoke", companionUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-codex-trace-id": traceId,
        },
        body: JSON.stringify({}),
      }).catch(() => undefined);
    }
  }
}

async function readTraceLogLines(path: string, traceId: string): Promise<string[]> {
  try {
    const contents = await readFile(path, "utf8");
    return contents
      .trim()
      .split("\n")
      .filter((line) => line.includes(`"traceId":"${traceId}"`))
      .slice(-50);
  } catch {
    return [];
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

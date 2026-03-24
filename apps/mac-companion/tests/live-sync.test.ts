import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  buildConversationDeepLink,
  buildDesktopRefreshScript,
  buildDesktopQuitScript,
  buildDesktopRevealLatestScript,
  buildDesktopReloadScript,
  MacDesktopSyncBridge,
  NoopDesktopSyncBridge,
} from "../src/desktop/live-sync.js";

const execFileAsync = promisify(execFile);

test("buildDesktopRefreshScript scrolls to the latest content after selecting a message-sent chat", () => {
  const script = buildDesktopRefreshScript("Codex", {
    chatId: "chat-1",
    chatTitle: "Remote-Steuerung Codex Mobile App",
    fallbackChatTitle: "Transcribe App",
    projectTitle: "Codex Mobile App",
    reason: "message_sent",
  });

  assert.doesNotMatch(script, /keystroke "r" using command down/);
  assert.doesNotMatch(script, /key code 53/);
  assert.match(script, /key code 125 using command down/);
  assert.match(script, /Remote-Steuerung Codex Mobile App/);
  assert.match(script, /Transcribe App/);
  assert.match(script, /Codex Mobile App/);
  assert.match(script, /selected_chat/);
  assert.match(script, /tell process "Codex"/);
  assert.match(script, /on findSidebarContainer/);
  assert.match(script, /on findSidebarContainerByKnownPath/);
  assert.match(script, /repeat 9 times/);
  assert.match(script, /on findFirstDescendantByRole/);
  assert.match(script, /on findBestSidebarContainer/);
  assert.match(script, /set knownPathSidebar to my findSidebarContainerByKnownPath\(windowRef\)/);
  assert.match(script, /set sidebarContainer to my findSidebarContainer\(window 1\)/);
});

test("buildDesktopRefreshScript avoids scroll keystrokes for plain chat activation", () => {
  const script = buildDesktopRefreshScript("Codex", {
    chatId: "chat-1",
    chatTitle: "Remote-Steuerung Codex Mobile App",
    projectTitle: "Codex Mobile App",
    reason: "chat_activated",
  });

  assert.doesNotMatch(script, /key code 125 using command down/);
});

test("buildDesktopReloadScript requests a window reload through System Events", () => {
  const script = buildDesktopReloadScript("Codex");

  assert.match(script, /tell process "Codex"/);
  assert.match(script, /keystroke "r" using command down/);
  assert.match(script, /return "reloaded"/);
});

test("buildConversationDeepLink targets the local conversation route", () => {
  assert.equal(
    buildConversationDeepLink("019ca136-e162-7232-9b64-2d1217098d4a"),
    "codex://threads/019ca136-e162-7232-9b64-2d1217098d4a",
  );
  assert.equal(
    buildConversationDeepLink("chat with spaces"),
    "codex://threads/chat%20with%20spaces",
  );
});

test("buildDesktopRevealLatestScript scrolls the current Codex chat to the latest content", () => {
  const script = buildDesktopRevealLatestScript("Codex");

  assert.match(script, /tell process "Codex"/);
  assert.match(script, /repeat 6 times/);
  assert.match(script, /key code 125 using command down/);
  assert.match(script, /return "revealed_latest"/);
});

test("buildDesktopQuitScript quits the named app or bundle", () => {
  const byName = buildDesktopQuitScript("Codex");
  const byBundle = buildDesktopQuitScript("Codex", "com.openai.codex");

  assert.match(byName, /tell application "Codex"/);
  assert.match(byName, /if it is running then quit/);
  assert.match(byBundle, /tell application id "com\.openai\.codex"/);
  assert.match(byBundle, /if it is running then quit/);
});

test("buildDesktopRefreshScript compiles on macOS", { skip: process.platform !== "darwin" }, async () => {
  const script = buildDesktopRefreshScript("Codex", {
    chatId: "chat-1",
    chatTitle: "Remote-Steuerung Codex Mobile App",
    projectTitle: "Codex Mobile App",
    reason: "message_sent",
  });
  const tempDir = await mkdtemp(join(tmpdir(), "codex-live-sync-"));
  const scriptPath = join(tempDir, "desktop-refresh.applescript");
  const compiledPath = join(tempDir, "desktop-refresh.scpt");

  try {
    await writeFile(scriptPath, script, "utf8");
    await execFileAsync("osacompile", ["-o", compiledPath, scriptPath]);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("MacDesktopSyncBridge opens the target chat through a Codex deeplink and reveals the latest message", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const bridge = new MacDesktopSyncBridge({
    enabled: true,
    appName: "Codex",
    bundleId: "com.openai.codex",
    reloadDelayMs: 0,
    commandTimeoutMs: 5_000,
  }, {
    platform: "darwin",
    execFileAsyncFn: async (file, args) => {
      calls.push({ file, args });
      if (file === "osascript" && args[1]?.includes("revealed_latest")) {
        return { stdout: "revealed_latest\n" };
      }
      return { stdout: "ok\n" };
    },
  });

  const result = await bridge.syncChat({
    chatId: "chat-1",
    cwd: "/Users/example/CascadeProjects/Codex Mobile App",
    chatTitle: "Remote-Steuerung Codex Mobile App",
    fallbackChatTitle: "Transcribe App",
    projectTitle: "Codex Mobile App",
    reason: "message_sent",
  });

  assert.equal(result.attempted, true);
  assert.equal(result.refreshed, true);
  assert.equal(result.workspaceOpened, false);
  assert.equal(result.selectionStatus, "deeplink_opened_chat");
  assert.equal(calls.length, 3);
  assert.equal(calls[0]!.file, "swift");
  assert.match(calls[0]!.args[0]!, /activate-macos-app\.swift$/);
  assert.equal(calls[1]!.file, "open");
  assert.deepEqual(calls[1]!.args, ["-b", "com.openai.codex", "codex://threads/chat-1"]);
  assert.equal(calls[2]!.file, "osascript");
  assert.match(calls[2]!.args[1]!, /revealed_latest/);
  assert.doesNotMatch(calls.map((call) => call.args.join(" ")).join("\n"), /if it is running then quit/);
  assert.doesNotMatch(calls.map((call) => call.args.join(" ")).join("\n"), /keystroke "r" using command down/);
});

test("MacDesktopSyncBridge opens the app when activation fails, then refreshes it", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const bridge = new MacDesktopSyncBridge({
    enabled: true,
    appName: "Codex",
    appPath: "/Applications/Codex.app",
    reloadDelayMs: 0,
    commandTimeoutMs: 5_000,
  }, {
    platform: "darwin",
    execFileAsyncFn: async (file, args) => {
      calls.push({ file, args });
      if (file === "swift" && calls.length === 1) {
        throw new Error("Codex is not running");
      }
      return { stdout: "" };
    },
  });

  const result = await bridge.syncChat({
    chatId: "chat-1",
    chatTitle: "Remote-Steuerung Codex Mobile App",
    projectTitle: "Codex Mobile App",
    reason: "chat_activated",
  });

  assert.equal(result.attempted, true);
  assert.equal(result.refreshed, true);
  assert.equal(result.workspaceOpened, false);
  assert.equal(calls.length, 4);
  assert.equal(calls[0]!.file, "swift");
  assert.equal(calls[1]!.file, "open");
  assert.deepEqual(calls[1]!.args, ["/Applications/Codex.app"]);
  assert.equal(calls[2]!.file, "swift");
  assert.equal(calls[3]!.file, "open");
  assert.deepEqual(calls[3]!.args, ["codex://threads/chat-1"]);
  assert.equal(result.selectionStatus, "deeplink_opened_chat");
});

test("MacDesktopSyncBridge reports refresh errors without throwing", async () => {
  const bridge = new MacDesktopSyncBridge({
    enabled: true,
    appName: "Codex",
    reloadDelayMs: 0,
    commandTimeoutMs: 5_000,
  }, {
    platform: "darwin",
    execFileAsyncFn: async (file) => {
      if (file === "osascript") {
        throw new Error("not authorized to send Apple events");
      }
      return { stdout: "" };
    },
  });

  const result = await bridge.syncChat({
    chatId: "chat-1",
    chatTitle: "Remote-Steuerung Codex Mobile App",
    projectTitle: "Codex Mobile App",
    reason: "message_sent",
  });

  assert.equal(result.attempted, true);
  assert.equal(result.refreshed, false);
  assert.match(result.errors.join("\n"), /desktop reveal failed/);
});

test("MacDesktopSyncBridge falls back to sidebar selection and reload when the deeplink cannot be opened", async () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  let selectionAttempt = 0;
  const bridge = new MacDesktopSyncBridge({
    enabled: true,
    appName: "Codex",
    reloadDelayMs: 0,
    commandTimeoutMs: 5_000,
  }, {
    platform: "darwin",
    execFileAsyncFn: async (file, args) => {
      calls.push({ file, args });
      if (file === "open" && args.at(-1)?.startsWith("codex://threads/")) {
        throw new Error("LaunchServices could not open the deep link");
      }
      if (file === "osascript" && args[1]?.includes("findSidebarContainer")) {
        selectionAttempt += 1;
        if (selectionAttempt < 3) {
          return { stdout: "focused\n" };
        }
        return { stdout: "selected_chat\n" };
      }
      return { stdout: "ok\n" };
    },
  });

  const result = await bridge.syncChat({
    chatId: "chat-1",
    chatTitle: "codex-remote-debug-xyz",
    projectTitle: "Codex Mobile App",
    reason: "message_sent",
  });

  assert.equal(result.attempted, true);
  assert.equal(result.refreshed, false);
  assert.equal(result.selectionStatus, "focused");
  assert.match(result.errors.join("\n"), /desktop deeplink failed/);
  assert.match(result.errors.join("\n"), /desktop refresh did not reveal the expected chat/);
  assert.ok(calls.some((call) => call.file === "swift"));
  assert.ok(calls.some((call) => call.file === "open" && call.args.at(-1)?.startsWith("codex://threads/")));
  assert.ok(calls.some((call) => call.file === "osascript" && call.args[1]?.includes("keystroke \"r\" using command down")));
  assert.ok(!calls.some((call) => call.args[1]?.includes("if it is running then quit")));
});

test("MacDesktopSyncBridge applies command timeouts so helper hangs turn into logged errors", async () => {
  const calls: Array<{ file: string; timeoutMs: number | undefined; killSignal: NodeJS.Signals | number | undefined }> = [];
  const bridge = new MacDesktopSyncBridge({
    enabled: true,
    appName: "Codex",
    reloadDelayMs: 0,
    commandTimeoutMs: 25,
  }, {
    platform: "darwin",
    execFileAsyncFn: async (file, _args, options) => {
      calls.push({
        file,
        timeoutMs: options?.timeoutMs,
        killSignal: options?.killSignal,
      });
      if (file === "swift") {
        const error = new Error("Command failed: swift activate-macos-app.swift\nCommand timed out after 25 milliseconds\n");
        throw error;
      }
      return { stdout: "" };
    },
  });

  const result = await bridge.syncChat({
    chatId: "chat-1",
    chatTitle: "Remote-Steuerung Codex Mobile App",
    projectTitle: "Codex Mobile App",
    reason: "message_sent",
  });

  assert.equal(result.attempted, true);
  assert.equal(result.refreshed, false);
  assert.match(result.errors.join("\n"), /activate app failed/);
  assert.ok(calls.length >= 3);
  assert.ok(calls.every((call) => call.timeoutMs === 25));
  assert.ok(calls.every((call) => call.killSignal === "SIGKILL"));
});

test("NoopDesktopSyncBridge skips synchronization cleanly", async () => {
  const bridge = new NoopDesktopSyncBridge();
  const result = await bridge.syncChat({
    chatId: "chat-1",
    chatTitle: "Remote-Steuerung Codex Mobile App",
    projectTitle: "Codex Mobile App",
    reason: "message_sent",
  });

  assert.deepEqual(result, {
    attempted: false,
    refreshed: false,
    workspaceOpened: false,
    errors: [],
  });
});

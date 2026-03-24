import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  activateApp,
  buildSidebarCaptureRect,
  buildRevealExpectedTextScript,
  detectDesktopSessionAccess,
  diagnoseFailure,
  ensureOCRHelperExecutable,
  parseArgs,
  readBundleMetadata,
  revealLatestContent,
  resolveAppTarget,
} from "./verify-desktop-visible.mjs";

test("parseArgs reads desktop activation flags", () => {
  const args = parseArgs([
    "--app-name",
    "Codex",
    "--app-path",
    "/Applications/Codex.app",
    "--bundle-id",
    "com.openai.codex",
    "--expected-text",
    "hello",
    "--project-title",
    "Codex Mobile App",
    "--chat-title",
    "Remote-Steuerung Codex Mobile App",
    "--delay-ms",
    "2500",
  ], {});

  assert.equal(args.appName, "Codex");
  assert.equal(args.appPath, "/Applications/Codex.app");
  assert.equal(args.bundleId, "com.openai.codex");
  assert.equal(args.expectedText, "hello");
  assert.equal(args.projectTitle, "Codex Mobile App");
  assert.equal(args.chatTitle, "Remote-Steuerung Codex Mobile App");
  assert.equal(args.delayMs, 2500);
});

test("buildSidebarCaptureRect derives a stable left-sidebar crop", () => {
  const rect = buildSidebarCaptureRect({
    x: 286,
    y: 52,
    width: 1291,
    height: 890,
  });

  assert.deepEqual(rect, {
    x: 286,
    y: 108,
    width: 420,
    height: 834,
  });
});

test("readBundleMetadata reads bundle identifier and executable from Info.plist", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-remote-desktop-metadata-"));
  const appPath = join(root, "Codex.app");
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(appPath, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleIdentifier</key>
    <string>com.openai.codex</string>
    <key>CFBundleExecutable</key>
    <string>CodexBinary</string>
  </dict>
</plist>
`, "utf8");

  const metadata = await readBundleMetadata(appPath);
  assert.equal(metadata.bundleId, "com.openai.codex");
  assert.equal(metadata.executableName, "CodexBinary");
});

test("resolveAppTarget prefers explicit bundle path and executable metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-remote-desktop-target-"));
  const appPath = join(root, "Codex.app");
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(appPath, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleIdentifier</key>
    <string>com.openai.codex</string>
    <key>CFBundleExecutable</key>
    <string>CodexBinary</string>
  </dict>
</plist>
`, "utf8");
  await writeFile(join(appPath, "Contents", "MacOS", "CodexBinary"), "#!/bin/sh\n", "utf8");

  const target = await resolveAppTarget({
    appName: "Codex",
    appPath,
    bundleId: "",
  }, {
    searchRoots: [],
  });

  assert.equal(target.appPath, appPath);
  assert.equal(target.bundleId, "com.openai.codex");
  assert.equal(target.executablePath, join(appPath, "Contents", "MacOS", "CodexBinary"));
  assert.equal(target.resolvedFrom, "env-path");
});

test("resolveAppTarget falls back to Spotlight when the app is outside the default roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-remote-desktop-target-spotlight-"));
  const appPath = join(root, "Custom", "Codex.app");
  await mkdir(join(appPath, "Contents", "MacOS"), { recursive: true });
  await writeFile(join(appPath, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleIdentifier</key>
    <string>com.openai.codex</string>
    <key>CFBundleExecutable</key>
    <string>CodexBinary</string>
  </dict>
</plist>
`, "utf8");

  const target = await resolveAppTarget({
    appName: "Codex",
    appPath: "",
    bundleId: "com.openai.codex",
  }, {
    searchRoots: [],
    execFileAsyncFn: async (command, args) => {
      assert.equal(command, "mdfind");
      assert.match(args[0], /com\.openai\.codex/);
      return { stdout: `${appPath}\n` };
    },
  });

  assert.equal(target.appPath, appPath);
  assert.equal(target.resolvedFrom, "spotlight");
});

test("detectDesktopSessionAccess reports osascript failures as inaccessible", async () => {
  const access = await detectDesktopSessionAccess({
    execFileAsyncFn: async () => {
      throw new Error("execution error: an error of type -10827");
    },
  });

  assert.equal(access.accessible, false);
  assert.equal(access.processCount, null);
  assert.match(access.error, /-10827/);
});

test("diagnoseFailure maps -10827 session errors to missing_display", () => {
  const diagnosis = diagnoseFailure(
    "execution error: An error of type -10827 has occurred. (-10827)",
  );

  assert.equal(diagnosis.code, "missing_display");
  assert.match(diagnosis.summary, /desktop session/i);
});

test("activateApp falls back to the bundle executable when open-by-path fails", async () => {
  const calls = [];
  const spawned = [];

  const result = await activateApp({
    appName: "Codex",
    appPath: "/Applications/Codex.app",
    bundleId: "com.openai.codex",
    executablePath: "/Applications/Codex.app/Contents/MacOS/CodexBinary",
  }, {
    execFileAsyncFn: async (command, args) => {
      calls.push({ command, args });
      if (command === "open" && args[0] === "/Applications/Codex.app") {
        throw new Error("kLSNoExecutableErr");
      }
      return { stdout: "" };
    },
    spawnFn: (command, args, options) => {
      spawned.push({ command, args, options });
      return {
        unref() {},
      };
    },
  });

  assert.equal(result.launched, true);
  assert.equal(result.activated, true);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, "/Applications/Codex.app/Contents/MacOS/CodexBinary");
  assert.deepEqual(spawned[0].args, []);
  assert.equal(spawned[0].options.detached, true);
  assert.equal(calls[0].command, "open");
  assert.equal(calls[1].command, "swift");
  assert.match(result.errors[0], /open path/);
});

test("buildRevealExpectedTextScript scrolls to the latest content after selecting the sidebar chat", () => {
  const script = buildRevealExpectedTextScript(
    "Codex",
    "Codex Mobile App",
    "Remote-Steuerung Codex Mobile App",
  );

  assert.match(script, /Codex Mobile App/);
  assert.match(script, /Remote-Steuerung Codex Mobile App/);
  assert.match(script, /tell process "Codex"/);
  assert.match(script, /selected_chat/);
  assert.match(script, /findSidebarContainer/);
  assert.match(script, /findSidebarContainerByKnownPath/);
  assert.match(script, /repeat 9 times/);
  assert.match(script, /key code 125 using command down/);
});

test("revealLatestContent clicks the expected text and scrolls to the latest content", async () => {
  const calls = [];

  const result = await revealLatestContent("Codex", "Codex Mobile App", "Remote-Steuerung Codex Mobile App", {
    execFileAsyncFn: async (command, args) => {
      calls.push({ command, args });
      return { stdout: "selected_chat\n" };
    },
  });

  assert.deepEqual(result.errors, []);
  assert.equal(result.status, "selected_chat");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "osascript");
  assert.equal(calls[0].args[0], "-e");
  assert.match(calls[0].args[1], /Codex Mobile App/);
  assert.match(calls[0].args[1], /Remote-Steuerung Codex Mobile App/);
  assert.match(calls[0].args[1], /tell process "Codex"/);
  assert.match(calls[0].args[1], /key code 125 using command down/);
});

test("revealLatestContent returns an error message when osascript fails", async () => {
  const result = await revealLatestContent("Codex", "Codex Mobile App", "Remote-Steuerung Codex Mobile App", {
    execFileAsyncFn: async () => {
      throw new Error("not authorized to send Apple events");
    },
  });

  assert.equal(result.status, "");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /reveal latest failed/);
});

test("ensureOCRHelperExecutable rebuilds the cached helper when missing and reuses it afterwards", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-remote-ocr-helper-"));
  const cacheDir = join(root, "cache");
  const scriptPath = join(root, "ocr-screenshot.swift");
  const helperPath = join(cacheDir, "ocr-screenshot");

  await writeFile(scriptPath, "print(\"v1\")\n", "utf8");

  const compileCalls = [];
  const compiledHelperPath = await ensureOCRHelperExecutable(scriptPath, {
    cacheDir,
    execFileAsyncFn: async (command, args) => {
      compileCalls.push({ command, args });
      await mkdir(cacheDir, { recursive: true });
      await writeFile(helperPath, "#!/bin/sh\n", "utf8");
      return { stdout: "" };
    },
  });

  assert.equal(compiledHelperPath, helperPath);
  assert.equal(compileCalls.length, 1);
  assert.equal(compileCalls[0].command, "xcrun");
  assert.deepEqual(compileCalls[0].args.slice(0, 3), ["swiftc", "-O", "-o"]);

  const warmCalls = [];
  const reusedHelperPath = await ensureOCRHelperExecutable(scriptPath, {
    cacheDir,
    execFileAsyncFn: async (command, args) => {
      warmCalls.push({ command, args });
      return { stdout: "" };
    },
  });

  assert.equal(reusedHelperPath, helperPath);
  assert.equal(warmCalls.length, 0);
});

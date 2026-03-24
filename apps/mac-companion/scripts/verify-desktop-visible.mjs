#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function normalizeExpectedText(value) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function escapeAppleScriptString(value) {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

export function diagnoseFailure(message) {
  const normalized = normalizeExpectedText(message);

  if (
    normalized.includes("screen recording")
    || normalized.includes("not authorized to capture screen")
    || normalized.includes("user declined screenshot")
  ) {
    return {
      code: "screen_recording_permission",
      summary: "macOS blocked screen capture for this process.",
      suggestedAction:
        "Allow Screen Recording for the terminal or agent host in System Settings, then rerun the debug loop.",
    };
  }

  if (
    normalized.includes("could not create image from display")
    || normalized.includes("error of type -10827")
    || normalized.includes("(-10827)")
    || normalized.includes("connection invalid")
    || normalized.includes("launchservices returned an error")
    || normalized.includes("can’t get application")
    || normalized.includes("can't get application")
    || normalized.includes("desktop session is not accessible")
  ) {
    return {
      code: "missing_display",
      summary: "This process does not have access to an active macOS desktop session.",
      suggestedAction:
        "Run the debug loop inside a logged-in Mac session with a visible desktop, then retry.",
    };
  }

  if (
    normalized.includes("not authorized to send apple events")
    || normalized.includes("assistive access")
    || normalized.includes("accessibility")
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

export function buildSidebarCaptureRect(bounds) {
  if (!bounds) {
    return null;
  }

  const x = Number(bounds.x ?? 0);
  const y = Number(bounds.y ?? 0);
  const width = Number(bounds.width ?? 0);
  const height = Number(bounds.height ?? 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  if (width <= 0 || height <= 0) {
    return null;
  }

  const topInset = Math.min(56, Math.max(0, Math.round(height * 0.08)));
  const cropWidth = Math.min(420, Math.max(260, Math.round(width * 0.34)));
  const cropHeight = Math.max(200, height - topInset);

  return {
    x: Math.round(x),
    y: Math.round(y + topInset),
    width: Math.round(cropWidth),
    height: Math.round(cropHeight),
  };
}

function inferProcessName(appName) {
  const rawName = basename(appName).replace(/\.app$/i, "");
  return rawName || "Codex";
}

async function ensureParentDir(path) {
  await mkdir(dirname(path), { recursive: true });
}

async function writeJson(path, value) {
  await ensureParentDir(path);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseDelay(rawDelay) {
  const parsed = Number.parseInt(rawDelay ?? "", 10);
  return Number.isFinite(parsed) ? parsed : 1800;
}

export function parseArgs(argv, env = process.env) {
  const options = {
    appName: env.CODEX_MAC_APP_NAME ?? "Codex",
    appPath: env.CODEX_MAC_APP_PATH ?? "",
    bundleId: env.CODEX_MAC_BUNDLE_ID ?? "",
    expectedText: env.DESKTOP_VERIFY_TEXT ?? "",
    projectTitle: env.DESKTOP_VERIFY_PROJECT_TITLE ?? "",
    chatTitle: env.DESKTOP_VERIFY_CHAT_TITLE ?? "",
    delayMs: parseDelay(env.DESKTOP_VERIFY_DELAY_MS),
    reportPath: "",
    screenshotPath: "",
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    switch (arg) {
      case "--app-name":
        options.appName = next ?? options.appName;
        index += 1;
        break;
      case "--app-path":
        options.appPath = next ?? "";
        index += 1;
        break;
      case "--bundle-id":
        options.bundleId = next ?? "";
        index += 1;
        break;
      case "--expected-text":
        options.expectedText = next ?? "";
        index += 1;
        break;
      case "--project-title":
        options.projectTitle = next ?? "";
        index += 1;
        break;
      case "--chat-title":
        options.chatTitle = next ?? "";
        index += 1;
        break;
      case "--delay-ms":
        options.delayMs = parseDelay(next);
        index += 1;
        break;
      case "--report-path":
        options.reportPath = next ?? "";
        index += 1;
        break;
      case "--screenshot-path":
        options.screenshotPath = next ?? "";
        index += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

function extractPlistString(contents, key) {
  const match = contents.match(
    new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, "i"),
  );
  return match?.[1] ?? "";
}

export async function readBundleMetadata(
  appPath,
  { readFileFn = readFile } = {},
) {
  const plistPath = join(appPath, "Contents", "Info.plist");
  const contents = await readFileFn(plistPath, "utf8");
  return {
    bundleId: extractPlistString(contents, "CFBundleIdentifier"),
    executableName: extractPlistString(contents, "CFBundleExecutable"),
  };
}

async function pathExists(path, accessFn) {
  try {
    await accessFn(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveAppTarget(
  options,
  { searchRoots = ["/Applications", join(homedir(), "Applications")], accessFn = access, execFileAsyncFn = execFileAsync } = {},
) {
  let appPath = options.appPath ?? "";
  let resolvedFrom = appPath ? "env-path" : "search";

  if (!appPath) {
    for (const root of searchRoots) {
      const candidate = join(root, `${inferProcessName(options.appName)}.app`);
      if (await pathExists(candidate, accessFn)) {
        appPath = candidate;
        resolvedFrom = "search-root";
        break;
      }
    }
  }

  let bundleId = options.bundleId ?? "";
  let executablePath = "";

  if (!appPath) {
    const spotlightMatch = await discoverAppPathWithSpotlight(options, { execFileAsyncFn });
    if (spotlightMatch) {
      appPath = spotlightMatch;
      resolvedFrom = "spotlight";
    }
  }

  if (appPath) {
    try {
      const metadata = await readBundleMetadata(appPath);
      bundleId ||= metadata.bundleId;
      if (metadata.executableName) {
        executablePath = join(appPath, "Contents", "MacOS", metadata.executableName);
      }
    } catch {
      // Ignore metadata lookup failures. Runtime activation still has fallback paths.
    }
  }

  return {
    appName: options.appName,
    appPath,
    bundleId,
    executablePath,
    resolvedFrom,
  };
}

async function discoverAppPathWithSpotlight(
  options,
  { execFileAsyncFn = execFileAsync } = {},
) {
  const queries = [];
  if (options.bundleId) {
    queries.push(`kMDItemCFBundleIdentifier == "${options.bundleId}"`);
  }
  const processName = inferProcessName(options.appName);
  if (processName) {
    queries.push(`kMDItemFSName == "${processName}.app"`);
  }

  for (const query of queries) {
    try {
      const { stdout } = await execFileAsyncFn("mdfind", [query]);
      const match = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.endsWith(".app"));
      if (match) {
        return match;
      }
    } catch {
      // Ignore Spotlight failures. Other discovery paths still apply.
    }
  }

  return "";
}

export async function detectDesktopSessionAccess(
  { execFileAsyncFn = execFileAsync } = {},
) {
  try {
    const { stdout } = await execFileAsyncFn("osascript", [
      "-e",
      'tell application "System Events" to count (every process)',
    ]);
    const count = Number.parseInt(stdout.trim(), 10);
    return {
      accessible: Number.isFinite(count) && count > 0,
      processCount: Number.isFinite(count) ? count : null,
      error: "",
    };
  } catch (error) {
    return {
      accessible: false,
      processCount: null,
      error: toErrorMessage(error),
    };
  }
}

export async function activateApp(
  target,
  { execFileAsyncFn = execFileAsync, spawnFn = spawn } = {},
) {
  const errors = [];
  let launched = false;
  let activated = false;

  try {
    if (target.appPath) {
      await execFileAsyncFn("open", [target.appPath]);
    } else if (target.bundleId) {
      await execFileAsyncFn("open", ["-b", target.bundleId]);
    } else {
      await execFileAsyncFn("open", ["-a", target.appName]);
    }
    launched = true;
  } catch (error) {
    if (target.appPath) {
      errors.push(`open path failed: ${toErrorMessage(error)}`);
    } else if (target.bundleId) {
      errors.push(`open bundle failed: ${toErrorMessage(error)}`);
    } else {
      errors.push(`open -a failed: ${toErrorMessage(error)}`);
    }

    if (target.executablePath) {
      const child = spawnFn(target.executablePath, [], {
        detached: true,
        stdio: "ignore",
      });
      child.unref?.();
      launched = true;
    }
  }

  try {
    const activateScriptPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "activate-macos-app.swift",
    );
    const args = [activateScriptPath, "--app-name", target.appName];
    if (target.bundleId) {
      args.push("--bundle-id", target.bundleId);
    }
    await execFileAsyncFn("swift", args);
    activated = true;
  } catch (error) {
    errors.push(`swift activate failed: ${toErrorMessage(error)}`);
  }

  return {
    launched: launched || activated,
    activated,
    errors,
  };
}

export function buildRevealExpectedTextScript(
  processName,
  projectTitle,
  chatTitle,
) {
  const escapedProcessName = escapeAppleScriptString(processName);
  const escapedProjectTitle = escapeAppleScriptString(projectTitle);
  const escapedChatTitle = escapeAppleScriptString(chatTitle);
  return `
on textMatches(candidateText, targetText)
  if targetText is "" then
    return false
  end if

  ignoring case
    if candidateText is targetText then
      return true
    end if

    if candidateText contains targetText then
      return true
    end if

    if targetText contains candidateText then
      return true
    end if
  end ignoring

  return false
end textMatches

on candidateTextsForElement(theElement)
  set candidateTexts to {}
  tell application "System Events"
    try
      set end of candidateTexts to (name of theElement as text)
    end try

    try
      set end of candidateTexts to (value of theElement as text)
    end try

    try
      set axTitle to (value of attribute "AXTitle" of theElement) as text
      if axTitle is not "" then
        set end of candidateTexts to axTitle
      end if
    end try

    try
      set axDescription to (value of attribute "AXDescription" of theElement) as text
      if axDescription is not "" then
        set end of candidateTexts to axDescription
      end if
    end try
  end tell

  return candidateTexts
end candidateTextsForElement

on childElementsForElement(theElement)
  tell application "System Events"
    try
      return value of attribute "AXChildren" of theElement
    on error
      return {}
    end try
  end tell
end childElementsForElement

on roleForElement(theElement)
  tell application "System Events"
    try
      return value of attribute "AXRole" of theElement as text
    on error
      return ""
    end try
  end tell
end roleForElement

on firstChildOfElement(theElement)
  set childElements to my childElementsForElement(theElement)
  if (count of childElements) is greater than 0 then
    return item 1 of childElements
  end if
  return missing value
end firstChildOfElement

on childAtIndex(theElement, itemIndex)
  set childElements to my childElementsForElement(theElement)
  if (count of childElements) is greater than or equal to itemIndex then
    return item itemIndex of childElements
  end if
  return missing value
end childAtIndex

on clickElementOrAncestors(theElement)
  tell application "System Events"
    set currentElement to theElement
    repeat 8 times
      try
        perform action "AXPress" of currentElement
        return true
      end try

      try
        click currentElement
        return true
      end try

      try
        set currentElement to value of attribute "AXParent" of currentElement
      on error
        set currentElement to missing value
      end try

      if currentElement is missing value then
        exit repeat
      end if
    end repeat
  end tell

  return false
end clickElementOrAncestors

on positionForElement(theElement)
  tell application "System Events"
    try
      set elementPosition to position of theElement
      if (count of elementPosition) is greater than 1 then
        return {item 1 of elementPosition, item 2 of elementPosition}
      end if
    end try

    try
      set parentElement to value of attribute "AXParent" of theElement
      if parentElement is not missing value then
        set parentPosition to position of parentElement
        if (count of parentPosition) is greater than 1 then
          return {item 1 of parentPosition, item 2 of parentPosition}
        end if
      end if
    end try
  end tell

  return {999999, 999999}
end positionForElement

on sizeForElement(theElement)
  tell application "System Events"
    try
      set elementSize to size of theElement
      if (count of elementSize) is greater than 1 then
        return {item 1 of elementSize, item 2 of elementSize}
      end if
    end try

    try
      set parentElement to value of attribute "AXParent" of theElement
      if parentElement is not missing value then
        set parentSize to size of parentElement
        if (count of parentSize) is greater than 1 then
          return {item 1 of parentSize, item 2 of parentSize}
        end if
      end if
    end try
  end tell

  return {0, 0}
end sizeForElement

on findFirstDescendantByRole(theElement, targetRole, depthRemaining)
  if depthRemaining is less than 0 then
    return missing value
  end if

  if my roleForElement(theElement) is targetRole then
    return theElement
  end if

  if depthRemaining is 0 then
    return missing value
  end if

  set childElements to my childElementsForElement(theElement)
  repeat with childElement in childElements
    set matchedElement to my findFirstDescendantByRole(childElement, targetRole, depthRemaining - 1)
    if matchedElement is not missing value then
      return matchedElement
    end if
  end repeat

  return missing value
end findFirstDescendantByRole

on findBestSidebarContainer(theElement, rootX, rootWidth, depthRemaining)
  if depthRemaining is less than 0 then
    return {missing value, 999999, 0, 0}
  end if

  set bestElement to missing value
  set bestX to 999999
  set bestWidth to 0
  set bestHeight to 0

  set elementRole to my roleForElement(theElement)
  if elementRole is "AXGroup" then
    set elementPosition to my positionForElement(theElement)
    set elementSize to my sizeForElement(theElement)
    set elementX to item 1 of elementPosition
    set elementWidth to item 1 of elementSize
    set elementHeight to item 2 of elementSize
    set sidebarWidthLimit to rootWidth * 0.45
    if sidebarWidthLimit is greater than 420 then
      set sidebarWidthLimit to 420
    end if
    if sidebarWidthLimit is less than 220 then
      set sidebarWidthLimit to 220
    end if

    if elementX is less than or equal to (rootX + 40) and elementWidth is greater than or equal to 220 and elementWidth is less than or equal to sidebarWidthLimit and elementHeight is greater than or equal to 400 then
      set bestElement to theElement
      set bestX to elementX
      set bestWidth to elementWidth
      set bestHeight to elementHeight
    end if
  end if

  if depthRemaining is 0 then
    return {bestElement, bestX, bestWidth, bestHeight}
  end if

  set childElements to my childElementsForElement(theElement)
  repeat with childElement in childElements
    set childResult to my findBestSidebarContainer(childElement, rootX, rootWidth, depthRemaining - 1)
    set candidateElement to item 1 of childResult
    if candidateElement is not missing value then
      set candidateX to item 2 of childResult
      set candidateWidth to item 3 of childResult
      set candidateHeight to item 4 of childResult
      if bestElement is missing value or candidateX is less than bestX or (candidateX is equal to bestX and candidateWidth is less than bestWidth) or (candidateX is equal to bestX and candidateWidth is equal to bestWidth and candidateHeight is greater than bestHeight) then
        set bestElement to candidateElement
        set bestX to candidateX
        set bestWidth to candidateWidth
        set bestHeight to candidateHeight
      end if
    end if
  end repeat

  return {bestElement, bestX, bestWidth, bestHeight}
end findBestSidebarContainer

on findSidebarContainerByKnownPath(windowRef)
  set currentElement to windowRef
  repeat 9 times
    set currentElement to my firstChildOfElement(currentElement)
    if currentElement is missing value then
      return missing value
    end if
  end repeat

  set splitContainer to my childAtIndex(currentElement, 2)
  if splitContainer is missing value then
    return missing value
  end if

  set contentContainer to my childAtIndex(splitContainer, 2)
  if contentContainer is missing value then
    return missing value
  end if

  return my childAtIndex(contentContainer, 1)
end findSidebarContainerByKnownPath

on findSidebarContainer(windowRef)
  set knownPathSidebar to my findSidebarContainerByKnownPath(windowRef)
  if knownPathSidebar is not missing value then
    return knownPathSidebar
  end if

  set webArea to my findFirstDescendantByRole(windowRef, "AXWebArea", 8)
  if webArea is missing value then
    return missing value
  end if

  set webAreaPosition to my positionForElement(webArea)
  set webAreaSize to my sizeForElement(webArea)
  set searchResult to my findBestSidebarContainer(webArea, item 1 of webAreaPosition, item 1 of webAreaSize, 5)
  return item 1 of searchResult
end findSidebarContainer

on findBestSidebarElement(containerRef, targetText, depthRemaining, bestElement, bestX, bestY)
  if targetText is "" then
    return {bestElement, bestX, bestY}
  end if

  set searchElements to {containerRef}
  tell application "System Events"
    try
      set searchElements to searchElements & (entire contents of containerRef)
    end try
  end tell

  repeat with searchElement in searchElements
    set candidateTexts to my candidateTextsForElement(searchElement)
    repeat with candidateText in candidateTexts
      set candidateTextValue to candidateText as text
      if candidateTextValue is not "" and my textMatches(candidateTextValue, targetText) then
        set candidatePosition to my positionForElement(searchElement)
        set candidateX to item 1 of candidatePosition
        set candidateY to item 2 of candidatePosition
        if bestElement is missing value or candidateX is less than bestX or (candidateX is equal to bestX and candidateY is less than bestY) then
          set bestElement to searchElement
          set bestX to candidateX
          set bestY to candidateY
        end if
      end if
    end repeat
  end repeat

  return {bestElement, bestX, bestY}
end findBestSidebarElement

tell application "System Events"
  tell process "${escapedProcessName}"
    set frontmost to true
    if exists window 1 then
      set sidebarContainer to my findSidebarContainer(window 1)
      if sidebarContainer is missing value then
        set sidebarContainer to window 1
      end if
      set projectResult to my findBestSidebarElement(sidebarContainer, "${escapedProjectTitle}", 7, missing value, 999999, 999999)
      set projectElement to item 1 of projectResult
      if projectElement is not missing value then
        if my clickElementOrAncestors(projectElement) then
          delay 0.15
        end if
      end if
      set chatResult to my findBestSidebarElement(sidebarContainer, "${escapedChatTitle}", 5, missing value, 999999, 999999)
      set chatElement to item 1 of chatResult
      if chatElement is not missing value then
        if my clickElementOrAncestors(chatElement) then
          delay 0.15
          repeat 4 times
            key code 125 using command down
            delay 0.15
          end repeat
          return "selected_chat"
        end if
      end if
    end if
  end tell
end tell
return "focused"
`;
}

export async function revealLatestContent(
  processName,
  projectTitle,
  chatTitle,
  { execFileAsyncFn = execFileAsync } = {},
) {
  const script = buildRevealExpectedTextScript(processName, projectTitle, chatTitle);

  try {
    const { stdout } = await execFileAsyncFn("osascript", ["-e", script]);
    return {
      errors: [],
      status: stdout.trim(),
    };
  } catch (error) {
    return {
      errors: [`reveal latest failed: ${toErrorMessage(error)}`],
      status: "",
    };
  }
}

async function readFrontWindowTitle(processName) {
  const script = `
tell application "System Events"
  tell process "${processName.replaceAll("\"", "\\\"")}"
    if exists window 1 then
      return name of window 1
    end if
  end tell
end tell
return ""
`;

  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script]);
    return stdout.trim();
  } catch {
    return "";
  }
}

async function readFrontWindowBounds(processName) {
  const escapedProcessName = processName.replaceAll("\"", "\\\"");
  const script = `
tell application "System Events"
  tell process "${escapedProcessName}"
    if exists window 1 then
      set windowPosition to position of window 1
      set windowSize to size of window 1
      return (item 1 of windowPosition as text) & "," & (item 2 of windowPosition as text) & "," & (item 1 of windowSize as text) & "," & (item 2 of windowSize as text)
    end if
  end tell
end tell
return ""
`;

  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script]);
    const raw = stdout.trim();
    if (!raw) {
      return null;
    }
    const [x, y, width, height] = raw.split(",").map((value) => Number.parseInt(value, 10));
    if (![x, y, width, height].every((value) => Number.isFinite(value))) {
      return null;
    }
    return { x, y, width, height };
  } catch {
    return null;
  }
}

async function captureScreenshot(screenshotPath, cropRect = null) {
  if (process.env.CODEX_VERIFY_MOCK_CAPTURE_ERROR) {
    throw new Error(process.env.CODEX_VERIFY_MOCK_CAPTURE_ERROR);
  }

  if (process.env.CODEX_VERIFY_SKIP_SCREENSHOT === "1") {
    await ensureParentDir(screenshotPath);
    await writeFile(screenshotPath, "", "utf8");
    return { skipped: true };
  }

  await ensureParentDir(screenshotPath);
  const args = ["-x"];
  if (cropRect) {
    args.push("-R", `${cropRect.x},${cropRect.y},${cropRect.width},${cropRect.height}`);
  }
  args.push(screenshotPath);
  await execFileAsync("screencapture", args);
  await access(screenshotPath, fsConstants.F_OK);
  return { skipped: false };
}

export async function ensureOCRHelperExecutable(
  scriptPath,
  {
    cacheDir = join(homedir(), ".codex-remote", "cache"),
    execFileAsyncFn = execFileAsync,
    statFn = stat,
    mkdirFn = mkdir,
  } = {},
) {
  const helperPath = join(cacheDir, "ocr-screenshot");
  const scriptStat = await statFn(scriptPath);
  let helperStat = null;

  try {
    helperStat = await statFn(helperPath);
  } catch {
    helperStat = null;
  }

  if (!helperStat || helperStat.mtimeMs < scriptStat.mtimeMs) {
    await mkdirFn(cacheDir, { recursive: true });
    await execFileAsyncFn("xcrun", [
      "swiftc",
      "-O",
      "-o",
      helperPath,
      scriptPath,
    ], {
      timeout: 30_000,
    });
  }

  return helperPath;
}

async function recognizeScreenshotText(screenshotPath) {
  if (process.env.CODEX_VERIFY_MOCK_OCR_TEXT !== undefined) {
    const lines = process.env.CODEX_VERIFY_MOCK_OCR_TEXT
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return {
      text: process.env.CODEX_VERIFY_MOCK_OCR_TEXT,
      lines,
      mocked: true,
    };
  }

  const scriptPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "ocr-screenshot.swift",
  );
  const helperPath = await ensureOCRHelperExecutable(scriptPath);
  const { stdout } = await execFileAsync(helperPath, [screenshotPath], {
    timeout: 15_000,
  });
  const parsed = JSON.parse(stdout);
  return {
    text: typeof parsed.text === "string" ? parsed.text : "",
    lines: Array.isArray(parsed.lines) ? parsed.lines : [],
    mocked: false,
  };
}

function isMatch(expectedText, ...candidates) {
  const normalizedExpected = normalizeExpectedText(expectedText);
  if (!normalizedExpected) {
    return false;
  }

  return candidates.some((candidate) =>
    normalizeExpectedText(candidate ?? "").includes(normalizedExpected),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.expectedText || !options.reportPath || !options.screenshotPath) {
    throw new Error(
      "Usage: verify-desktop-visible.mjs --expected-text <text> --report-path <path> --screenshot-path <path> [--project-title title] [--chat-title title] [--app-name Codex] [--app-path /Applications/Codex.app] [--bundle-id com.openai.codex] [--delay-ms 1800]",
    );
  }

  const target = await resolveAppTarget(options);
  const processName = inferProcessName(target.appName);
  const report = {
    createdAt: new Date().toISOString(),
    appName: target.appName,
    appPath: target.appPath,
    bundleId: target.bundleId,
    executablePath: target.executablePath,
    resolvedFrom: target.resolvedFrom,
    processName,
    expectedText: options.expectedText,
    delayMs: options.delayMs,
    reportPath: options.reportPath,
    screenshotPath: options.screenshotPath,
    matched: false,
    activationErrors: [],
    revealErrors: [],
    recognizedLines: [],
    recognizedTextPreview: "",
  };

  try {
    if (process.env.CODEX_VERIFY_SKIP_SESSION_PROBE === "1") {
      report.desktopSessionAccessible = true;
      report.desktopProcessCount = null;
      report.desktopSessionError = "";
    } else {
      const desktopSession = await detectDesktopSessionAccess();
      report.desktopSessionAccessible = desktopSession.accessible;
      report.desktopProcessCount = desktopSession.processCount;
      report.desktopSessionError = desktopSession.error;

      if (!desktopSession.accessible) {
        throw new Error(desktopSession.error || "Desktop session is not accessible for UI automation");
      }
    }

    if (process.env.CODEX_VERIFY_SKIP_ACTIVATION !== "1") {
      const activation = await activateApp(target);
      report.activationErrors = activation.errors;
    }

    await sleep(options.delayMs);
    if (process.env.CODEX_VERIFY_ENABLE_REVEAL === "1") {
      const revealResult = await revealLatestContent(
        processName,
        options.projectTitle,
        options.chatTitle,
      );
      report.revealErrors = revealResult.errors;
      report.revealStatus = revealResult.status;
      await sleep(300);
    }
    report.frontWindowTitle = await readFrontWindowTitle(processName);
    report.frontWindowBounds = await readFrontWindowBounds(processName);
    const sidebarCaptureRect = buildSidebarCaptureRect(report.frontWindowBounds);
    report.sidebarCaptureRect = sidebarCaptureRect;

    const captureResult = await captureScreenshot(options.screenshotPath, sidebarCaptureRect);
    report.screenshotSkipped = captureResult.skipped;

    const ocrResult = await recognizeScreenshotText(options.screenshotPath);
    report.ocrText = ocrResult.text;
    report.ocrLines = ocrResult.lines;
    report.ocrMocked = ocrResult.mocked;
    report.recognizedLines = ocrResult.lines;
    report.recognizedTextPreview = ocrResult.text.slice(0, 500);

    const sidebarTargetText = options.chatTitle || options.expectedText;
    const projectVisible = !options.projectTitle || isMatch(
      options.projectTitle,
      report.ocrText,
      ...(report.ocrLines ?? []),
    );
    const chatVisible = isMatch(
      sidebarTargetText,
      report.ocrText,
      ...(report.ocrLines ?? []),
    );

    report.matched = projectVisible && chatVisible;
    report.matchSource = report.matched ? "sidebar_ocr" : "";

    if (!report.matched) {
      report.failure = {
        stage: "match",
        message: `Expected text was not visible in ${target.appName}`,
        diagnosis: diagnoseFailure("Expected text was not visible in the OCR result."),
      };
    }

    await writeJson(options.reportPath, report);
    process.stdout.write(`${JSON.stringify(report)}\n`);

    if (!report.matched) {
      throw new Error(`Expected text was not visible in ${target.appName}`);
    }
  } catch (error) {
    const message = toErrorMessage(error);
    const normalizedMessage = message.toLowerCase();
    const stage = normalizedMessage.includes("ocr")
      ? "ocr"
      : normalizedMessage.includes("desktop session")
        || normalizedMessage.includes("-10827")
        || normalizedMessage.includes("can't get application")
        || normalizedMessage.includes("can’t get application")
        ? "activate"
        : "screenshot";

    if (!report.captureError && message.toLowerCase().includes("screenshot")) {
      report.captureError = message;
    }
    if (
      !report.captureError &&
      (message.includes("screencapture") || message.includes("image from display"))
    ) {
      report.captureError = message;
    }
    if (!report.ocrError && message.toLowerCase().includes("ocr")) {
      report.ocrError = message;
    }
    report.error = message;
    report.failure = {
      stage,
      message,
      diagnosis: diagnoseFailure(message),
    };

    await writeJson(options.reportPath, report);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

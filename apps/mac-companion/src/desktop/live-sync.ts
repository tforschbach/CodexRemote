import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

export interface DesktopSyncRequest {
  chatId: string;
  cwd?: string | undefined;
  chatTitle?: string | undefined;
  fallbackChatTitle?: string | undefined;
  projectTitle?: string | undefined;
  traceId?: string | undefined;
  reason: "chat_activated" | "message_sent";
}

export interface DesktopSyncResult {
  attempted: boolean;
  refreshed: boolean;
  workspaceOpened: boolean;
  selectionStatus?: string | undefined;
  errors: string[];
}

export interface DesktopSyncBridge {
  syncChat(input: DesktopSyncRequest): Promise<DesktopSyncResult>;
}

export interface MacDesktopSyncOptions {
  enabled: boolean;
  appName: string;
  appPath?: string | undefined;
  bundleId?: string | undefined;
  reloadDelayMs: number;
  commandTimeoutMs: number;
}

interface ExecFileLikeResult {
  stdout: string;
  stderr?: string;
}

interface ExecFileLikeOptions {
  timeoutMs?: number;
  killSignal?: NodeJS.Signals | number;
}

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options?: ExecFileLikeOptions,
) => Promise<ExecFileLikeResult>;

interface Dependencies {
  execFileAsyncFn?: ExecFileLike;
  platform?: NodeJS.Platform;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function escapeAppleScriptString(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function expectsChatSelection(input: DesktopSyncRequest): boolean {
  return input.reason === "message_sent" && Boolean(input.chatTitle?.trim());
}

function canOpenChatDeepLink(input: DesktopSyncRequest): boolean {
  return input.chatId.trim().length > 0;
}

function shouldAttemptReload(input: DesktopSyncRequest): boolean {
  return input.reason === "message_sent";
}

function hasFallbackChat(input: DesktopSyncRequest): boolean {
  const fallbackChatTitle = input.fallbackChatTitle?.trim();
  const chatTitle = input.chatTitle?.trim();
  return Boolean(
    fallbackChatTitle
    && chatTitle
    && fallbackChatTitle.toLowerCase() !== chatTitle.toLowerCase(),
  );
}

function selectedChatStatus(status: string): boolean {
  return status === "selected_chat"
    || status === "reload_selected_chat"
    || status === "deeplink_opened_chat";
}

export function buildConversationDeepLink(chatId: string): string {
  return `codex://threads/${encodeURIComponent(chatId.trim())}`;
}

export function buildDesktopRefreshScript(appName: string, input: DesktopSyncRequest): string {
  const escapedAppName = escapeAppleScriptString(appName);
  const escapedChatTitle = escapeAppleScriptString(input.chatTitle ?? "");
  const escapedFallbackChatTitle = escapeAppleScriptString(
    hasFallbackChat(input) ? input.fallbackChatTitle ?? "" : "",
  );
  const escapedProjectTitle = escapeAppleScriptString(input.projectTitle ?? "");
  const scrollToLatestSnippet = input.reason === "message_sent"
    ? `
          repeat 4 times
            key code 125 using command down
            delay 0.15
          end repeat`
    : "";
  const fallbackSwitchSnippet = escapedFallbackChatTitle
    ? `
      set fallbackResult to my findBestSidebarElement(sidebarContainer, "${escapedFallbackChatTitle}", 5, missing value, 999999, 999999)
      set fallbackElement to item 1 of fallbackResult
      if fallbackElement is not missing value then
        set didSelectFallbackChat to my clickElementOrAncestors(fallbackElement)
      else
        set didSelectFallbackChat to false
      end if
      if didSelectFallbackChat then
        delay 0.15
        set chatResult to my findBestSidebarElement(sidebarContainer, "${escapedChatTitle}", 5, missing value, 999999, 999999)
        set chatElement to item 1 of chatResult
        if chatElement is not missing value then
          set didSelectChat to my clickElementOrAncestors(chatElement)
        else
          set didSelectChat to false
        end if
      end if`
    : "";
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

on textListMatchesTarget(candidateTexts, targetText)
  repeat with candidateText in candidateTexts
    set candidateTextValue to candidateText as text
    if candidateTextValue is not "" then
      if my textMatches(candidateTextValue, targetText) then
        return true
      end if
    end if
  end repeat

  return false
end textListMatchesTarget

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
    if my textListMatchesTarget(candidateTexts, targetText) then
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

  return {bestElement, bestX, bestY}
end findBestSidebarElement

tell application "System Events"
  tell process "${escapedAppName}"
    set frontmost to true
    if exists window 1 then
      set sidebarContainer to my findSidebarContainer(window 1)
      if sidebarContainer is missing value then
        set sidebarContainer to window 1
      end if
      set projectResult to my findBestSidebarElement(sidebarContainer, "${escapedProjectTitle}", 7, missing value, 999999, 999999)
      set projectElement to item 1 of projectResult
      if projectElement is not missing value then
        set didSelectProject to my clickElementOrAncestors(projectElement)
      else
        set didSelectProject to false
      end if
      if didSelectProject then
        delay 0.15
      end if
      set chatResult to my findBestSidebarElement(sidebarContainer, "${escapedChatTitle}", 5, missing value, 999999, 999999)
      set chatElement to item 1 of chatResult
      if chatElement is not missing value then
        set didSelectChat to my clickElementOrAncestors(chatElement)
      else
        set didSelectChat to false
      end if
      if didSelectChat then
        delay 0.15
${fallbackSwitchSnippet}
      end if
      if didSelectChat then
        delay 0.15
${scrollToLatestSnippet}
      end if
    else
      set didSelectProject to false
      set didSelectChat to false
    end if
    if didSelectChat then
      return "selected_chat"
    end if
    if didSelectProject then
      return "selected_project"
    end if
    return "focused"
  end tell
end tell
return "refreshed"
`;
}

export function buildDesktopReloadScript(appName: string): string {
  const escapedAppName = escapeAppleScriptString(appName);
  return `
tell application "System Events"
  tell process "${escapedAppName}"
    set frontmost to true
    keystroke "r" using command down
  end tell
end tell
return "reloaded"
`;
}

export function buildDesktopRevealLatestScript(appName: string): string {
  const escapedAppName = escapeAppleScriptString(appName);
  return `
tell application "System Events"
  tell process "${escapedAppName}"
    set frontmost to true
    if exists window 1 then
      repeat 6 times
        key code 125 using command down
        delay 0.15
      end repeat
      return "revealed_latest"
    end if
  end tell
end tell
return "focused"
`;
}

export function buildDesktopQuitScript(appName: string, bundleId?: string): string {
  const escapedAppName = escapeAppleScriptString(appName);
  const escapedBundleId = escapeAppleScriptString(bundleId ?? "");

  if (escapedBundleId) {
    return `
tell application id "${escapedBundleId}"
  if it is running then quit
end tell
return "quit"
`;
  }

  return `
tell application "${escapedAppName}"
  if it is running then quit
end tell
return "quit"
`;
}

export class NoopDesktopSyncBridge implements DesktopSyncBridge {
  public async syncChat(_input: DesktopSyncRequest): Promise<DesktopSyncResult> {
    return {
      attempted: false,
      refreshed: false,
      workspaceOpened: false,
      errors: [],
    };
  }
}

export class MacDesktopSyncBridge implements DesktopSyncBridge {
  private readonly options: MacDesktopSyncOptions;
  private readonly execFileAsyncFn: ExecFileLike;
  private readonly platform: NodeJS.Platform;

  public constructor(options: MacDesktopSyncOptions, dependencies: Dependencies = {}) {
    this.options = options;
    this.execFileAsyncFn = dependencies.execFileAsyncFn
      ?? ((file, args, execOptions) => execFileAsync(file, args, {
        timeout: execOptions?.timeoutMs,
        killSignal: execOptions?.killSignal ?? "SIGKILL",
      }));
    this.platform = dependencies.platform ?? process.platform;
  }

  public async syncChat(input: DesktopSyncRequest): Promise<DesktopSyncResult> {
    if (!this.options.enabled || this.platform !== "darwin") {
      return {
        attempted: false,
        refreshed: false,
        workspaceOpened: false,
        errors: [],
      };
    }

    const errors: string[] = [];
    let activated = false;
    let selectionStatus = "";

    try {
      await this.activateApp();
      activated = true;
    } catch {
      // Fall back to opening the app if it is not already running.
    }

    if (!activated) {
      try {
        await this.openApp();
      } catch (error) {
        errors.push(`open app failed: ${toErrorMessage(error)}`);
      }

      await sleep(this.options.reloadDelayMs);

      try {
        await this.activateApp();
        activated = true;
      } catch (error) {
        errors.push(`activate app failed: ${toErrorMessage(error)}`);
      }
    }

    await sleep(this.options.reloadDelayMs);

    let openedViaDeepLink = false;

    if (canOpenChatDeepLink(input)) {
      try {
        await this.openChatDeepLink(input.chatId);
        openedViaDeepLink = true;
        selectionStatus = "deeplink_opened_chat";
        await sleep(this.reloadSettleDelayMs());
      } catch (error) {
        errors.push(`desktop deeplink failed: ${toErrorMessage(error)}`);
      }
    }

    if (openedViaDeepLink && input.reason === "message_sent") {
      try {
        await this.revealLatestContent();
      } catch (error) {
        errors.push(`desktop reveal failed: ${toErrorMessage(error)}`);
      }
    }

    if (!openedViaDeepLink) {
      try {
        selectionStatus = await this.runSelectionScript(input);
      } catch (error) {
        errors.push(`desktop refresh failed: ${toErrorMessage(error)}`);
      }
    }

    if (!openedViaDeepLink && shouldAttemptReload(input)) {
      const recovered = await this.recoverFromStaleDesktopState(input, selectionStatus);
      if (recovered.selectionStatus) {
        selectionStatus = recovered.selectionStatus;
      }
      errors.push(...recovered.errors);
    }

    if (expectsChatSelection(input) && !selectedChatStatus(selectionStatus)) {
      errors.push(
        `desktop refresh did not reveal the expected chat (status: ${selectionStatus || "unknown"})`,
      );
    }

    return {
      attempted: true,
      refreshed: activated && errors.length === 0,
      workspaceOpened: false,
      selectionStatus: selectionStatus || undefined,
      errors,
    };
  }

  private async openApp(): Promise<void> {
    if (this.options.appPath) {
      await this.runCommand("open", [this.options.appPath]);
      return;
    }

    if (this.options.bundleId) {
      await this.runCommand("open", ["-b", this.options.bundleId]);
      return;
    }

    await this.runCommand("open", ["-a", this.options.appName]);
  }

  private async activateApp(): Promise<void> {
    const scriptPath = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../scripts/activate-macos-app.swift",
    );
    const args = [scriptPath, "--app-name", this.options.appName];
    if (this.options.bundleId) {
      args.push("--bundle-id", this.options.bundleId);
    }
    await this.runCommand("swift", args);
  }

  private async openChatDeepLink(chatId: string): Promise<void> {
    const deeplink = buildConversationDeepLink(chatId);
    if (this.options.bundleId) {
      await this.runCommand("open", ["-b", this.options.bundleId, deeplink]);
      return;
    }

    await this.runCommand("open", [deeplink]);
  }

  private async runSelectionScript(input: DesktopSyncRequest): Promise<string> {
    return await this.runCommand("osascript", [
      "-e",
      buildDesktopRefreshScript(this.options.appName, input),
    ]);
  }

  private async revealLatestContent(): Promise<void> {
    await this.runCommand("osascript", [
      "-e",
      buildDesktopRevealLatestScript(this.options.appName),
    ]);
  }

  private async reloadFrontWindow(): Promise<void> {
    await this.runCommand("osascript", [
      "-e",
      buildDesktopReloadScript(this.options.appName),
    ]);
  }

  private async recoverFromStaleDesktopState(
    input: DesktopSyncRequest,
    initialStatus: string,
  ): Promise<{ selectionStatus: string; errors: string[] }> {
    let selectionStatus = initialStatus;
    const recoveryErrors: string[] = [];

    try {
      await this.reloadFrontWindow();
      await sleep(this.reloadSettleDelayMs());
      const reloadStatus = await this.runSelectionScript(input);
      if (selectedChatStatus(reloadStatus)) {
        selectionStatus = "reload_selected_chat";
      } else if (reloadStatus) {
        selectionStatus = reloadStatus;
      }
    } catch (error) {
      recoveryErrors.push(`desktop reload failed: ${toErrorMessage(error)}`);
    }

    if (
      !expectsChatSelection(input)
      || selectedChatStatus(selectionStatus)
    ) {
      return {
        selectionStatus,
        errors: recoveryErrors,
      };
    }

    return {
      selectionStatus,
      errors: recoveryErrors,
    };
  }

  private reloadSettleDelayMs(): number {
    return Math.max(this.options.reloadDelayMs * 4, 900);
  }

  private async runCommand(file: string, args: readonly string[]): Promise<string> {
    const result = await this.execFileAsyncFn(file, args, {
      timeoutMs: this.options.commandTimeoutMs,
      killSignal: "SIGKILL",
    });
    return result.stdout.trim();
  }
}

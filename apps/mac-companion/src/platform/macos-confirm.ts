import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function escapeAppleScriptString(input: string): string {
  return input.replace(/\\/g, "\\\\").replace(/\"/g, '\\\"');
}

export async function confirmPairingOnMac(input: {
  deviceName: string;
  pairingId: string;
  timeoutSeconds: number;
}): Promise<boolean> {
  const safeDeviceName = escapeAppleScriptString(input.deviceName);
  const safePairingId = escapeAppleScriptString(input.pairingId);

  const script = `display dialog "Allow pairing for device '${safeDeviceName}'?\\nPairing ID: ${safePairingId}" buttons {"Decline", "Allow"} default button "Allow" giving up after ${input.timeoutSeconds}`;

  try {
    const { stdout } = await execFileAsync("osascript", ["-e", script]);
    return stdout.includes("button returned:Allow") && !stdout.includes("gave up:true");
  } catch {
    return false;
  }
}

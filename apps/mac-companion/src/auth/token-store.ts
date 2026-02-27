import { randomBytes, randomUUID } from "node:crypto";

import { readJsonFile, writeJsonFile } from "../utils/fs.js";
import { safeTokenEqual, sha256 } from "../utils/hash.js";

interface DeviceRecord {
  deviceId: string;
  deviceName: string;
  tokenHash: string;
  devicePublicKey?: string;
  createdAt: number;
  lastUsedAt?: number;
}

interface TokenStoreFile {
  devices: DeviceRecord[];
}

export class TokenStore {
  private readonly path: string;
  private devices: DeviceRecord[] = [];

  public constructor(path: string) {
    this.path = path;
  }

  public async load(): Promise<void> {
    const file = await readJsonFile<TokenStoreFile>(this.path, { devices: [] });
    this.devices = file.devices;
  }

  public async save(): Promise<void> {
    await writeJsonFile(this.path, { devices: this.devices } satisfies TokenStoreFile);
  }

  public async issueDeviceToken(input: {
    deviceName: string;
    devicePublicKey?: string;
  }): Promise<{ deviceId: string; token: string }> {
    const token = randomBytes(32).toString("hex");
    const record: DeviceRecord = {
      deviceId: randomUUID(),
      deviceName: input.deviceName,
      tokenHash: sha256(token),
      createdAt: Date.now(),
    };
    if (input.devicePublicKey) {
      record.devicePublicKey = input.devicePublicKey;
    }
    this.devices.push(record);
    await this.save();
    return { deviceId: record.deviceId, token };
  }

  public async validateToken(token: string): Promise<DeviceRecord | null> {
    const hash = sha256(token);
    const match = this.devices.find((device) => safeTokenEqual(device.tokenHash, hash));
    if (!match) {
      return null;
    }
    match.lastUsedAt = Date.now();
    await this.save();
    return match;
  }

  public async revokeDevice(deviceId: string): Promise<boolean> {
    const initialLength = this.devices.length;
    this.devices = this.devices.filter((device) => device.deviceId !== deviceId);
    if (this.devices.length === initialLength) {
      return false;
    }
    await this.save();
    return true;
  }

  public async revokeByToken(token: string): Promise<boolean> {
    const hash = sha256(token);
    const initialLength = this.devices.length;
    this.devices = this.devices.filter((device) => !safeTokenEqual(device.tokenHash, hash));
    if (this.devices.length === initialLength) {
      return false;
    }
    await this.save();
    return true;
  }
}

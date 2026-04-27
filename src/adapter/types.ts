export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export type JsonObject = { [key: string]: JsonValue };

export type JsonArray = JsonValue[];

export type AdapterId = string;

export interface AdapterConfig {
  schemaVersion?: number;
  [key: string]: JsonValue | undefined;
}

export interface IDEAdapter {
  id: AdapterId;
  version: string;
  minCliVersion?: string | null;
  requiresPro: boolean;
  config: AdapterConfig;
  releaseNotes?: string | null;
  downloadUrl?: string | null;
  isActive: boolean;
}

export interface UpdateInfo {
  id: AdapterId;
  currentVersion?: string | null;
  latestVersion?: string | null;
  updateAvailable: boolean;
  canAutoUpdate: boolean;
  requiresPro?: boolean;
  minCliVersion?: string | null;
  releaseNotes?: string | null;
  downloadUrl?: string | null;
}

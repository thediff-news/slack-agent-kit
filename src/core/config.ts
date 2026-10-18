import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import type { PermissionsConfig } from "./permissions.js";

export interface KitConfig {
  store: { driver: "sqlite" | "pi-durable"; path: string };
  auditLogPath: string;
  rag: { dbPath: string; dimensions: number };
  connectors: Record<string, Record<string, string>>;
  permissions: PermissionsConfig;
  approval: { timeoutMinutes: number };
}

export function loadConfig(path: string): KitConfig {
  return yaml.load(readFileSync(path, "utf8")) as KitConfig;
}

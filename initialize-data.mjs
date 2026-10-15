import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createApp } from "./server.mjs";
import { bindData, assertFreshSetupAllowed } from "./data-storage.mjs";

export function defaultDataRoot() {
  return process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "ITD-Studio")
    : join(homedir(), ".local", "share", "ITD-Studio");
}

export async function initializeData(options = {}) {
  const adminEmail = typeof options.adminEmail === "string" ? options.adminEmail.trim().toLowerCase() : "";
  const adminPassword = options.adminPassword;
  if (adminEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail))
    throw Error("Введите корректный email администратора.");
  if (typeof adminPassword !== "string" || adminPassword.length < 12 || adminPassword.length > 256)
    throw Error("Пароль должен содержать от 12 до 256 символов.");
  assertFreshSetupAllowed(options);
  const root = resolve(options.dataRoot || defaultDataRoot());
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // Always a new exclusive directory, never an existing database or a guessed path.
  const dataDir = mkdtempSync(join(root, "data-"));
  const app = createApp({ dataDir, adminEmail, adminPassword });
  await app.close();
  try {
    return await bindData(dataDir, { settingsFile: options.settingsFile, newSetup: true });
  } catch (error) {
    // Keep the new data on failure; do not erase anything to roll back.
    throw Error(`Настройка не завершена. Новые данные сохранены: ${dataDir}. ${error.message}`);
  }
}

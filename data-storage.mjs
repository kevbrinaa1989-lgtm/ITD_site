import { DatabaseSync, backup } from "node:sqlite";
import { existsSync, lstatSync, realpathSync, readFileSync, writeFileSync, mkdirSync,
  mkdtempSync, readdirSync, copyFileSync, constants } from "node:fs";
import { join, dirname, resolve, isAbsolute, relative, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export const defaultSettingsFile = () => join(homedir(), ".itd-studio", "storage.json");
const settingsPath = (options) => options.settingsFile || defaultSettingsFile();
const problem = (message) => new Error(message);
function regular(path, directory = false) {
  if (!existsSync(path)) throw problem(`Не найдено: ${path}. Новая база не создана.`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()))
    throw problem(`Ожидалась обычная ${directory ? "папка" : "запись файла"}: ${path}`);
  return stat;
}

// Read-only inspection: never initializes or repairs an existing database.
export function inspectData(folder) {
  const dataDir = realpathSync(folder);
  regular(join(dataDir, "files"), true);
  regular(join(dataDir, "itd.sqlite"));
  const db = new DatabaseSync(join(dataDir, "itd.sqlite"), { readOnly: true });
  try {
    if (db.prepare("PRAGMA quick_check").all().some((r) => r.quick_check !== "ok") ||
        db.prepare("PRAGMA foreign_key_check").all().length)
      throw problem("Проверка базы не пройдена. Исходные данные не изменены.");
    const columns = {
      users: "id,email,name,role,password", projects: "id,title,clientId,status",
      stages: "id,projectId,title,status,description",
      files: "id,projectId,stageId,name,contentType,category,path,size",
      sessions: "token,userId,expires",
    };
    const counts = {};
    for (const [table, names] of Object.entries(columns)) {
      db.prepare(`SELECT ${names} FROM ${table} LIMIT 0`).all();
      counts[table] = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    }
    for (const file of db.prepare("SELECT path,size FROM files").all()) {
      if (!/^[a-f0-9]{48}$/.test(file.path)) throw problem("Неверный путь документа в базе.");
      if (regular(join(dataDir, "files", file.path)).size !== file.size)
        throw problem(`Размер документа не совпадает: ${file.path}. Данные не изменены.`);
    }
    return { dataDir, counts };
  } finally { db.close(); }
}

export function configuredData(options = {}) {
  const file = settingsPath(options);
  if (!existsSync(file)) throw problem("Папка данных ещё не подключена. Откройте ПОДКЛЮЧИТЬ-ДАННЫЕ.cmd. Новая база не создана.");
  let config;
  try { config = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw problem(`Не удалось прочитать настройки: ${file}. Новая база не создана.`); }
  if (config.version !== 1 || typeof config.dataDir !== "string" || !isAbsolute(config.dataDir))
    throw problem(`Неверные настройки: ${file}. Новая база не создана.`);
  if (!existsSync(config.dataDir)) throw problem(`Папка данных недоступна: ${config.dataDir}. Проверьте диск. Новая база не создана.`);
  if (realpathSync(config.dataDir) !== config.dataDir)
    throw problem("Адрес папки данных изменился. Запуск остановлен.");
  return config.dataDir;
}

// SQLite releases the exclusive coordination lock even after a process crash.
// Older app versions do not use this lock: stop those before connecting/backing up.
export function lockData(dataDir) {
  const file = join(dataDir, ".itd-operation.sqlite");
  if (existsSync(file)) regular(file);
  const lock = new DatabaseSync(file);
  try { lock.exec("CREATE TABLE IF NOT EXISTS guard(id INTEGER); BEGIN EXCLUSIVE"); }
  catch (error) {
    lock.close();
    if (error.errcode === 5) throw problem("Данные уже используются. Остановите приложение (Ctrl+C) и дождитесь завершения копирования.");
    throw error;
  }
  return () => lock.close();
}

export function openConfiguredData(options = {}) {
  const dataDir = configuredData(options);
  // Check existence before opening any writable file.
  if (!inspectData(dataDir).counts.users) throw problem("В подключённой базе нет аккаунтов. Запуск остановлен; новая база не создана.");
  const release = lockData(dataDir);
  try {
    const info = inspectData(dataDir);
    if (!info.counts.users) throw problem("В подключённой базе нет аккаунтов. Запуск остановлен.");
    return { ...info, release };
  }
  catch (error) { release(); throw error; }
}

function treeFiles(folder, prefix = "") {
  regular(folder, true);
  const result = [];
  for (const name of readdirSync(folder).sort()) {
    const path = join(folder, name), stat = lstatSync(path);
    const key = prefix ? `${prefix}/${name}` : name;
    if (stat.isSymbolicLink()) throw problem(`Ссылка вместо документа: ${path}`);
    if (stat.isDirectory()) result.push(...treeFiles(path, key));
    else { regular(path); result.push(key); }
  }
  return result;
}
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function copyDocuments(source, target) {
  mkdirSync(join(target, "files"), { mode: 0o700 });
  for (const name of treeFiles(join(source, "files"))) {
    const dest = join(target, "files", name);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    const original = join(source, "files", name);
    copyFileSync(original, dest, constants.COPYFILE_EXCL);
    if (digest(original) !== digest(dest)) throw problem(`Копия документа не совпадает с исходным файлом: ${name}`);
  }
}

function assertOutside(source, destination) {
  const parent = resolve(destination);
  // Resolve existing ancestors as well, preventing a symlink destination into data.
  let ancestor = parent;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const canonical = resolve(realpathSync(ancestor), relative(ancestor, parent));
  const rel = relative(realpathSync(source), canonical);
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel)))
    throw problem("Выберите папку назначения вне исходной папки.");
}

async function snapshot(dataDir, destination) {
  const before = inspectData(dataDir);
  const parent = resolve(destination || join(dirname(dataDir), "ITD-backups"));
  assertOutside(dataDir, parent);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const target = mkdtempSync(join(parent, `ITD-${new Date().toISOString().replace(/[:.]/g, "-")}-`));
  const db = new DatabaseSync(join(dataDir, "itd.sqlite"), { readOnly: true });
  try { await backup(db, join(target, "itd.sqlite")); }
  finally { db.close(); }
  copyDocuments(dataDir, target);
  const after = inspectData(target);
  if (JSON.stringify(before.counts) !== JSON.stringify(after.counts))
    throw problem(`Копия не завершена: ${target}. Остановите все старые версии приложения и повторите.`);
  const hashes = {};
  for (const name of ["itd.sqlite", ...treeFiles(join(target, "files"), "files")])
    hashes[name] = digest(join(target, name));
  writeFileSync(join(target, "backup.json"), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), counts: after.counts, hashes }, null, 2), { flag: "wx", mode: 0o600, flush: true });
  verifyBackup(target);
  return target;
}

export async function bindData(folder, options = {}) {
  const { dataDir, counts } = inspectData(folder);
  if (!counts.users) throw problem("В выбранной базе нет аккаунтов. Выберите прежнюю папку .itd-data.");
  const configFile = settingsPath(options);
  if (existsSync(configFile)) {
    if (configuredData(options) !== dataDir) throw problem("Уже подключена другая папка. Настройки не изменены.");
    return { dataDir, counts, alreadyConnected: true };
  }
  const release = lockData(dataDir);
  try {
    const backupDir = await snapshot(dataDir, options.backupDestination);
    mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 });
    writeFileSync(configFile, JSON.stringify({ version: 1, dataDir }, null, 2), { flag: "wx", mode: 0o600, flush: true });
    return { dataDir, counts, backupDir };
  } finally { release(); }
}

export async function backupData(options = {}) {
  const store = openConfiguredData(options);
  try { return await snapshot(store.dataDir, options.destination); }
  finally { store.release(); }
}

export function verifyBackup(folder) {
  regular(join(folder, "backup.json"));
  const manifest = JSON.parse(readFileSync(join(folder, "backup.json"), "utf8"));
  const names = ["itd.sqlite", ...treeFiles(join(folder, "files"), "files")].sort();
  if (manifest.version !== 1 || !manifest.hashes ||
      JSON.stringify(Object.keys(manifest.hashes).sort()) !== JSON.stringify(names))
    throw problem("Резервная копия неполная или изменена.");
  for (const name of names) {
    regular(join(folder, name));
    if (digest(join(folder, name)) !== manifest.hashes[name]) throw problem(`Повреждена резервная копия: ${name}`);
  }
  const info = inspectData(folder);
  if (JSON.stringify(info.counts) !== JSON.stringify(manifest.counts)) throw problem("Содержимое копии не совпадает с описанием.");
  return info;
}

export function restoreBackup(folder, destination) {
  verifyBackup(folder);
  assertOutside(folder, destination);
  // No recursive mkdir: destination must be new; never replace existing data.
  mkdirSync(destination, { mode: 0o700 });
  copyFileSync(join(folder, "itd.sqlite"), join(destination, "itd.sqlite"), constants.COPYFILE_EXCL);
  copyDocuments(folder, destination);
  copyFileSync(join(folder, "backup.json"), join(destination, "backup.json"), constants.COPYFILE_EXCL);
  return verifyBackup(destination);
}

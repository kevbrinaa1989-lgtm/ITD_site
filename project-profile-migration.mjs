import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, chmodSync } from "node:fs";
const allowed = new Set([
  "id",
  "title",
  "clientId",
  "status",
  "createdAt",
  "archivedFrom",
  "description",
]);
const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
function verify(db) {
  if (
    db
      .prepare("PRAGMA quick_check")
      .all()
      .some((r) => r.quick_check !== "ok") ||
    db.prepare("PRAGMA foreign_key_check").all().length
  )
    throw Error(
      "Проверка базы перед обновлением не пройдена. Данные не изменены.",
    );
}
export function migrateProjectProfile(db, { dataDir, beforeCommit } = {}) {
  const columns = db.prepare("PRAGMA table_info(projects)").all(),
    names = columns.map((c) => c.name);
  if (
    columns.some((c) => !allowed.has(c.name)) ||
    !["id", "title", "clientId", "status"].every((n) => names.includes(n))
  )
    throw Error(
      "Неизвестная структура проектов. Автоматическое обновление остановлено; данные не изменены.",
    );
  const expectedTypes = {
    id: "INTEGER",
    title: "TEXT",
    clientId: "INTEGER",
    status: "TEXT",
    createdAt: "INTEGER",
    archivedFrom: "TEXT",
    description: "TEXT",
  };
  const links = db.prepare("PRAGMA foreign_key_list(projects)").all();
  if (
    columns.some((c) => c.type.toUpperCase() !== expectedTypes[c.name]) ||
    columns.find((c) => c.name === "id").pk !== 1 ||
    !links.some(
      (f) => f.from === "clientId" && f.table === "users" && f.to === "id",
    )
  )
    throw Error("Неизвестные типы или связи проектов. Данные не изменены.");
  const owner = columns.find((c) => c.name === "clientId"),
    schema = db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type='table' AND name='projects'",
      )
      .get().sql;
  const rebuild = !!owner.notnull;
  if (rebuild && !/\bclientId\s+INTEGER\s+NOT\s+NULL\b/i.test(schema))
    throw Error("Неизвестное ограничение клиента проекта. Данные не изменены.");
  const phone = db
    .prepare("PRAGMA table_info(users)")
    .all()
    .some((c) => c.name === "phone");
  if (!rebuild && phone && names.includes("description"))
    return { migrated: false, snapshotPath: null };
  if (
    db
      .prepare("SELECT name FROM sqlite_schema WHERE name='projects__nullable'")
      .get()
  )
    throw Error(
      "Обнаружена неизвестная временная таблица. Данные не изменены.",
    );
  verify(db);
  const objects = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE tbl_name='projects' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name",
    )
    .all();
  let snapshotPath = null;
  if (
    db.prepare("SELECT count(*) AS n FROM users").get().n ||
    db.prepare("SELECT count(*) AS n FROM projects").get().n
  ) {
    const folder = join(dataDir, "migration-snapshots");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const snapshotDir = mkdtempSync(join(folder, "snapshot-"));
    chmodSync(snapshotDir, 0o700);
    snapshotPath = join(snapshotDir, "itd.sqlite");
    db.prepare("VACUUM INTO ?").run(snapshotPath);
    chmodSync(snapshotPath, 0o600);
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      verify(snapshot);
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all();
      for (const { name } of tables) {
        const original = db.prepare(`SELECT * FROM ${quote(name)}`).all(),
          copy = snapshot.prepare(`SELECT * FROM ${quote(name)}`).all();
        if (JSON.stringify(original) !== JSON.stringify(copy))
          throw Error(
            "Проверочная копия отличается от исходной базы. Обновление остановлено.",
          );
      }
    } finally {
      snapshot.close();
    }
  }
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    if (rebuild) {
      const create = schema
        .replace(
          /^CREATE\s+TABLE\s+(?:"projects"|`projects`|\[projects\]|projects)/i,
          'CREATE TABLE "projects__nullable"',
        )
        .replace(/(\bclientId\s+INTEGER\s+)NOT\s+NULL\b/i, "$1");
      if (
        create === schema ||
        !create.startsWith('CREATE TABLE "projects__nullable"')
      )
        throw Error("Не удалось безопасно подготовить структуру проектов.");
      db.exec(create);
      const list = names.map(quote).join(",");
      db.exec(
        `INSERT INTO projects__nullable(${list}) SELECT ${list} FROM projects`,
      );
      if (
        db
          .prepare(
            `SELECT ${list} FROM projects EXCEPT SELECT ${list} FROM projects__nullable`,
          )
          .all().length ||
        db
          .prepare(
            `SELECT ${list} FROM projects__nullable EXCEPT SELECT ${list} FROM projects`,
          )
          .all().length ||
        db.prepare("SELECT count(*) AS n FROM projects").get().n !==
          db.prepare("SELECT count(*) AS n FROM projects__nullable").get().n
      )
        throw Error("Проверка переноса проектов не пройдена.");
      db.exec(
        "DROP TABLE projects; ALTER TABLE projects__nullable RENAME TO projects",
      );
      for (const object of objects) db.exec(object.sql);
    }
    if (!names.includes("description"))
      db.exec("ALTER TABLE projects ADD COLUMN description TEXT");
    if (!phone) db.exec("ALTER TABLE users ADD COLUMN phone TEXT");
    beforeCommit?.();
    verify(db);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
  return { migrated: true, snapshotPath };
}

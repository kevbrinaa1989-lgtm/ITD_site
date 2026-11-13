import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, chmodSync } from "node:fs";
import { join } from "node:path";

const quote = (value) => '"' + value.replaceAll('"', '""') + '"';
export function auditFileOwnership(db) {
  const issues = [];
  for (const row of db
    .prepare(
      `SELECT f.id,f.projectId,f.stageId FROM files f
    LEFT JOIN projects p ON p.id=f.projectId LEFT JOIN stages s ON s.id=f.stageId
    WHERE p.id IS NULL OR (f.stageId IS NOT NULL AND (s.id IS NULL OR s.projectId<>f.projectId))`,
    )
    .all())
    issues.push({ kind: "file_scope", ...row });
  for (const row of db
    .prepare(
      `SELECT m.id,m.projectId,m.stageId FROM review_materials m
    LEFT JOIN projects p ON p.id=m.projectId LEFT JOIN stages s ON s.id=m.stageId
    WHERE p.id IS NULL OR (m.stageId IS NOT NULL AND (s.id IS NULL OR s.projectId<>m.projectId))`,
    )
    .all())
    issues.push({ kind: "material_scope", ...row });
  for (const row of db
    .prepare(
      `SELECT v.id,v.fileId,v.materialId FROM review_versions v
    LEFT JOIN files f ON f.id=v.fileId LEFT JOIN review_materials m ON m.id=v.materialId
    WHERE f.id IS NULL OR m.id IS NULL OR f.projectId<>m.projectId OR f.stageId IS NOT m.stageId`,
    )
    .all())
    issues.push({ kind: "version_scope", ...row });
  for (const row of db
    .prepare(
      `SELECT e.id,e.projectId,e.stageId,e.materialId,e.versionId FROM review_events e
    LEFT JOIN stages s ON s.id=e.stageId LEFT JOIN review_materials m ON m.id=e.materialId
    LEFT JOIN review_versions v ON v.id=e.versionId
    WHERE m.id IS NULL OR v.id IS NULL OR e.projectId<>m.projectId OR v.materialId<>m.id
      OR (e.stageId IS NOT NULL AND (s.id IS NULL OR s.projectId<>e.projectId))`,
    )
    .all())
    issues.push({ kind: "history_scope", ...row });
  return issues;
}
function verify(db) {
  if (
    db
      .prepare("PRAGMA quick_check")
      .all()
      .some((r) => r.quick_check !== "ok") ||
    db.prepare("PRAGMA foreign_key_check").all().length
  )
    throw Error(
      "Проверка базы не пройдена. Обновление принадлежности файлов остановлено.",
    );
}
export function migrateFileOwnership(db, { dataDir, beforeCommit } = {}) {
  const issues = auditFileOwnership(db);
  if (issues.length)
    throw Object.assign(
      new Error(
        "Найдены неоднозначные связи файлов. Нужна ручная проверка отчёта; файлы не распределены автоматически.",
      ),
      { ownershipIssues: issues },
    );
  const rebuild = ["review_materials", "review_events"].filter(
    (table) =>
      db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .find((c) => c.name === "stageId")?.notnull,
  );
  const installed = db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type='trigger' AND name='review_event_scope_insert'",
    )
    .get();
  if (!rebuild.length && installed)
    return { migrated: false, snapshotPath: null };
  verify(db);
  let snapshotPath = null;
  if (
    db.prepare("SELECT count(*) AS n FROM files").get().n ||
    db.prepare("SELECT count(*) AS n FROM projects").get().n
  ) {
    const folder = join(dataDir, "migration-snapshots");
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(folder, "file-ownership-"));
    chmodSync(dir, 0o700);
    snapshotPath = join(dir, "itd.sqlite");
    db.prepare("VACUUM INTO ?").run(snapshotPath);
    chmodSync(snapshotPath, 0o600);
    const copy = new DatabaseSync(snapshotPath, { readOnly: true });
    try {
      verify(copy);
      for (const { name } of db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all()) {
        if (
          JSON.stringify(db.prepare(`SELECT * FROM ${quote(name)}`).all()) !==
          JSON.stringify(copy.prepare(`SELECT * FROM ${quote(name)}`).all())
        )
          throw Error(
            "Резервный снимок не совпадает с базой. Обновление остановлено.",
          );
      }
    } finally {
      copy.close();
    }
  }
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const table of rebuild) {
      const schema = db
        .prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?")
        .get(table).sql;
      const temp = table + "__ownership";
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(temp))
        throw Error("Неизвестная временная таблица. Обновление остановлено.");
      const sql = schema
        .replace(
          new RegExp(`^CREATE\\s+TABLE\\s+(?:"${table}"|${table})`, "i"),
          `CREATE TABLE ${temp}`,
        )
        .replace(/(\bstageId\s+INTEGER\s+)NOT\s+NULL\b/i, "$1");
      if (
        !sql.startsWith(`CREATE TABLE ${temp}`) ||
        /\bstageId\s+INTEGER\s+NOT\s+NULL\b/i.test(sql)
      )
        throw Error("Неизвестная структура истории согласования.");
      const objects = db
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL",
        )
        .all(table);
      db.exec(sql);
      db.exec(`INSERT INTO ${temp} SELECT * FROM ${table}`);
      if (
        JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()) !==
        JSON.stringify(db.prepare(`SELECT * FROM ${temp}`).all())
      )
        throw Error("Проверка сохранения истории не пройдена.");
      db.exec(`DROP TABLE ${table}; ALTER TABLE ${temp} RENAME TO ${table}`);
      for (const { sql } of objects) db.exec(sql);
    }
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS file_scope_insert BEFORE INSERT ON files
      WHEN NEW.stageId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM stages WHERE id=NEW.stageId AND projectId=NEW.projectId)
      BEGIN SELECT RAISE(ABORT,'File stage must belong to project'); END;
      CREATE TRIGGER IF NOT EXISTS file_scope_update BEFORE UPDATE OF projectId,stageId ON files
      WHEN NEW.projectId<>OLD.projectId OR (NEW.stageId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM stages WHERE id=NEW.stageId AND projectId=NEW.projectId))
        OR EXISTS(SELECT 1 FROM review_versions v JOIN review_materials m ON m.id=v.materialId WHERE v.fileId=OLD.id AND (m.projectId<>NEW.projectId OR m.stageId IS NOT NEW.stageId))
      BEGIN SELECT RAISE(ABORT,'File ownership must remain consistent'); END;
      CREATE TRIGGER IF NOT EXISTS stage_project_immutable BEFORE UPDATE OF projectId ON stages WHEN NEW.projectId<>OLD.projectId
      BEGIN SELECT RAISE(ABORT,'Stage project is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS material_scope_insert BEFORE INSERT ON review_materials
      WHEN NEW.stageId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM stages WHERE id=NEW.stageId AND projectId=NEW.projectId)
      BEGIN SELECT RAISE(ABORT,'Material stage must belong to project'); END;
      CREATE TRIGGER IF NOT EXISTS material_scope_update BEFORE UPDATE OF projectId,stageId ON review_materials
      WHEN NEW.projectId<>OLD.projectId OR (NEW.stageId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM stages WHERE id=NEW.stageId AND projectId=NEW.projectId))
      BEGIN SELECT RAISE(ABORT,'Material ownership must remain consistent'); END;
      CREATE TRIGGER IF NOT EXISTS material_scope_cascade AFTER UPDATE OF stageId ON review_materials
      BEGIN UPDATE files SET stageId=NEW.stageId WHERE id IN(SELECT fileId FROM review_versions WHERE materialId=NEW.id); END;
      CREATE TRIGGER IF NOT EXISTS version_scope_insert BEFORE INSERT ON review_versions
      WHEN NOT EXISTS(SELECT 1 FROM files f JOIN review_materials m ON m.id=NEW.materialId WHERE f.id=NEW.fileId AND f.projectId=m.projectId AND f.stageId IS m.stageId)
      BEGIN SELECT RAISE(ABORT,'Version must belong to material scope'); END;
      CREATE TRIGGER IF NOT EXISTS version_scope_update BEFORE UPDATE OF fileId,materialId ON review_versions
      WHEN NEW.fileId<>OLD.fileId OR NEW.materialId<>OLD.materialId
      BEGIN SELECT RAISE(ABORT,'Version links are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS review_event_scope_insert BEFORE INSERT ON review_events
      WHEN NOT EXISTS(SELECT 1 FROM review_materials m JOIN review_versions v ON v.materialId=m.id
        WHERE m.id=NEW.materialId AND v.id=NEW.versionId AND m.projectId=NEW.projectId AND m.stageId IS NEW.stageId)
      BEGIN SELECT RAISE(ABORT,'Review event must belong to current material scope'); END;
    `);
    beforeCommit?.();
    verify(db);
    if (auditFileOwnership(db).length)
      throw Error("Проверка принадлежности файлов не пройдена.");
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
  return { migrated: true, snapshotPath };
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  migrateFileOwnership,
  auditFileOwnership,
} from "./file-ownership-migration.mjs";
function legacy(t) {
  const dir = mkdtempSync(join(tmpdir(), "itd-scope-migration-")),
    db = new DatabaseSync(join(dir, "itd.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1);
 CREATE TABLE projects(id INTEGER PRIMARY KEY); INSERT INTO projects VALUES(1),(2);
 CREATE TABLE stages(id INTEGER PRIMARY KEY,projectId INTEGER NOT NULL REFERENCES projects(id)); INSERT INTO stages VALUES(1,1),(2,2);
 CREATE TABLE files(id INTEGER PRIMARY KEY,projectId INTEGER NOT NULL REFERENCES projects(id),stageId INTEGER REFERENCES stages(id),name TEXT); INSERT INTO files VALUES(1,1,1,'original.pdf');
 CREATE TABLE review_materials(id INTEGER PRIMARY KEY,projectId INTEGER NOT NULL REFERENCES projects(id),stageId INTEGER NOT NULL REFERENCES stages(id),title TEXT NOT NULL,createdAt INTEGER NOT NULL); INSERT INTO review_materials VALUES(1,1,1,'План',123);
 CREATE TABLE review_versions(id INTEGER PRIMARY KEY,materialId INTEGER NOT NULL REFERENCES review_materials(id),fileId INTEGER NOT NULL REFERENCES files(id),status TEXT); INSERT INTO review_versions VALUES(1,1,1,'approved');
 CREATE TABLE review_events(id INTEGER PRIMARY KEY,projectId INTEGER NOT NULL REFERENCES projects(id),stageId INTEGER NOT NULL REFERENCES stages(id),materialId INTEGER REFERENCES review_materials(id),versionId INTEGER REFERENCES review_versions(id),body TEXT); INSERT INTO review_events VALUES(1,1,1,1,1,'Согласовано');
 CREATE TABLE review_notifications(id INTEGER PRIMARY KEY,eventId INTEGER REFERENCES review_events(id));INSERT INTO review_notifications VALUES(1,1);
 CREATE TRIGGER review_events_no_update BEFORE UPDATE ON review_events BEGIN SELECT RAISE(ABORT,'immutable'); END;
 CREATE INDEX review_materials_project ON review_materials(projectId,stageId);`);
  return { dir, db };
}
const dump = (db) =>
  Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
      )
      .all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name}`).all()]),
  );
test("ownership migration snapshots and preserves every legacy record, index, foreign key and immutable history", (t) => {
  const { dir, db } = legacy(t),
    before = dump(db);
  const result = migrateFileOwnership(db, { dataDir: dir });
  assert.equal(result.migrated, true);
  assert.ok(result.snapshotPath);
  const copy = new DatabaseSync(result.snapshotPath, { readOnly: true });
  try {
    assert.deepEqual(dump(copy), before);
    assert.equal(
      copy
        .prepare("PRAGMA table_info(review_materials)")
        .all()
        .find((c) => c.name === "stageId").notnull,
      1,
    );
  } finally {
    copy.close();
  }
  assert.deepEqual(dump(db), before);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(() => db.exec("UPDATE review_events SET body='overwritten'"));
  db.exec("UPDATE review_materials SET stageId=NULL WHERE id=1");
  assert.equal(db.prepare("SELECT stageId FROM files").get().stageId, null);
  assert.throws(() => db.exec("UPDATE files SET stageId=1 WHERE id=1"));
  assert.throws(() =>
    db.exec("UPDATE review_materials SET stageId=2 WHERE id=1"),
  );
  assert.deepEqual(auditFileOwnership(db), []);
  assert.equal(migrateFileOwnership(db, { dataDir: dir }).migrated, false);
});
test("ambiguous legacy links stop migration without assigning files or changing schema", (t) => {
  const { dir, db } = legacy(t);
  db.exec("UPDATE files SET stageId=2 WHERE id=1");
  const before = dump(db),
    schema = db.prepare("SELECT * FROM sqlite_schema").all();
  assert.ok(auditFileOwnership(db).length);
  assert.throws(
    () => migrateFileOwnership(db, { dataDir: dir }),
    (e) => e.ownershipIssues?.length > 0,
  );
  assert.deepEqual(dump(db), before);
  assert.deepEqual(db.prepare("SELECT * FROM sqlite_schema").all(), schema);
});
test("failed ownership migration rolls back schema and rows and restores FK enforcement", (t) => {
  const { dir, db } = legacy(t),
    before = dump(db),
    schema = db.prepare("SELECT * FROM sqlite_schema").all();
  assert.throws(
    () =>
      migrateFileOwnership(db, {
        dataDir: dir,
        beforeCommit: () => {
          throw Error("simulated failure");
        },
      }),
    /simulated failure/,
  );
  assert.deepEqual(dump(db), before);
  assert.deepEqual(db.prepare("SELECT * FROM sqlite_schema").all(), schema);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
});

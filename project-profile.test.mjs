import { fixtures } from "./tests/preview-fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { backupData, restoreBackup, bindData } from "./data-storage.mjs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "./server.mjs";
import { migrateProjectProfile } from "./project-profile-migration.mjs";
import { STAGE_TEMPLATES } from "./admin-management.mjs";
const password = "Temporary-test-password-123";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "itd-null-profile-")),
    dataDir = join(root, "data");
  let app, base;
  async function start(dir = dataDir) {
    app = createApp({
      dataDir: dir,
      adminEmail: "admin@example.test",
      adminPassword: password,
    });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    base = "http://127.0.0.1:" + app.server.address().port;
  }
  async function stop() {
    await app.close();
  }
  async function req(path, body, cookie, expected = 200, method = "POST") {
    const r = await fetch(base + path, {
      method,
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        "X-ITD-Request": "1",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const value = await r.json();
    assert.equal(r.status, expected, `${path}: ${JSON.stringify(value)}`);
    return { value, cookie: r.headers.get("set-cookie")?.split(";")[0] };
  }
  await start();
  t.after(async () => {
    await stop();
    await rm(root, { recursive: true, force: true });
  });
  const admin = (
    await req("/api/login", { email: "admin@example.test", password })
  ).cookie;
  const a = await req(
      "/api/register",
      { name: "Client A", email: "a@example.test", password },
      null,
      201,
    ),
    b = await req(
      "/api/register",
      { name: "Client B", email: "b@example.test", password },
      null,
      201,
    );
  return { root, dataDir, start, stop, req, admin, a, b };
}
test("unassigned projects create exactly selected ordered stages and remain private until explicit assignment", async (t) => {
  const f = await fixture(t),
    { value: list } = await f.req(
      "/api/clients",
      undefined,
      f.admin,
      200,
      "GET",
    );
  assert.equal(list.stageTemplates.length, 7);
  assert.deepEqual(
    list.stageTemplates.map((t) => t.title),
    STAGE_TEMPLATES.map((t) => t.title),
  );
  const { value: p } = await f.req(
    "/api/projects",
    {
      title: "Unassigned",
      description: "Real description",
      stageTemplates: ["supervision", "planning", "technical_description"],
    },
    f.admin,
    201,
  );
  const get = () =>
    f.req(`/api/admin/projects/${p.id}`, undefined, f.admin, 200, "GET");
  let detail = (await get()).value.project;
  assert.equal(detail.clientId, null);
  assert.equal(detail.clientName, null);
  assert.equal(detail.description, "Real description");
  assert.deepEqual(
    detail.stages.map((s) => s.title),
    [
      "Планировочное решение",
      "Техническое описание дизайн-проекта",
      "Авторский надзор",
    ],
  );
  assert.ok(detail.stages.every((s) => s.status === "planned"));
  const empty = (
    await f.req(
      "/api/projects",
      { title: "No stages", clientId: null },
      f.admin,
      201,
    )
  ).value;
  assert.equal(
    (
      await f.req(
        `/api/admin/projects/${empty.id}`,
        undefined,
        f.admin,
        200,
        "GET",
      )
    ).value.project.progress,
    null,
  );
  for (const stageTemplates of [["unknown"], ["planning", "planning"]])
    await f.req(
      "/api/projects",
      { title: "Bad", stageTemplates },
      f.admin,
      400,
    );
  for (const c of [f.a, f.b]) {
    assert.deepEqual(
      (await f.req("/api/projects", undefined, c.cookie, 200, "GET")).value
        .projects,
      [],
    );
    await f.req(
      `/api/projects/${p.id}/materials`,
      undefined,
      c.cookie,
      403,
      "GET",
    );
  }
  const intent = (
    await f.req(`/api/projects/${p.id}/upload-intents`, {}, f.admin, 201)
  ).value;
  const bytes = fixtures.find((row) => row[1] === "application/pdf")[2];
  const upload = {
    name: "plan.pdf",
    contentType: "application/pdf",
    data: bytes.toString("base64"),
    category: "result",
    stageId: detail.stages[0].id,
    review: true,
    uploadIntent: intent.uploadIntent,
  };
  const file = (
    await f.req(`/api/projects/${p.id}/files`, upload, f.admin, 201)
  ).value;
  assert.ok(file.review);
  const dashboard = (
    await f.req("/api/admin/workspace", undefined, f.admin, 200, "GET")
  ).value;
  assert.equal(
    dashboard.waiting.some((v) => v.projectId === p.id),
    false,
  );
  await f.req(
    `/api/files/${file.id}/download`,
    undefined,
    f.a.cookie,
    403,
    "GET",
  );
  await f.req(
    `/api/admin/projects/${p.id}/assign`,
    { clientId: f.a.value.user.id, expectedClientId: null, confirm: true },
    f.admin,
  );
  await f.req(`/api/projects/${p.id}/files`, upload, f.admin, 409);
  await f.req(
    `/api/admin/projects/${p.id}/assign`,
    { clientId: f.b.value.user.id, expectedClientId: null, confirm: true },
    f.admin,
    409,
  );
  const own = (await f.req("/api/projects", undefined, f.a.cookie, 200, "GET"))
    .value.projects;
  assert.ok(own.some((x) => x.id === p.id));
  assert.equal(
    (await f.req("/api/projects", undefined, f.b.cookie, 200, "GET")).value
      .projects.length,
    0,
  );
  const catalog = (
    await f.req(
      "/api/admin/projects?status=all&search=Unassigned",
      undefined,
      f.admin,
      200,
      "GET",
    )
  ).value.projects;
  assert.equal(catalog.length, 1);
});
test("client and administrator edit only permitted profile fields and retain them after restart", async (t) => {
  const f = await fixture(t),
    uid = f.a.value.user.id;
  const result = (
    await f.req(
      "/api/me/profile",
      { name: "Updated Name", phone: "+7 (900) 123-45-67" },
      f.a.cookie,
      200,
      "PATCH",
    )
  ).value.user;
  assert.equal(result.name, "Updated Name");
  assert.equal(result.phone, "+7 (900) 123-45-67");
  assert.equal(result.email, "a@example.test");
  for (const fields of [
    { email: "bad@example.test" },
    { role: "admin" },
    { isActive: false },
    { userId: f.b.value.user.id },
    { id: f.b.value.user.id },
    { name: "", phone: null },
    { phone: "secret<script>" },
  ])
    await f.req("/api/me/profile", fields, f.a.cookie, 400, "PATCH");
  await f.req("/api/me/profile", { name: "No" }, undefined, 401, "PATCH");
  await f.req("/api/me/profile", { name: "No" }, f.admin, 403, "PATCH");
  await f.req(
    `/api/admin/clients/${uid}`,
    { name: "Admin edit", phone: "8 900 100 20 30" },
    f.admin,
    200,
    "PATCH",
  );
  const before = (
    await f.req(`/api/admin/clients/${uid}`, undefined, f.admin, 200, "GET")
  ).value;
  assert.equal(before.client.phone, "8 900 100 20 30");
  assert.ok(before.events.some((e) => e.type === "client.phone_updated"));
  await f.req(
    `/api/admin/clients/${uid}`,
    { phone: null, isActive: false, confirm: true },
    f.admin,
    400,
    "PATCH",
  );
  await f.stop();
  await f.start();
  const after = (await f.req("/api/me", undefined, f.a.cookie, 200, "GET"))
    .value.user;
  assert.equal(after.name, "Admin edit");
  assert.equal(after.phone, "8 900 100 20 30");
});
function oldSchema(db) {
  db.exec(
    `PRAGMA foreign_keys=ON;CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,password TEXT NOT NULL);CREATE TABLE projects(id INTEGER PRIMARY KEY,title TEXT NOT NULL,clientId INTEGER NOT NULL REFERENCES users(id),status TEXT NOT NULL DEFAULT 'В работе',createdAt INTEGER,archivedFrom TEXT);CREATE TABLE stages(id INTEGER PRIMARY KEY,projectId INTEGER NOT NULL REFERENCES projects(id),title TEXT NOT NULL,status TEXT NOT NULL,description TEXT NOT NULL);CREATE TABLE sessions(token TEXT PRIMARY KEY,userId INTEGER REFERENCES users(id),expires INTEGER);CREATE INDEX project_title_index ON projects(title);CREATE TABLE migration_audit(id INTEGER PRIMARY KEY,projectId INTEGER);CREATE TRIGGER project_audit AFTER UPDATE OF title ON projects BEGIN INSERT INTO migration_audit(projectId) VALUES(new.id);END;INSERT INTO users VALUES(1,'a@example.test','Existing','client','originalhash');INSERT INTO projects VALUES(8,'Existing project',1,'В работе',123,NULL);INSERT INTO stages VALUES(12,8,'Рабочая документация','in_progress','Old retained');INSERT INTO sessions VALUES('oldsession',1,9999999999999);`,
  );
}
test("nullable migration snapshots and preserves old rows IDs foreign keys indexes triggers and is idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "itd-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, "itd.sqlite"));
  t.after(() => db.close());
  oldSchema(db);
  const oldRows = db.prepare("SELECT * FROM projects").all(),
    oldStages = db.prepare("SELECT * FROM stages").all(),
    oldSession = db.prepare("SELECT * FROM sessions").all();
  const result = migrateProjectProfile(db, { dataDir: root });
  assert.ok(result.snapshotPath);
  const snapshot = new DatabaseSync(result.snapshotPath, { readOnly: true });
  assert.deepEqual(snapshot.prepare("SELECT * FROM projects").all(), oldRows);
  snapshot.close();
  assert.equal(
    db
      .prepare("PRAGMA table_info(projects)")
      .all()
      .find((c) => c.name === "clientId").notnull,
    0,
  );
  assert.deepEqual(
    db
      .prepare(
        "SELECT id,title,clientId,status,createdAt,archivedFrom FROM projects",
      )
      .all(),
    oldRows,
  );
  assert.deepEqual(db.prepare("SELECT * FROM stages").all(), oldStages);
  assert.deepEqual(db.prepare("SELECT * FROM sessions").all(), oldSession);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.prepare("UPDATE projects SET title='Changed' WHERE id=8").run();
  assert.equal(
    db.prepare("SELECT projectId FROM migration_audit").get().projectId,
    8,
  );
  assert.ok(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name='project_title_index'",
      )
      .get(),
  );
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(migrateProjectProfile(db, { dataDir: root }).migrated, false);
  db.prepare(
    "INSERT INTO projects(title,clientId,status) VALUES('Unassigned',NULL,'Новый')",
  ).run();
});
test("migration failure rolls back schema rows and foreign-key mode, while unknown schemas abort without changes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "itd-migration-fail-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const db = new DatabaseSync(join(root, "itd.sqlite"));
  t.after(() => db.close());
  oldSchema(db);
  const before = db
    .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name")
    .all();
  assert.throws(
    () =>
      migrateProjectProfile(db, {
        dataDir: root,
        beforeCommit: () => {
          throw Error("Injected failure");
        },
      }),
    /Injected failure/,
  );
  assert.deepEqual(
    db
      .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name")
      .all(),
    before,
  );
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(
    db.prepare("SELECT clientId FROM projects WHERE id=8").get().clientId,
    1,
  );
  db.exec("ALTER TABLE projects ADD COLUMN unknown TEXT");
  const changed = db
    .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name")
    .all();
  assert.throws(
    () => migrateProjectProfile(db, { dataDir: root }),
    /Неизвестная структура/,
  );
  assert.deepEqual(
    db
      .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name")
      .all(),
    changed,
  );
});

test("full legacy migration retains every child table and original bytes through restart and verified backup restore", async (t) => {
  const f = await fixture(t);
  const p = (
    await f.req(
      "/api/projects",
      {
        title: "Legacy full",
        clientId: f.a.value.user.id,
        stageTemplates: ["planning"],
      },
      f.admin,
      201,
    )
  ).value;
  const stage = (
    await f.req(`/api/admin/projects/${p.id}`, undefined, f.admin, 200, "GET")
  ).value.project.stages[0];
  const ticket = (
    await f.req(`/api/projects/${p.id}/upload-intents`, {}, f.admin, 201)
  ).value;
  const file = (
    await f.req(
      `/api/projects/${p.id}/files`,
      {
        name: "old.pdf",
        contentType: "application/pdf",
        data: fixtures
          .find((row) => row[1] === "application/pdf")[2]
          .toString("base64"),
        category: "result",
        stageId: stage.id,
        review: true,
        uploadIntent: ticket.uploadIntent,
      },
      f.admin,
      201,
    )
  ).value;
  await f.req(
    `/api/material-versions/${file.review.versionId}/comments`,
    { text: "Legacy comment" },
    f.a.cookie,
  );
  const adminUser = (await f.req("/api/me", undefined, f.admin, 200, "GET"))
    .value.user;
  await f.req(
    "/api/admin/tasks",
    {
      title: "Retained task",
      projectId: p.id,
      stageId: stage.id,
      assigneeId: adminUser.id,
    },
    f.admin,
    201,
  );
  await f.req(
    "/api/password-recovery/requests",
    { email: "a@example.test" },
    null,
    202,
  );
  await f.stop();
  let db = new DatabaseSync(join(f.dataDir, "itd.sqlite"));
  db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
  const sql = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type='table' AND name='projects'",
    )
    .get().sql;
  db.exec(
    sql
      .replace(
        /^CREATE TABLE (?:"projects"|projects)/,
        "CREATE TABLE projects_legacy",
      )
      .replace(
        /clientId INTEGER REFERENCES/,
        "clientId INTEGER NOT NULL REFERENCES",
      ),
  );
  const columns = db
    .prepare("PRAGMA table_info(projects)")
    .all()
    .map((c) => '"' + c.name + '"')
    .join(",");
  db.exec(
    `INSERT INTO projects_legacy(${columns}) SELECT ${columns} FROM projects; DROP TABLE projects; ALTER TABLE projects_legacy RENAME TO projects; ALTER TABLE projects DROP COLUMN description; ALTER TABLE users DROP COLUMN phone; COMMIT; PRAGMA foreign_keys=ON`,
  );
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all();
  const original = new Map(
    tables.map(({ name }) => [
      name,
      {
        columns: db
          .prepare(`PRAGMA table_info("${name}")`)
          .all()
          .map((c) => c.name),
        rows: db.prepare(`SELECT * FROM "${name}"`).all(),
      },
    ]),
  );
  const stored = db
    .prepare("SELECT path FROM files WHERE id=?")
    .get(file.id).path;
  db.close();
  const bytes = await readFile(join(f.dataDir, "files", stored));
  await f.start();
  db = new DatabaseSync(join(f.dataDir, "itd.sqlite"));
  for (const [name, info] of original)
    assert.deepEqual(
      db
        .prepare(
          `SELECT ${info.columns.map((c) => '"' + c + '"').join(",")} FROM "${name}"`,
        )
        .all(),
      info.rows,
      name,
    );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
  assert.deepEqual(await readFile(join(f.dataDir, "files", stored)), bytes);
  await f.stop();
  const settingsFile = join(f.root, "settings.json");
  await bindData(f.dataDir, { settingsFile });
  const backup = await backupData({
    settingsFile,
    destination: join(f.root, "backups"),
  });
  const backupFolder =
    typeof backup === "string"
      ? backup
      : backup.backupDir || backup.folder || backup.path;
  const restored = join(f.root, "restored");
  restoreBackup(backupFolder, restored);
  await f.start(restored);
  await f.req("/api/me", undefined, f.admin, 401, "GET");
  f.admin = (
    await f.req("/api/login", { email: "admin@example.test", password })
  ).cookie;
  const detail = (
    await f.req(`/api/admin/projects/${p.id}`, undefined, f.admin, 200, "GET")
  ).value.project;
  assert.equal(detail.clientId, f.a.value.user.id);
  assert.equal(detail.stages[0].title, "Планировочное решение");
  assert.equal(detail.files[0].id, file.id);
  assert.deepEqual(await readFile(join(restored, "files", stored)), bytes);
});

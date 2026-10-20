import { prepareFixtureUpload } from "./tests/upload-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "./server.mjs";
import {
  bindData,
  backupData,
  restoreBackup,
  verifyBackup,
} from "./data-storage.mjs";
const PUBLIC = "/api/password-recovery/requests",
  ADMIN = "/api/admin/password-recovery/requests",
  RESET = "/api/password-recovery/reset";
const generic = {
  message: "Если такой аккаунт существует, запрос отправлен администратору.",
};
const secret = () => randomBytes(24).toString("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "itd-recovery-test-")),
    dataDir = join(root, "data");
  const password = secret();
  let now = Date.now(),
    app,
    base;
  async function start(options = {}) {
    app = createApp({
      dataDir,
      adminEmail: "admin@example.test",
      adminPassword: password,
      recoveryNow: () => now,
      ...options,
    });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function request(
    path,
    { method = "GET", cookie, body, csrf = true, origin, headers = {} } = {},
  ) {
    body = await prepareFixtureUpload(base, path, body, cookie, method, {
      csrf,
      origin,
      headers,
    });

    return fetch(base + path, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method === "GET"
          ? {}
          : {
              Origin: origin ?? base,
              "Content-Type": "application/json",
              ...(csrf ? { "X-ITD-Request": "1" } : {}),
            }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function json(path, options, status = 200) {
    const response = await request(path, options),
      data = await response.json();
    assert.equal(
      response.status,
      status,
      `${options?.method || "GET"} ${path}`,
    );
    return data;
  }
  async function login(email, attempt = password, status = 200) {
    const response = await request("/api/login", {
      method: "POST",
      body: { email, password: attempt },
    });
    assert.equal(response.status, status);
    await response.json();
    return response.headers.get("set-cookie")?.split(";")[0];
  }
  await start();
  const admin = await login("admin@example.test");
  const clients = [];
  for (const email of ["client@example.test", "other@example.test"]) {
    const { user } = await json(
      "/api/register",
      { method: "POST", body: { name: email, email, password } },
      201,
    );
    clients.push({ ...user, cookie: await login(email) });
  }
  async function submit(email = clients[0].email, { advance = true } = {}) {
    if (advance) now += 15 * 60 * 1000 + 1;
    assert.deepEqual(
      await json(PUBLIC, { method: "POST", body: { email } }, 202),
      generic,
    );
    const { requests } = await json(ADMIN, { cookie: admin });
    return requests.find((r) => r.email === email.trim().toLowerCase());
  }
  async function approve(id, extra = {}) {
    const result = await json(`${ADMIN}/${id}/approve`, {
      method: "POST",
      cookie: admin,
      body: {},
      ...extra,
    });
    assert.match(result.resetPath, /^\/reset-password\/#[a-f0-9]{64}$/);
    return { ...result, token: result.resetPath.split("#")[1] };
  }
  async function reset(
    token,
    newPassword = secret(),
    extra = {},
    status = 200,
  ) {
    return json(
      RESET,
      {
        method: "POST",
        body: {
          token,
          password: newPassword,
          passwordConfirm: newPassword,
          ...extra,
        },
      },
      status,
    );
  }
  return {
    root,
    dataDir,
    password,
    admin,
    clients,
    request,
    json,
    login,
    submit,
    approve,
    reset,
    advance: (ms) => {
      now += ms;
    },
    now: () => now,
    async restart() {
      await app.close();
      app = null;
      await start();
    },
    async stop() {
      await app?.close();
      app = null;
    },
    async startAt(folder) {
      await start({ dataDir: folder });
    },
    async close() {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function diskContains(folder, value) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const p = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (await diskContains(p, value)) return true;
    } else if ((await readFile(p)).includes(Buffer.from(value))) return true;
  }
  return false;
}

test("recovery requests are indistinguishable publicly and restricted to administrators", async () => {
  const f = await fixture();
  try {
    const known = await f.submit(" CLIENT@example.test "),
      unknown = await f.submit("missing@example.test"),
      adminRequest = await f.submit("admin@example.test");
    assert.equal(known.userId, f.clients[0].id);
    assert.equal(known.status, "new");
    assert.equal(known.processedByName, null);
    assert.equal(known.expiresAt, null);
    assert.ok(Number.isFinite(Date.parse(known.createdAt)));
    assert.equal(unknown.userId, null);
    assert.equal(unknown.clientName, null);
    assert.equal(adminRequest.userId, null);
    for (const request of [unknown, adminRequest])
      await f.json(
        `${ADMIN}/${request.id}/approve`,
        { method: "POST", cookie: f.admin, body: {} },
        400,
      );
    for (const cookie of [undefined, f.clients[0].cookie]) {
      const status = cookie ? 403 : 401;
      for (const path of [ADMIN, `${ADMIN}/${known.id}`])
        await f.json(path, { cookie }, status);
      for (const action of ["approve", "reject", "copied"])
        await f.json(
          `${ADMIN}/${known.id}/${action}`,
          { cookie, method: "POST", body: {} },
          status,
        );
    }
    await f.json(
      PUBLIC,
      { method: "POST", body: { email: "not an email" } },
      400,
    );
    for (const path of [
      PUBLIC,
      RESET,
      `${ADMIN}/${known.id}/approve`,
      `${ADMIN}/${known.id}/reject`,
      `${ADMIN}/${known.id}/copied`,
    ]) {
      await f.json(
        path,
        {
          method: "POST",
          cookie: f.admin,
          body: { email: "client@example.test" },
          csrf: false,
        },
        403,
      );
      await f.json(
        path,
        {
          method: "POST",
          cookie: f.admin,
          body: {},
          origin: "https://evil.example",
        },
        403,
      );
    }
    await f.json(`${ADMIN}/999999`, { cookie: f.admin }, 404);
    await f.json(
      "/api/register",
      {
        method: "POST",
        body: {
          name: "Late client",
          email: "missing@example.test",
          password: secret(),
        },
      },
      201,
    );
    await f.json(
      `${ADMIN}/${unknown.id}/approve`,
      { method: "POST", cookie: f.admin, body: {} },
      400,
    );
  } finally {
    await f.close();
  }
});

test("approval rotates links, anonymous repeats cannot revoke them, and reset revokes every client session", async (t) => {
  const f = await fixture();
  try {
    const owner = f.clients[0],
      first = await f.submit(),
      duplicate = await f.submit(owner.email, { advance: false });
    assert.equal(duplicate.id, first.id);
    const oldSession2 = await f.login(owner.email);
    await f.json(
      `${ADMIN}/${first.id}/approve`,
      {
        method: "POST",
        cookie: f.admin,
        body: {},
        headers: {
          Host: "poisoned.example",
          Origin: "http://poisoned.example",
        },
      },
      403,
    );
    const logs = [];
    for (const stream of [process.stdout, process.stderr])
      t.mock.method(stream, "write", (chunk, encoding, callback) => {
        logs.push(String(chunk));
        const done = typeof encoding === "function" ? encoding : callback;
        done?.();
        return true;
      });
    for (const name of ["log", "info", "warn", "error"])
      t.mock.method(console, name, (...args) =>
        logs.push(args.map(String).join(" ")),
      );
    const approved = await f.approve(first.id);
    assert.equal(approved.request.status, "approved");
    assert.equal(
      Date.parse(approved.request.expiresAt) -
        Date.parse(approved.request.processedAt),
      20 * 60 * 1000,
    );
    assert.ok(approved.request.processedByName);
    const repeated = await f.submit(owner.email, { advance: false });
    assert.equal(repeated.id, first.id);
    assert.equal(repeated.expiresAt, approved.request.expiresAt);
    await f.json(`${ADMIN}/${first.id}/copied`, {
      cookie: f.admin,
      method: "POST",
      body: {},
    });
    const rotated = await f.approve(first.id);
    assert.notEqual(rotated.token, approved.token);
    await f.reset(approved.token, secret(), {}, 400);
    const detail = await f.json(`${ADMIN}/${first.id}`, { cookie: f.admin });
    for (const type of ["requested", "viewed", "approved", "copied"])
      assert.ok(detail.events.some((e) => e.type === type));
    assert.ok(
      detail.events.every((e) => Number.isFinite(Date.parse(e.createdAt))),
    );
    assert.ok(
      detail.events
        .filter((e) => e.type === "approved")
        .every((e) => e.actorName),
    );
    for (const token of [approved.token, rotated.token]) {
      assert.equal(JSON.stringify(detail).includes(token), false);
      assert.equal(await diskContains(f.dataDir, token), false);
    }
    const db = new DatabaseSync(join(f.dataDir, "itd.sqlite"), {
      readOnly: true,
    });
    try {
      const row = db
        .prepare("SELECT tokenHash FROM password_recovery_requests WHERE id=?")
        .get(first.id);
      assert.equal(
        row.tokenHash,
        createHash("sha256").update(rotated.token).digest("hex"),
      );
    } finally {
      db.close();
    }
    for (const [password, passwordConfirm] of [
      ["short", "short"],
      ["x".repeat(257), "x".repeat(257)],
      [secret(), secret()],
    ])
      await f.reset(rotated.token, password, { passwordConfirm }, 400);
    await f.reset(rotated.token, secret(), { email: f.clients[1].email }, 400);
    await f.reset(rotated.token, secret(), { userId: f.clients[1].id }, 400);
    const newPassword = secret();
    const response = await f.request(RESET, {
      method: "POST",
      body: {
        token: rotated.token,
        password: newPassword,
        passwordConfirm: newPassword,
      },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(response.headers.get("set-cookie"), null);
    for (const cookie of [owner.cookie, oldSession2])
      await f.json("/api/me", { cookie }, 401);
    await f.login(owner.email, f.password, 401);
    await f.login(owner.email, newPassword);
    await f.json("/api/me", { cookie: f.clients[1].cookie });
    await f.json("/api/me", { cookie: f.admin });
    const used = await f.json(`${ADMIN}/${first.id}`, { cookie: f.admin });
    assert.equal(used.request.status, "used");
    assert.ok(used.events.some((e) => e.type === "used"));
    await f.reset(rotated.token, secret(), {}, 400);
    await f.json(
      `${ADMIN}/${first.id}/approve`,
      { cookie: f.admin, method: "POST", body: {} },
      409,
    );
    const next = await f.submit();
    assert.notEqual(next.id, first.id);
    assert.equal(next.status, "new");
    assert.equal(await diskContains(f.dataDir, newPassword), false);
    t.mock.restoreAll();
    for (const value of [
      approved.token,
      rotated.token,
      newPassword,
      f.password,
    ])
      assert.equal(
        logs.join("\n").includes(value),
        false,
        "Server logs must not expose tokens or passwords",
      );
  } finally {
    t.mock.restoreAll();
    await f.close();
  }
});

test("reject and expiry invalidate links, and new requests remain possible", async () => {
  const f = await fixture();
  try {
    const first = await f.submit(),
      approved = await f.approve(first.id);
    await f.json(`${ADMIN}/${first.id}/reject`, {
      cookie: f.admin,
      method: "POST",
      body: {},
    });
    await f.reset(approved.token, secret(), {}, 400);
    const rejected = await f.json(`${ADMIN}/${first.id}`, { cookie: f.admin });
    assert.equal(rejected.request.status, "rejected");
    assert.ok(rejected.events.some((e) => e.type === "rejected"));
    await f.json(
      `${ADMIN}/${first.id}/copied`,
      { cookie: f.admin, method: "POST", body: {} },
      409,
    );
    const second = await f.submit(),
      expiring = await f.approve(second.id);
    assert.notEqual(second.id, first.id);
    f.advance(20 * 60 * 1000);
    await f.reset(expiring.token, secret(), {}, 400);
    const expired = await f.json(`${ADMIN}/${second.id}`, { cookie: f.admin });
    assert.equal(expired.request.status, "expired");
    assert.ok(expired.events.some((e) => e.type === "expired"));
    await f.json(
      `${ADMIN}/${second.id}/approve`,
      { cookie: f.admin, method: "POST", body: {} },
      409,
    );
    const third = await f.submit();
    assert.notEqual(third.id, second.id);
    assert.equal(third.status, "new");
  } finally {
    await f.close();
  }
});

test("request/reset throttles persist across restart and store hashed addresses only", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++)
      assert.deepEqual(
        await f.json(
          PUBLIC,
          { method: "POST", body: { email: "client@example.test" } },
          202,
        ),
        generic,
      );
    await f.json(
      PUBLIC,
      { method: "POST", body: { email: "missing@example.test" } },
      429,
    );
    await f.restart();
    await f.json(
      PUBLIC,
      { method: "POST", body: { email: "client@example.test" } },
      429,
    );
    f.advance(15 * 60 * 1000 + 1);
    await f.json(
      PUBLIC,
      { method: "POST", body: { email: "client@example.test" } },
      202,
    );
    for (let i = 0; i < 20; i++)
      await f.reset(randomBytes(32).toString("hex"), secret(), {}, 400);
    await f.reset(randomBytes(32).toString("hex"), secret(), {}, 429);
    await f.restart();
    await f.reset(randomBytes(32).toString("hex"), secret(), {}, 429);
    f.advance(15 * 60 * 1000 + 1);
    await f.reset(randomBytes(32).toString("hex"), secret(), {}, 400);
    const db = new DatabaseSync(join(f.dataDir, "itd.sqlite"), {
      readOnly: true,
    });
    try {
      for (const row of db
        .prepare("SELECT key FROM password_recovery_limits")
        .all()) {
        assert.match(row.key, /^(request|reset):[a-f0-9]{64}$/);
        assert.equal(row.key.includes("127.0.0.1"), false);
      }
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

test("approved links and recovery history survive restart plus full backup and restore without affecting project data", async () => {
  const f = await fixture();
  try {
    const project = await f.json(
      "/api/projects",
      {
        cookie: f.admin,
        method: "POST",
        body: { title: "Existing private project", clientId: f.clients[0].id },
      },
      201,
    );
    const document = Buffer.from("Previously signed contract");
    const file = await f.json(
      `/api/projects/${project.id}/files`,
      {
        cookie: f.admin,
        method: "POST",
        body: {
          name: "contract.txt",
          contentType: "text/plain",
          category: "document",
          data: document.toString("base64"),
        },
      },
      201,
    );
    const recovery = await f.submit(),
      approved = await f.approve(recovery.id);
    await f.restart();
    const detail = await f.json(`${ADMIN}/${recovery.id}`, { cookie: f.admin });
    assert.equal(detail.request.status, "approved");
    assert.equal(detail.request.expiresAt, approved.request.expiresAt);
    await f.stop();
    const settingsFile = join(f.root, "storage.json");
    await bindData(f.dataDir, {
      settingsFile,
      backupDestination: join(f.root, "backups"),
    });
    const saved = await backupData({
      settingsFile,
      destination: join(f.root, "backups"),
    });
    verifyBackup(saved);
    const restored = join(f.root, "restored");
    restoreBackup(saved, restored);
    await f.startAt(restored);
    const restoredDetail = await f.json(`${ADMIN}/${recovery.id}`, {
      cookie: f.admin,
    });
    assert.equal(restoredDetail.request.status, "approved");
    assert.ok(restoredDetail.events.some((e) => e.type === "approved"));
    const newPassword = secret();
    await f.reset(approved.token, newPassword);
    const cookie = await f.login(f.clients[0].email, newPassword);
    const { projects } = await f.json("/api/projects", { cookie });
    assert.equal(projects[0].id, project.id);
    assert.equal(projects[0].title, "Existing private project");
    const response = await f.request(`/api/files/${file.id}/download`, {
      cookie,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), document);
  } finally {
    await f.close();
  }
});

test("legacy five-table stores migrate additively without changing existing rows or documents", async () => {
  const f = await fixture();
  try {
    const project = await f.json(
      "/api/projects",
      {
        cookie: f.admin,
        method: "POST",
        body: { title: "Legacy client project", clientId: f.clients[0].id },
      },
      201,
    );
    const stage = await f.json(
      `/api/projects/${project.id}/stages`,
      {
        cookie: f.admin,
        method: "POST",
        body: {
          title: "Legacy completed design",
          status: "completed",
          description: "Keep original",
        },
      },
      201,
    );
    const original = Buffer.from("Legacy document contents");
    await f.json(
      `/api/projects/${project.id}/files`,
      {
        cookie: f.admin,
        method: "POST",
        body: {
          name: "legacy.txt",
          contentType: "text/plain",
          category: "document",
          stageId: stage.id,
          data: original.toString("base64"),
        },
      },
      201,
    );
    await f.stop();
    const tables = ["users", "projects", "stages", "files", "sessions"];
    const originalColumns = {
      users: "id,email,name,role,password",
      projects: "id,title,clientId,status",
      stages: "id,projectId,title,status,description",
      files: "id,projectId,stageId,name,contentType,category,path,size",
      sessions: "token,userId,expires",
    };
    let before;
    // Only this disposable fixture removes additions to reproduce the exact original schema.
    const legacy = new DatabaseSync(join(f.dataDir, "itd.sqlite"));
    try {
      legacy.exec(
        `DROP TABLE admin_tasks; ALTER TABLE stages DROP COLUMN startDate; ALTER TABLE stages DROP COLUMN plannedEndDate;
         DROP TABLE review_views; DROP TABLE review_notifications; DROP TABLE review_events;
         DROP TABLE review_versions; DROP TABLE review_materials;
         DROP TABLE password_recovery_events; DROP TABLE password_recovery_requests; DROP TABLE password_recovery_limits;
         DROP TABLE admin_management_events;
         ALTER TABLE users DROP COLUMN createdAt; ALTER TABLE users DROP COLUMN isActive;
         ALTER TABLE projects DROP COLUMN createdAt; ALTER TABLE projects DROP COLUMN archivedFrom;`,
      );
      assert.deepEqual(
        legacy
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all()
          .map((row) => row.name),
        [...tables].sort(),
      );
      before = Object.fromEntries(
        tables.map((table) => [
          table,
          legacy
            .prepare(
              `SELECT ${originalColumns[table]} FROM ${table} ORDER BY ${table === "sessions" ? "token" : "id"}`,
            )
            .all(),
        ]),
      );
    } finally {
      legacy.close();
    }
    const docs = await readdir(join(f.dataDir, "files"));
    const documentBefore = await Promise.all(
      docs.map((name) => readFile(join(f.dataDir, "files", name))),
    );
    const settingsFile = join(f.root, "legacy-settings.json");
    const bound = await bindData(f.dataDir, {
      settingsFile,
      backupDestination: join(f.root, "legacy-backups"),
    });
    verifyBackup(bound.backupDir);
    const app = createApp({ storageOptions: { settingsFile } });
    await app.close();
    const migrated = new DatabaseSync(join(f.dataDir, "itd.sqlite"), {
      readOnly: true,
    });
    try {
      for (const table of tables)
        assert.deepEqual(
          migrated
            .prepare(
              `SELECT ${originalColumns[table]} FROM ${table} ORDER BY ${table === "sessions" ? "token" : "id"}`,
            )
            .all(),
          before[table],
        );
      for (const table of [
        "password_recovery_requests",
        "password_recovery_events",
        "password_recovery_limits",
        "admin_management_events",
        "review_materials",
        "review_versions",
        "review_events",
        "review_notifications",
        "review_views",
        "admin_tasks",
      ])
        assert.equal(
          migrated.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
          0,
        );
      assert.ok(
        migrated
          .prepare("SELECT createdAt,isActive FROM users")
          .all()
          .every((row) => row.createdAt === null && row.isActive === 1),
      );
      assert.ok(
        migrated
          .prepare("SELECT createdAt,archivedFrom FROM projects")
          .all()
          .every((row) => row.createdAt === null && row.archivedFrom === null),
      );
    } finally {
      migrated.close();
    }
    assert.deepEqual(await readdir(join(f.dataDir, "files")), docs);
    assert.deepEqual(
      await Promise.all(
        docs.map((name) => readFile(join(f.dataDir, "files", name))),
      ),
      documentBefore,
    );
    // A backup made before the migration remains valid and can be opened by the new application.
    const restored = join(f.root, "restored-legacy");
    restoreBackup(bound.backupDir, restored);
    await f.startAt(restored);
    const cookie = await f.login(f.clients[0].email);
    const { projects } = await f.json("/api/projects", { cookie });
    assert.equal(projects[0].title, "Legacy client project");
    assert.equal(projects[0].stages[0].title, "Legacy completed design");
  } finally {
    await f.close();
  }
});

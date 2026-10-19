import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "./server.mjs";
import {
  bindData,
  backupData,
  restoreBackup,
  verifyBackup,
} from "./data-storage.mjs";
import { fixtures } from "./tests/preview-fixtures.mjs";
const AC = "/api/admin/clients",
  AP = "/api/admin/projects",
  REC = "/api/admin/password-recovery/requests";
const password = () => randomBytes(24).toString("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "itd-admin-test-")),
    dataDir = join(root, "data"),
    secret = password();
  let app, base;
  async function start(folder = dataDir) {
    app = createApp({
      dataDir: folder,
      adminEmail: "admin@example.test",
      adminPassword: secret,
    });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function request(
    path,
    { method = "GET", body, cookie, csrf = true, origin } = {},
  ) {
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
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function json(path, options, status = 200) {
    const r = await request(path, options),
      data = await r.json();
    assert.equal(r.status, status, `${options?.method || "GET"} ${path}`);
    return data;
  }
  async function login(email, expected = 200) {
    const r = await request("/api/login", {
      method: "POST",
      body: { email, password: secret },
    });
    assert.equal(r.status, expected);
    await r.json();
    return r.headers.get("set-cookie")?.split(";")[0];
  }
  await start();
  const admin = await login("admin@example.test"),
    clients = [];
  for (const [name, email] of [
    ["Анна Демонстрация", "anna@example.test"],
    ["Борис Демонстрация", "boris@example.test"],
    ["Без проектов", "empty@example.test"],
  ]) {
    const { user } = await json(
      "/api/register",
      { method: "POST", body: { name, email, password: secret } },
      201,
    );
    clients.push({ ...user, cookie: await login(email) });
  }
  const mutate = (path, body, method = "PATCH", status = 200) =>
    json(path, { cookie: admin, method, body }, status);
  return {
    root,
    dataDir,
    secret,
    admin,
    clients,
    request,
    json,
    login,
    mutate,
    start,
    async stop() {
      await app?.close();
      app = null;
    },
    async restart() {
      await app.close();
      app = null;
      await start();
    },
    async close() {
      await app?.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const validDate = (v) =>
  typeof v === "string" && Number.isFinite(Date.parse(v));

test("administrator client and project management preserves access, documents and history", async (t) => {
  const f = await fixture();
  const [owner, next, empty] = f.clients;
  let project, stage, file, recoveryToken, disabledSessions, disabledRequestId;
  try {
    await t.test(
      "1. client directory includes actual dates, activation and project counts without credentials",
      async () => {
        const { clients } = await f.json("/api/clients", { cookie: f.admin });
        assert.equal(clients.length, 3);
        for (const client of clients) {
          assert.ok(validDate(client.createdAt));
          assert.equal(Boolean(client.isActive), true);
          assert.equal(client.projectCount, 0);
          assert.equal("password" in client, false);
        }
      },
    );
    await t.test(
      "2. client without projects has an explicit empty detail",
      async () => {
        const data = await f.json(`${AC}/${empty.id}`, { cookie: f.admin });
        assert.equal(data.client.email, empty.email);
        assert.deepEqual(data.projects, []);
        assert.ok(Array.isArray(data.events));
      },
    );
    await t.test(
      "3. administrator creates a project with default new status for an active client",
      async () => {
        project = await f.mutate(
          "/api/projects",
          { title: "Квартира в Садовых кварталах", clientId: owner.id },
          "POST",
          201,
        );
        const detail = await f.json(`${AP}/${project.id}`, { cookie: f.admin });
        assert.equal(detail.project.status, "Новый");
        assert.ok(validDate(detail.project.createdAt));
        assert.equal(detail.project.clientId, owner.id);
      },
    );
    await t.test(
      "4. project detail retains stages and uploaded real image documents",
      async () => {
        stage = await f.mutate(
          `/api/projects/${project.id}/stages`,
          {
            title: "Планировка",
            status: "completed",
            description: "Согласована",
          },
          "POST",
          201,
        );
        const [, type, bytes] = fixtures.find((v) => v[1] === "image/png");
        file = await f.mutate(
          `/api/projects/${project.id}/files`,
          {
            name: "plan.png",
            contentType: type,
            category: "document",
            stageId: stage.id,
            data: bytes.toString("base64"),
          },
          "POST",
          201,
        );
        file.bytes = bytes;
        const { project: p, events } = await f.json(`${AP}/${project.id}`, {
          cookie: f.admin,
        });
        assert.equal(p.stages[0].id, stage.id);
        assert.equal(p.files[0].id, file.id);
        assert.ok(Array.isArray(events));
        const client = await f.json(`${AC}/${owner.id}`, { cookie: f.admin });
        assert.equal(client.projects[0].id, project.id);
      },
    );
    await t.test(
      "5. changing client name preserves email and forbids email or administrator edits",
      async () => {
        await f.mutate(`${AC}/${owner.id}`, {
          name: "Анна <script>безопасный текст</script>",
        });
        const { client } = await f.json(`${AC}/${owner.id}`, {
          cookie: f.admin,
        });
        assert.equal(client.name, "Анна <script>безопасный текст</script>");
        assert.equal(client.email, owner.email);
        await f.mutate(
          `${AC}/${owner.id}`,
          { email: "changed@example.test" },
          "PATCH",
          400,
        );
        const { user } = await f.json("/api/me", { cookie: f.admin });
        await f.mutate(
          `${AC}/${user.id}`,
          { name: "Change admin" },
          "PATCH",
          404,
        );
      },
    );
    await t.test(
      "6. disabling requires confirmation and invalidates all sessions and approved recovery",
      async () => {
        const extra = await f.login(owner.email);
        disabledSessions = [owner.cookie, extra];
        await f.json(
          "/api/password-recovery/requests",
          { method: "POST", body: { email: owner.email } },
          202,
        );
        const { requests } = await f.json(REC, { cookie: f.admin });
        const req = requests.find((v) => v.email === owner.email);
        const approved = await f.mutate(`${REC}/${req.id}/approve`, {}, "POST");
        recoveryToken = approved.resetPath.split("#")[1];
        await f.mutate(`${AC}/${owner.id}`, { isActive: false }, "PATCH", 400);
        await f.json("/api/me", { cookie: owner.cookie });
        await f.mutate(`${AC}/${owner.id}`, { isActive: false, confirm: true });
        for (const cookie of [owner.cookie, extra])
          await f.json("/api/me", { cookie }, 401);
        await f.login(owner.email, 401);
        await f.mutate(
          "/api/projects",
          { title: "No disabled owner", clientId: owner.id },
          "POST",
          400,
        );
        await f.mutate(`${REC}/${req.id}/approve`, {}, "POST", 409);
        const candidate = password();
        await f.json(
          "/api/password-recovery/reset",
          {
            method: "POST",
            body: {
              token: recoveryToken,
              password: candidate,
              passwordConfirm: candidate,
            },
          },
          400,
        );
        await f.json(
          "/api/password-recovery/requests",
          { method: "POST", body: { email: owner.email } },
          202,
        );
        const fresh = (await f.json(REC, { cookie: f.admin })).requests.find(
          (v) => v.email === owner.email,
        );
        assert.equal(fresh.userId, owner.id);
        disabledRequestId = fresh.id;
        await f.mutate(`${REC}/${fresh.id}/approve`, {}, "POST", 400);
      },
    );
    await t.test(
      "7. reactivation permits login but revives neither old sessions nor reset tokens",
      async () => {
        await f.mutate(`${AC}/${owner.id}`, { isActive: true, confirm: true });
        owner.cookie = await f.login(owner.email);
        for (const cookie of disabledSessions)
          await f.json("/api/me", { cookie }, 401);
        const newSecret = password();
        await f.json(
          "/api/password-recovery/reset",
          {
            method: "POST",
            body: {
              token: recoveryToken,
              password: newSecret,
              passwordConfirm: newSecret,
            },
          },
          400,
        );
        const freshlyApproved = await f.mutate(
          `${REC}/${disabledRequestId}/approve`,
          {},
          "POST",
        );
        assert.match(
          freshlyApproved.resetPath,
          /^\/reset-password\/#[a-f0-9]{64}$/,
        );
        assert.notEqual(freshlyApproved.resetPath.split("#")[1], recoveryToken);
        const { client } = await f.json(`${AC}/${owner.id}`, {
          cookie: f.admin,
        });
        assert.equal(Boolean(client.isActive), true);
      },
    );
    await t.test(
      "8. project edits validate statuses and preserve title, stages and documents",
      async () => {
        await f.mutate(`${AP}/${project.id}`, {
          title: "Обновлённый проект",
          status: "На паузе",
        });
        await f.mutate(
          `${AP}/${project.id}`,
          { status: "unknown" },
          "PATCH",
          400,
        );
        const { project: p } = await f.json(`${AP}/${project.id}`, {
          cookie: f.admin,
        });
        assert.equal(p.title, "Обновлённый проект");
        assert.equal(p.status, "На паузе");
        assert.equal(p.stages[0].id, stage.id);
        assert.equal(p.files[0].id, file.id);
      },
    );
    await t.test(
      "9. project filters and search report real title/client/email matches",
      async () => {
        for (const search of ["Обновлённый", "anna@example.test", "Анна"]) {
          const { projects } = await f.json(
            `${AP}?search=${encodeURIComponent(search)}&status=active`,
            { cookie: f.admin },
          );
          assert.ok(projects.some((v) => v.id === project.id));
        }
        const { projects } = await f.json(
          `${AP}?status=${encodeURIComponent("Завершён")}`,
          { cookie: f.admin },
        );
        assert.equal(
          projects.some((v) => v.id === project.id),
          false,
        );
        const emptyList = await f.json(`${AP}?search=does-not-exist`, {
          cookie: f.admin,
        });
        assert.deepEqual(emptyList.projects, []);
      },
    );
    await t.test(
      "10. archiving requires confirmation and preserves every stage and stored file",
      async () => {
        const before = await readFile(join(f.dataDir, "itd.sqlite"));
        const stored = await readdir(join(f.dataDir, "files"));
        const bytes = await Promise.all(
          stored.map((name) => readFile(join(f.dataDir, "files", name))),
        );
        await f.mutate(
          `${AP}/${project.id}`,
          { status: "Архив" },
          "PATCH",
          400,
        );
        assert.deepEqual(await readFile(join(f.dataDir, "itd.sqlite")), before);
        await f.mutate(`${AP}/${project.id}`, {
          status: "Архив",
          confirm: true,
        });
        const { project: p } = await f.json(`${AP}/${project.id}`, {
          cookie: f.admin,
        });
        assert.equal(p.status, "Архив");
        assert.equal(p.stages[0].id, stage.id);
        assert.equal(p.files[0].id, file.id);
        assert.deepEqual(await readdir(join(f.dataDir, "files")), stored);
        assert.deepEqual(
          await Promise.all(
            stored.map((name) => readFile(join(f.dataDir, "files", name))),
          ),
          bytes,
        );
        const active = await f.json(`${AP}?status=active`, { cookie: f.admin });
        assert.equal(
          active.projects.some((v) => v.id === project.id),
          false,
        );
        const archive = await f.json(
          `${AP}?status=${encodeURIComponent("Архив")}`,
          { cookie: f.admin },
        );
        assert.ok(archive.projects.some((v) => v.id === project.id));
      },
    );
    await t.test(
      "11. restoration requires confirmation and restores the remembered status",
      async () => {
        await f.mutate(`${AP}/${project.id}/restore`, {}, "POST", 400);
        await f.mutate(
          `${AP}/${project.id}/restore`,
          { confirm: true },
          "POST",
        );
        const { project: p } = await f.json(`${AP}/${project.id}`, {
          cookie: f.admin,
        });
        assert.equal(p.status, "На паузе");
      },
    );
    await t.test(
      "12. reassignment rejects missing confirmation and stale expected owner",
      async () => {
        await f.mutate(
          `${AP}/${project.id}/assign`,
          { clientId: next.id, expectedClientId: owner.id },
          "POST",
          400,
        );
        await f.mutate(
          `${AP}/${project.id}/assign`,
          { clientId: next.id, expectedClientId: 999999, confirm: true },
          "POST",
          409,
        );
        const { project: p } = await f.json(`${AP}/${project.id}`, {
          cookie: f.admin,
        });
        assert.equal(p.clientId, owner.id);
      },
    );
    await t.test(
      "13. ownership transfer removes old project/file access and grants exact original bytes to the new client",
      async () => {
        const stored = await readdir(join(f.dataDir, "files"));
        await f.mutate(
          `${AP}/${project.id}/assign`,
          { clientId: next.id, expectedClientId: owner.id, confirm: true },
          "POST",
        );
        const old = await f.json("/api/projects", { cookie: owner.cookie }),
          current = await f.json("/api/projects", { cookie: next.cookie });
        assert.equal(
          old.projects.some((v) => v.id === project.id),
          false,
        );
        assert.ok(current.projects.some((v) => v.id === project.id));
        for (const action of ["download", "preview"]) {
          await f.json(
            `/api/files/${file.id}/${action}`,
            { cookie: owner.cookie },
            403,
          );
          const response = await f.request(`/api/files/${file.id}/${action}`, {
            cookie: next.cookie,
          });
          assert.equal(response.status, 200);
          assert.deepEqual(
            Buffer.from(await response.arrayBuffer()),
            file.bytes,
          );
        }
        assert.deepEqual(await readdir(join(f.dataDir, "files")), stored);
        const { clients } = await f.json("/api/clients", { cookie: f.admin });
        assert.equal(clients.find((v) => v.id === owner.id).projectCount, 0);
        assert.equal(clients.find((v) => v.id === next.id).projectCount, 1);
      },
    );
    await t.test(
      "14. client cannot use any administrator read or mutation route",
      async () => {
        for (const cookie of [undefined, owner.cookie, next.cookie]) {
          const status = cookie ? 403 : 401;
          for (const path of [AC + "/" + owner.id, AP, AP + "/" + project.id])
            await f.json(path, { cookie }, status);
          for (const [path, method, body] of [
            [AC + "/" + owner.id, "PATCH", { name: "Forbidden" }],
            [AP + "/" + project.id, "PATCH", { title: "Forbidden" }],
            [AP + "/" + project.id + "/restore", "POST", { confirm: true }],
            [
              AP + "/" + project.id + "/assign",
              "POST",
              { clientId: owner.id, expectedClientId: next.id, confirm: true },
            ],
          ])
            await f.json(path, { cookie, method, body }, status);
        }
      },
    );
    await t.test(
      "15. all management mutations require CSRF and same-origin protection",
      async () => {
        for (const [path, method, body] of [
          [`${AC}/${owner.id}`, "PATCH", { name: "Forbidden" }],
          [`${AP}/${project.id}`, "PATCH", { title: "Forbidden" }],
          [`${AP}/${project.id}/restore`, "POST", { confirm: true }],
          [
            `${AP}/${project.id}/assign`,
            "POST",
            { clientId: owner.id, expectedClientId: next.id, confirm: true },
          ],
        ]) {
          await f.json(
            path,
            { cookie: f.admin, method, body, csrf: false },
            403,
          );
          await f.json(
            path,
            { cookie: f.admin, method, body, origin: "https://evil.example" },
            403,
          );
        }
      },
    );
    await t.test(
      "16. deletion, administrator ownership and unsupported mutations are refused",
      async () => {
        for (const path of [`${AC}/${owner.id}`, `${AP}/${project.id}`]) {
          const r = await f.request(path, {
            cookie: f.admin,
            method: "DELETE",
            body: { confirm: true },
          });
          assert.ok([404, 405].includes(r.status));
          await r.arrayBuffer();
        }
        await f.mutate(
          `${AC}/${owner.id}`,
          { password: "Cannot set password" },
          "PATCH",
          400,
        );
        await f.mutate(
          `${AP}/${project.id}`,
          { clientId: owner.id },
          "PATCH",
          400,
        );
        await f.mutate(`${AP}/${project.id}`, { title: "" }, "PATCH", 400);
      },
    );
    await t.test(
      "17. client audit includes recovery actions and project audit records edits archive restore and reassignment",
      async () => {
        const client = await f.json(`${AC}/${owner.id}`, { cookie: f.admin }),
          p = await f.json(`${AP}/${project.id}`, { cookie: f.admin });
        assert.ok(client.events.length >= 3);
        assert.ok(p.events.length >= 4);
        for (const data of [client, p]) {
          assert.equal(JSON.stringify(data).includes(f.secret), false);
          assert.equal(JSON.stringify(data).includes(recoveryToken), false);
          assert.ok(data.events.every((e) => validDate(e.createdAt)));
        }
      },
    );
    await t.test(
      "18. changed states and audit history survive restart",
      async () => {
        await f.mutate(`${AP}/${project.id}`, {
          status: "Архив",
          confirm: true,
        });
        await f.mutate(`${AC}/${empty.id}`, { isActive: false, confirm: true });
        await f.restart();
        const { project: p, events } = await f.json(`${AP}/${project.id}`, {
          cookie: f.admin,
        });
        assert.equal(p.status, "Архив");
        assert.equal(p.clientId, next.id);
        assert.ok(events.length >= 4);
        const { client } = await f.json(`${AC}/${empty.id}`, {
          cookie: f.admin,
        });
        assert.equal(Boolean(client.isActive), false);
      },
    );
    await t.test(
      "19. backups restore ownership archive activation audit and unchanged document bytes",
      async () => {
        await f.stop();
        const settingsFile = join(f.root, "storage.json");
        await bindData(f.dataDir, {
          settingsFile,
          backupDestination: join(f.root, "backups"),
        });
        const backup = await backupData({
          settingsFile,
          destination: join(f.root, "backups"),
        });
        verifyBackup(backup);
        const restored = join(f.root, "restored");
        restoreBackup(backup, restored);
        await f.start(restored);
        const { project: p, events } = await f.json(`${AP}/${project.id}`, {
          cookie: f.admin,
        });
        assert.equal(p.status, "Архив");
        assert.equal(p.clientId, next.id);
        assert.ok(events.length >= 4);
        const client = await f.json(`${AC}/${empty.id}`, { cookie: f.admin });
        assert.equal(Boolean(client.client.isActive), false);
        const r = await f.request(`/api/files/${file.id}/download`, {
          cookie: next.cookie,
        });
        assert.equal(r.status, 200);
        assert.deepEqual(Buffer.from(await r.arrayBuffer()), file.bytes);
      },
    );
  } finally {
    await f.close();
  }
});

test("20. legacy client/project migration adds null historical dates without changing original values or backups", async () => {
  const f = await fixture();
  try {
    const project = await f.mutate(
      "/api/projects",
      {
        title: "Legacy project",
        clientId: f.clients[0].id,
        status: "На паузе",
      },
      "POST",
      201,
    );
    const [, contentType, bytes] = fixtures.find(
      (row) => row[1] === "image/png",
    );
    const file = await f.mutate(
      `/api/projects/${project.id}/files`,
      {
        name: "legacy.png",
        contentType,
        category: "result",
        data: bytes.toString("base64"),
      },
      "POST",
      201,
    );
    await f.stop();
    const oldColumns = {
      users: "id,email,name,role,password",
      projects: "id,title,clientId,status",
      stages: "id,projectId,title,status,description",
      files: "id,projectId,stageId,name,contentType,category,path,size",
      sessions: "token,userId,expires",
    };
    let before;
    // Only this disposable fixture removes additions to emulate an older installation.
    const db = new DatabaseSync(join(f.dataDir, "itd.sqlite"));
    try {
      db.exec(
        "DROP TABLE review_views; DROP TABLE review_notifications; DROP TABLE review_events; DROP TABLE review_versions; DROP TABLE review_materials; DROP TABLE admin_management_events; ALTER TABLE users DROP COLUMN createdAt; ALTER TABLE users DROP COLUMN isActive; ALTER TABLE projects DROP COLUMN createdAt; ALTER TABLE projects DROP COLUMN archivedFrom;",
      );
      before = Object.fromEntries(
        Object.entries(oldColumns).map(([table, columns]) => [
          table,
          db
            .prepare(
              `SELECT ${columns} FROM ${table} ORDER BY ${table === "sessions" ? "token" : "id"}`,
            )
            .all(),
        ]),
      );
    } finally {
      db.close();
    }
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
      for (const [table, columns] of Object.entries(oldColumns))
        assert.deepEqual(
          migrated
            .prepare(
              `SELECT ${columns} FROM ${table} ORDER BY ${table === "sessions" ? "token" : "id"}`,
            )
            .all(),
          before[table],
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
      assert.equal(
        migrated
          .prepare("SELECT count(*) AS n FROM admin_management_events")
          .get().n,
        0,
      );
    } finally {
      migrated.close();
    }
    const restored = join(f.root, "legacy-restored");
    restoreBackup(bound.backupDir, restored);
    await f.start(restored);
    const client = await f.json(`${AC}/${f.clients[0].id}`, {
      cookie: f.admin,
    });
    assert.equal(client.client.createdAt, null);
    assert.equal(client.client.isActive, true);
    const detail = await f.json(`${AP}/${project.id}`, { cookie: f.admin });
    assert.equal(detail.project.createdAt, null);
    assert.equal(detail.project.status, "На паузе");
    const response = await f.request(`/api/files/${file.id}/download`, {
      cookie: f.clients[0].cookie,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  } finally {
    await f.close();
  }
});

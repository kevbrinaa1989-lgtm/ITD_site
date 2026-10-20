import { prepareFixtureUpload } from "./tests/upload-fixture.mjs";
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
  const root = await mkdtemp(join(tmpdir(), "itd-review-test-")),
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
    body = await prepareFixtureUpload(base, path, body, cookie, method, {
      csrf,
      origin,
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

const MV = "/api/material-versions",
  MAT = "/api/materials";
const emptyView = {
  viewed: false,
  firstViewedAt: null,
  lastViewedAt: null,
  viewCount: 0,
};
const viewState = (v) => ({
  viewed: v.viewed,
  firstViewedAt: v.firstViewedAt,
  lastViewedAt: v.lastViewedAt,
  viewCount: v.viewCount,
});
test("review workflow and per-user per-version viewing retain immutable history and current ownership", async (t) => {
  const f = await fixture();
  const [owner, other] = f.clients;
  const [, mime, bytes] = fixtures.find((x) => x[1] === "image/jpeg");
  let project,
    stage,
    materialId,
    v1,
    v2,
    v3,
    oldFile,
    firstView,
    secondView,
    ownerNotice;
  const detail = (cookie = owner.cookie) =>
    f.json(`${MAT}/${materialId}`, { cookie });
  const latest = async () => (await detail()).material.currentVersion;
  const upload = (name, extra = {}, expected = 201) =>
    f.mutate(
      `/api/projects/${project.id}/files`,
      {
        name,
        contentType: mime,
        data: bytes.toString("base64"),
        category: "result",
        stageId: stage.id,
        ...extra,
      },
      "POST",
      expected,
    );
  const post = (path, body, cookie = owner.cookie, status = 200) =>
    f.json(path, { method: "POST", body, cookie }, status);
  const decide = (version, data, cookie = owner.cookie, status = 200) =>
    post(
      `${MV}/${version.id}/decision`,
      { expectedRevision: version.revision, ...data },
      cookie,
      status,
    );
  const comment = (v, text, cookie = owner.cookie, status = 200) =>
    post(`${MV}/${v.id}/comments`, { text }, cookie, status);
  const view = (v, cookie = owner.cookie, status = 200) =>
    post(`${MV}/${v.id}/view`, {}, cookie, status);
  try {
    await t.test(
      "1. create a project without modifying existing clients",
      async () => {
        project = await f.mutate(
          "/api/projects",
          { title: "Согласование интерьера", clientId: owner.id },
          "POST",
          201,
        );
        assert.ok(project.id);
      },
    );
    await t.test(
      "2. create a stage while keeping administrator-only manual status changes",
      async () => {
        stage = await f.mutate(
          `/api/projects/${project.id}/stages`,
          {
            title: "Планировочное решение",
            status: "in_progress",
            description: "Материалы",
          },
          "POST",
          201,
        );
        await f.json(
          `/api/stages/${stage.id}`,
          {
            cookie: owner.cookie,
            method: "PATCH",
            body: { status: "completed" },
          },
          403,
        );
      },
    );
    await t.test(
      "3. upload review version one with immutable original bytes",
      async () => {
        oldFile = await upload("Обычный-файл.jpg");
        const result = await upload("Планировка-v1.jpg", { review: true });
        materialId = result.review.materialId;
        v1 = await latest();
        assert.equal(v1.versionNumber, 1);
        assert.equal(v1.status, "pending_approval");
        assert.equal(v1.revision, 0);
        const response = await f.request(`/api/files/${v1.file.id}/download`, {
          cookie: owner.cookie,
        });
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      },
    );
    await t.test(
      "4. newly submitted version is unviewed and has no fabricated view dates",
      async () => {
        assert.deepEqual(viewState((await latest()).view), emptyView);
        assert.ok(validDate(v1.createdAt));
        assert.equal(v1.uploadedByName, "Администратор");
      },
    );
    await t.test(
      "5. project stage material lists thumbnail GET and download never mark a view",
      async () => {
        await f.json("/api/projects", { cookie: owner.cookie });
        await f.json(`/api/projects/${project.id}/materials`, {
          cookie: owner.cookie,
        });
        await detail();
        for (const suffix of ["preview", "download"]) {
          const r = await f.request(`/api/files/${v1.file.id}/${suffix}`, {
            cookie: owner.cookie,
          });
          assert.equal(r.status, 200);
          await r.arrayBuffer();
        }
        assert.deepEqual(viewState((await latest()).view), emptyView);
      },
    );
    await t.test(
      "6. client image-view acknowledgement records first and last timestamps and count",
      async () => {
        const result = await view(v1);
        assert.equal(result.firstView, true);
        firstView = result.view;
        assert.equal(firstView.viewed, true);
        assert.equal(firstView.viewCount, 1);
        assert.equal(firstView.firstViewedAt, firstView.lastViewedAt);
        assert.ok(validDate(firstView.firstViewedAt));
        assert.deepEqual(
          viewState((await latest()).view),
          viewState(firstView),
        );
      },
    );
    await t.test(
      "7. supported PDF view also records version-specific acknowledgement",
      async () => {
        const [name, type, pdf] = fixtures.find(
          (x) => x[1] === "application/pdf",
        );
        const uploaded = await upload(name, {
          contentType: type,
          data: pdf.toString("base64"),
          review: true,
        });
        const d = await f.json(`${MAT}/${uploaded.review.materialId}`, {
          cookie: owner.cookie,
        });
        const acknowledged = await view(d.material.currentVersion);
        assert.equal(acknowledged.firstView, true);
        assert.equal(acknowledged.view.viewCount, 1);
      },
    );
    await t.test(
      "8. administrator preview cannot mark client viewing or use the view mutation",
      async () => {
        const before = await latest();
        const r = await f.request(`/api/files/${v1.file.id}/preview`, {
          cookie: f.admin,
        });
        assert.equal(r.status, 200);
        await r.arrayBuffer();
        await view(v1, f.admin, 403);
        assert.deepEqual((await latest()).view, before.view);
      },
    );
    await t.test(
      "9. repeated view preserves first date and updates last/count without duplicate first-view events",
      async () => {
        await new Promise((r) => setTimeout(r, 8));
        const before = await detail(),
          notices = await f.json("/api/notifications", { cookie: f.admin });
        const result = await view(v1);
        secondView = result.view;
        assert.equal(result.firstView, false);
        assert.equal(secondView.firstViewedAt, firstView.firstViewedAt);
        assert.ok(
          Date.parse(secondView.lastViewedAt) >
            Date.parse(firstView.lastViewedAt),
        );
        assert.equal(secondView.viewCount, 2);
        assert.equal(
          (await detail()).events.filter(
            (e) => e.type === "first_viewed" && e.versionId === v1.id,
          ).length,
          1,
        );
        assert.equal((await detail()).events.length, before.events.length);
        assert.equal(
          (await f.json("/api/notifications", { cookie: f.admin }))
            .notifications.length,
          notices.notifications.length,
        );
      },
    );
    await t.test(
      "10. change requests require a nonempty bounded comment and exact revision",
      async () => {
        for (const text of ["", "   ", "x".repeat(4001)])
          await decide(
            v1,
            { decision: "changes_requested", comment: text },
            owner.cookie,
            400,
          );
        await decide(
          v1,
          {
            decision: "changes_requested",
            comment: "Проход шире",
            expectedRevision: 99,
          },
          owner.cookie,
          409,
        );
      },
    );
    await t.test(
      "11. client changes request stores version author and exact comment text",
      async () => {
        await decide(v1, {
          decision: "changes_requested",
          comment: "Просим увеличить проход у кухни",
        });
        const d = await detail();
        assert.equal(d.material.currentVersion.status, "changes_requested");
        assert.equal(d.material.currentVersion.revision, 1);
        assert.ok(
          d.events.some(
            (e) =>
              e.type === "changes_requested" &&
              e.body === "Просим увеличить проход у кухни" &&
              e.versionId === v1.id &&
              e.actorId === owner.id,
          ),
        );
      },
    );
    await t.test(
      "12. administrator sees the decision without changing its view metadata",
      async () => {
        const d = await detail(f.admin);
        assert.equal(d.material.currentVersion.status, "changes_requested");
        assert.deepEqual(
          viewState(d.material.currentVersion.view),
          viewState(secondView),
        );
        assert.ok(
          (
            await f.json("/api/notifications", { cookie: f.admin })
          ).notifications.some((n) => n.materialId === materialId),
        );
      },
    );
    await t.test(
      "13. administrator replies and client discussion preserve author and version context",
      async () => {
        await comment(v1, "Уточните ширину прохода", f.admin);
        await comment(v1, "Нужно не менее 110 см");
        const d = await detail();
        assert.ok(
          d.events.some(
            (e) =>
              e.type === "admin_reply" &&
              e.actorRole === "admin" &&
              e.versionId === v1.id,
          ),
        );
        assert.ok(
          d.events.some(
            (e) =>
              e.type === "comment" &&
              e.actorRole === "client" &&
              e.body === "Нужно не менее 110 см",
          ),
        );
        for (const text of ["", "x".repeat(4001)])
          await comment(v1, text, owner.cookie, 400);
      },
    );
    await t.test(
      "14. version two starts pending and does not inherit the earlier decision",
      async () => {
        const uploaded = await upload("Планировка-v2.jpg", {
          materialId,
          expectedVersionId: v1.id,
        });
        v2 = await latest();
        assert.equal(v2.id, uploaded.review.versionId);
        assert.equal(v2.versionNumber, 2);
        assert.equal(v2.status, "pending_approval");
        assert.equal(
          (await detail()).versions.find((v) => v.id === v1.id).status,
          "changes_requested",
        );
      },
    );
    await t.test(
      "15. version two starts unviewed while version one retains both view dates",
      async () => {
        assert.deepEqual(viewState((await latest()).view), emptyView);
        assert.deepEqual(
          viewState((await detail()).versions.find((v) => v.id === v1.id).view),
          viewState(secondView),
        );
      },
    );
    await t.test(
      "16. only a version-two acknowledgement marks version two as viewed",
      async () => {
        await view(v2);
        const d = await detail();
        assert.equal(d.material.currentVersion.view.viewCount, 1);
        assert.equal(d.versions.find((v) => v.id === v1.id).view.viewCount, 2);
      },
    );
    await t.test(
      "17. first-view events and notifications are created once per user/version",
      async () => {
        const before = await f.json("/api/notifications", { cookie: f.admin }),
          d = await detail();
        await view(v2);
        assert.equal(
          (await f.json("/api/notifications", { cookie: f.admin }))
            .notifications.length,
          before.notifications.length,
        );
        assert.equal(
          (await detail()).events.filter(
            (e) => e.type === "first_viewed" && e.versionId === v2.id,
          ).length,
          1,
        );
        assert.equal((await detail()).events.length, d.events.length);
      },
    );
    await t.test(
      "18. version-two approval requires confirmation then records author timestamp and revision",
      async () => {
        await decide(v2, { decision: "approved" }, owner.cookie, 400);
        await decide(v2, { decision: "approved", confirm: true });
        const current = await latest();
        assert.equal(current.status, "approved");
        assert.equal(current.revision, 1);
        assert.equal(current.decisionByName, owner.name);
        assert.ok(validDate(current.decisionAt));
      },
    );
    await t.test(
      "19. version one and its discussion remain in the immutable material history",
      async () => {
        const d = await detail();
        assert.equal(
          d.versions.find((v) => v.id === v1.id).status,
          "changes_requested",
        );
        assert.ok(
          d.events.some(
            (e) => e.versionId === v1.id && e.body === "Нужно не менее 110 см",
          ),
        );
        const db = new DatabaseSync(join(f.dataDir, "itd.sqlite"));
        try {
          assert.throws(() =>
            db
              .prepare("UPDATE review_events SET body=? WHERE id=?")
              .run("edited", d.events[0].id),
          );
          assert.throws(() =>
            db
              .prepare("DELETE FROM review_events WHERE id=?")
              .run(d.events[0].id),
          );
        } finally {
          db.close();
        }
      },
    );
    await t.test(
      "20. viewing and decision state are independent and no old decision may target the latest version",
      async () => {
        await decide(
          { ...v1, revision: 1 },
          { decision: "approved", confirm: true },
          owner.cookie,
          409,
        );
        const before = await latest();
        await view(v1);
        assert.equal((await latest()).status, before.status);
        assert.equal((await latest()).revision, before.revision);
      },
    );
    await t.test(
      "21. approval cannot be repeated with stale or current revision to duplicate history",
      async () => {
        const before = await detail();
        await decide(
          v2,
          { decision: "approved", confirm: true },
          owner.cookie,
          409,
        );
        await decide(
          { ...v2, revision: 1 },
          { decision: "approved", confirm: true },
          owner.cookie,
          409,
        );
        assert.deepEqual((await detail()).events, before.events);
      },
    );
    await t.test(
      "22. version three is pending with its own unviewed state after prior approval",
      async () => {
        await upload("Планировка-v3.jpg", {
          materialId,
          expectedVersionId: v2.id,
        });
        v3 = await latest();
        assert.equal(v3.status, "pending_approval");
        assert.deepEqual(viewState(v3.view), emptyView);
        assert.equal(
          (await detail()).versions.find((v) => v.id === v2.id).status,
          "approved",
        );
        await upload(
          "stale.jpg",
          { materialId, expectedVersionId: v1.id },
          409,
        );
      },
    );
    await t.test(
      "23. viewing an old version never marks a new current version as viewed",
      async () => {
        await view(v2);
        assert.deepEqual(viewState((await latest()).view), emptyView);
        assert.ok(
          (await detail()).versions.find((v) => v.id === v2.id).view
            .viewCount >= 3,
        );
      },
    );
    await t.test(
      "24. repeated and concurrent decisions obey compare-and-swap without duplicate acceptance",
      async () => {
        const responses = await Promise.all(
          [1, 2].map(() =>
            f.request(`${MV}/${v3.id}/decision`, {
              cookie: owner.cookie,
              method: "POST",
              body: {
                decision: "approved",
                confirm: true,
                expectedRevision: 0,
              },
            }),
          ),
        );
        assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
        await Promise.all(responses.map((r) => r.json()));
        assert.equal(
          (await detail()).events.filter(
            (e) => e.type === "approved" && e.versionId === v3.id,
          ).length,
          1,
        );
      },
    );
    await t.test(
      "25. foreign clients cannot read material discussion or decide any version",
      async () => {
        for (const cookie of [null, other.cookie]) {
          const status = cookie ? 403 : 401;
          await f.json(`${MAT}/${materialId}`, { cookie }, status);
          await f.json(
            `/api/projects/${project.id}/materials`,
            { cookie },
            status,
          );
          await comment(v1, "Чужое", cookie, status);
          await decide(
            v3,
            { decision: "approved", confirm: true },
            cookie,
            status,
          );
        }
      },
    );
    await t.test(
      "26. anonymous foreign admin and disabled accounts cannot forge client view acknowledgement",
      async () => {
        for (const cookie of [null, other.cookie, f.admin])
          await view(v3, cookie, cookie ? 403 : 401);
        await f.mutate(`${AC}/${owner.id}`, { isActive: false, confirm: true });
        await view(v3, owner.cookie, 401);
        await f.mutate(`${AC}/${owner.id}`, { isActive: true, confirm: true });
        owner.cookie = await f.login(owner.email);
        await f.json(
          `${MV}/999999/view`,
          { cookie: owner.cookie, method: "POST", body: {} },
          404,
        );
      },
    );
    await t.test(
      "27. comments and views reject cross-origin requests, missing CSRF and impersonation fields",
      async () => {
        for (const path of [
          `${MV}/${v3.id}/view`,
          `${MV}/${v3.id}/comments`,
          `${MV}/${v3.id}/decision`,
        ]) {
          await f.json(
            path,
            { cookie: owner.cookie, method: "POST", body: {}, csrf: false },
            403,
          );
          await f.json(
            path,
            {
              cookie: owner.cookie,
              method: "POST",
              body: {},
              origin: "https://evil.example",
            },
            403,
          );
        }
        await post(
          `${MV}/${v3.id}/view`,
          { userId: other.id },
          owner.cookie,
          400,
        );
      },
    );
    await t.test(
      "28. approval cancellation is administrator-only with a required reason and confirmation",
      async () => {
        const current = await latest();
        await post(
          `${MV}/${current.id}/cancel`,
          { reason: "Нет", confirm: true, expectedRevision: current.revision },
          owner.cookie,
          403,
        );
        for (const payload of [
          { reason: "", confirm: true },
          { reason: "Причина" },
          { reason: "Причина", confirm: true, expectedRevision: 0 },
        ])
          await post(
            `${MV}/${current.id}/cancel`,
            { expectedRevision: current.revision, ...payload },
            f.admin,
            payload.expectedRevision === 0 ? 409 : 400,
          );
        await post(
          `${MV}/${current.id}/cancel`,
          {
            reason: "Заказчик уточнил требования",
            confirm: true,
            expectedRevision: current.revision,
          },
          f.admin,
        );
        const d = await detail();
        assert.equal(d.material.currentVersion.status, "pending_approval");
        assert.ok(
          d.events.some(
            (e) => e.type === "approved" && e.versionId === current.id,
          ),
        );
        assert.ok(
          d.events.some(
            (e) =>
              e.type === "approval_cancelled" &&
              e.body === "Заказчик уточнил требования",
          ),
        );
      },
    );
    await t.test(
      "29. aggregate stage status prioritizes changes then pending then all current approvals",
      async () => {
        let p = await f.json("/api/projects", { cookie: owner.cookie });
        assert.equal(p.projects[0].stages[0].status, "pending_approval");
        await decide(await latest(), {
          decision: "changes_requested",
          comment: "Новая схема",
        });
        p = await f.json("/api/projects", { cookie: owner.cookie });
        assert.equal(p.projects[0].stages[0].status, "changes_requested");
        await upload("Планировка-v4.jpg", {
          materialId,
          expectedVersionId: v3.id,
        });
        await decide(await latest(), { decision: "approved", confirm: true });
        const list = (
          await f.json(`/api/projects/${project.id}/materials`, {
            cookie: owner.cookie,
          })
        ).materials;
        for (const m of list)
          if (m.currentVersion.status === "pending_approval")
            await decide(m.currentVersion, {
              decision: "approved",
              confirm: true,
            });
        p = await f.json("/api/projects", { cookie: owner.cookie });
        assert.equal(p.projects[0].stages[0].status, "approved");
        const extra = await f.mutate(
          `/api/projects/${project.id}/stages`,
          { title: "Без материалов", status: "planned", description: "" },
          "POST",
          201,
        );
        for (const status of [
          "planned",
          "in_progress",
          "pending_approval",
          "changes_requested",
          "approved",
          "completed",
        ])
          await f.mutate(`/api/stages/${extra.id}`, { status });
      },
    );
    await t.test(
      "30. discussion and view metadata survive a complete application restart",
      async () => {
        const before = await detail();
        await f.restart();
        assert.deepEqual(await detail(), before);
      },
    );
    await t.test(
      "31. linked files are protected while untracked deletion and explicit enrollment remain supported",
      async () => {
        await f.mutate(`/api/files/${v1.file.id}`, {}, "DELETE", 409);
        await f.mutate(`/api/files/${oldFile.id}/review`, {}, "POST", 400);
        const enrolled = await f.mutate(
          `/api/files/${oldFile.id}/review`,
          { confirm: true },
          "POST",
          201,
        );
        assert.equal(enrolled.material.currentVersion.file.id, oldFile.id);
        const temporary = await upload("Обычный-временный.jpg");
        await f.mutate(`/api/files/${temporary.id}`, {}, "DELETE");
      },
    );
    await t.test(
      "32. unsupported and corrupt preview data do not acquire a fabricated successful view",
      async () => {
        for (const [name, type, data] of [
          ["notes.txt", "text/plain", Buffer.from("only download")],
          ["broken.jpg", "image/jpeg", Buffer.from("not an image")],
        ]) {
          const uploaded = await upload(name, {
            contentType: type,
            data: data.toString("base64"),
            review: true,
          });
          const d = await f.json(`${MAT}/${uploaded.review.materialId}`, {
            cookie: owner.cookie,
          });
          await view(d.material.currentVersion, owner.cookie, 415);
          const unchanged = await f.json(
            `${MAT}/${uploaded.review.materialId}`,
            { cookie: owner.cookie },
          );
          assert.deepEqual(
            viewState(unchanged.material.currentVersion.view),
            emptyView,
          );
        }
      },
    );
    await t.test(
      "33. archive preserves approvals comments and per-version views unchanged",
      async () => {
        const before = await detail();
        await f.mutate(`${AP}/${project.id}`, {
          status: "Архив",
          confirm: true,
        });
        assert.deepEqual(await detail(), before);
      },
    );
    await t.test(
      "34. restoration preserves immutable review history and viewing state",
      async () => {
        const before = await detail();
        await f.mutate(
          `${AP}/${project.id}/restore`,
          { confirm: true },
          "POST",
        );
        assert.deepEqual(await detail(), before);
      },
    );
    await t.test(
      "35. original gallery preview and downloads retain exact stored bytes for every image version",
      async () => {
        for (const version of (await detail()).versions)
          for (const action of ["preview", "download"]) {
            const response = await f.request(
              `/api/files/${version.file.id}/${action}`,
              { cookie: owner.cookie },
            );
            assert.equal(response.status, 200);
            assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
          }
      },
    );
    await t.test(
      "36. notification reads are recipient-only and repeated reads do not lower counts twice",
      async () => {
        const list = await f.json("/api/notifications", {
          cookie: owner.cookie,
        });
        ownerNotice = list.notifications.find(
          (n) => n.materialId === materialId && !n.readAt,
        );
        await post(
          `/api/notifications/${ownerNotice.id}/read`,
          {},
          other.cookie,
          404,
        );
        await post(`/api/notifications/${ownerNotice.id}/read`, {});
        const after = await f.json("/api/notifications", {
          cookie: owner.cookie,
        });
        assert.equal(after.unreadCount, list.unreadCount - 1);
        await post(`/api/notifications/${ownerNotice.id}/read`, {});
        assert.equal(
          (await f.json("/api/notifications", { cookie: owner.cookie }))
            .unreadCount,
          after.unreadCount,
        );
      },
    );
    await t.test(
      "37. disabled recipients receive no new reply notification and old sessions never revive",
      async () => {
        const before = await f.json("/api/notifications", {
            cookie: owner.cookie,
          }),
          oldCookie = owner.cookie;
        await f.mutate(`${AC}/${owner.id}`, { isActive: false, confirm: true });
        await comment(v1, "Недоступно", oldCookie, 401);
        await comment(v1, "Ответ при отключённом клиенте", f.admin);
        await f.mutate(`${AC}/${owner.id}`, { isActive: true, confirm: true });
        await f.json("/api/me", { cookie: oldCookie }, 401);
        owner.cookie = await f.login(owner.email);
        assert.equal(
          (await f.json("/api/notifications", { cookie: owner.cookie }))
            .notifications.length,
          before.notifications.length,
        );
      },
    );
    await t.test(
      "38. ownership transfer removes old review file and notification access immediately",
      async () => {
        await f.mutate(
          `${AP}/${project.id}/assign`,
          { clientId: other.id, expectedClientId: owner.id, confirm: true },
          "POST",
        );
        await f.json(`${MAT}/${materialId}`, { cookie: owner.cookie }, 403);
        await view(v1, owner.cookie, 403);
        await comment(v1, "Больше нет доступа", owner.cookie, 403);
        for (const action of ["preview", "download"])
          await f.json(
            `/api/files/${v1.file.id}/${action}`,
            { cookie: owner.cookie },
            403,
          );
        assert.equal(
          (
            await f.json("/api/notifications", { cookie: owner.cookie })
          ).notifications.some((n) => n.projectId === project.id),
          false,
        );
        await post(
          `/api/notifications/${ownerNotice.id}/read`,
          {},
          owner.cookie,
          404,
        );
      },
    );
    await t.test(
      "39. view state belongs to individual users while an administrator retains earlier owner history",
      async () => {
        const d = await detail(other.cookie);
        assert.deepEqual(
          viewState(d.versions.find((v) => v.id === v1.id).view),
          emptyView,
        );
        await view(v1, other.cookie);
        const admin = await detail(f.admin);
        const version = admin.versions.find((v) => v.id === v1.id);
        assert.ok(
          version.views.some(
            (v) =>
              v.userId === owner.id &&
              v.firstViewedAt === firstView.firstViewedAt,
          ),
        );
        assert.ok(
          version.views.some((v) => v.userId === other.id && v.viewCount === 1),
        );
        const next = await detail(other.cookie);
        assert.ok(
          next.versions
            .find((v) => v.id === v1.id)
            .views.every((v) => v.userId === other.id),
        );
      },
    );
    await t.test(
      "40. audit stores only one first-view event per user/version and no credentials",
      async () => {
        const d = await detail(f.admin);
        assert.equal(
          d.events.filter(
            (e) =>
              e.type === "first_viewed" &&
              e.versionId === v1.id &&
              e.actorId === owner.id,
          ).length,
          1,
        );
        assert.equal(
          d.events.filter(
            (e) =>
              e.type === "first_viewed" &&
              e.versionId === v1.id &&
              e.actorId === other.id,
          ).length,
          1,
        );
        const audit = await f.json(`${AP}/${project.id}`, { cookie: f.admin });
        assert.ok(audit.events.some((e) => e.type === "material.first_viewed"));
        assert.equal(JSON.stringify(audit).includes(f.secret), false);
      },
    );
    await t.test(
      "41. full backup and restore retain version decisions comments per-user views notifications and original files",
      async () => {
        const before = await detail(f.admin),
          notices = await f.json("/api/notifications", { cookie: f.admin });
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
        await f.start(restored);
        assert.deepEqual(await detail(f.admin), before);
        assert.deepEqual(
          await f.json("/api/notifications", { cookie: f.admin }),
          notices,
        );
        const response = await f.request(`/api/files/${v1.file.id}/download`, {
          cookie: other.cookie,
        });
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
      },
    );
  } finally {
    await f.close();
  }
});

test("42. additive migration leaves old rows files and prior audit history unchanged and legacy backups readable", async () => {
  const f = await fixture();
  try {
    const p = await f.mutate(
      "/api/projects",
      { title: "Legacy review migration", clientId: f.clients[0].id },
      "POST",
      201,
    );
    const stage = await f.mutate(
      `/api/projects/${p.id}/stages`,
      { title: "Legacy stage", status: "completed", description: "Unchanged" },
      "POST",
      201,
    );
    const [, type, bytes] = fixtures.find((x) => x[1] === "image/png");
    const file = await f.mutate(
      `/api/projects/${p.id}/files`,
      {
        name: "legacy.png",
        contentType: type,
        category: "result",
        stageId: stage.id,
        data: bytes.toString("base64"),
      },
      "POST",
      201,
    );
    await f.stop();
    const oldTables = [
      "users",
      "projects",
      "stages",
      "files",
      "sessions",
      "admin_management_events",
      "password_recovery_requests",
      "password_recovery_events",
      "password_recovery_limits",
    ];
    const order = (table) =>
      table === "sessions"
        ? "token"
        : table === "password_recovery_limits"
          ? "key"
          : "id";
    let before, oldColumns;
    // Only this disposable fixture removes additions to emulate the previous release.
    const db = new DatabaseSync(join(f.dataDir, "itd.sqlite"));
    try {
      db.exec(
        "DROP TABLE admin_tasks; ALTER TABLE stages DROP COLUMN startDate; ALTER TABLE stages DROP COLUMN plannedEndDate; DROP TABLE review_views; DROP TABLE review_notifications; DROP TABLE review_events; DROP TABLE review_versions; DROP TABLE review_materials;",
      );
      oldColumns = Object.fromEntries(
        oldTables.map((table) => [
          table,
          db
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .map((column) => column.name)
            .join(","),
        ]),
      );
      before = Object.fromEntries(
        oldTables.map((table) => [
          table,
          db.prepare(`SELECT * FROM ${table} ORDER BY ${order(table)}`).all(),
        ]),
      );
    } finally {
      db.close();
    }
    const settingsFile = join(f.root, "legacy.json");
    const saved = await bindData(f.dataDir, {
      settingsFile,
      backupDestination: join(f.root, "backups"),
    });
    verifyBackup(saved.backupDir);
    const app = createApp({ storageOptions: { settingsFile } });
    await app.close();
    const migrated = new DatabaseSync(join(f.dataDir, "itd.sqlite"), {
      readOnly: true,
    });
    try {
      for (const table of oldTables)
        assert.deepEqual(
          migrated
            .prepare(
              `SELECT ${oldColumns[table]} FROM ${table} ORDER BY ${order(table)}`,
            )
            .all(),
          before[table],
        );
      for (const table of [
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
    } finally {
      migrated.close();
    }
    const restored = join(f.root, "legacy-restored");
    restoreBackup(saved.backupDir, restored);
    await f.start(restored);
    const list = await f.json(`/api/projects/${p.id}/materials`, {
      cookie: f.clients[0].cookie,
    });
    assert.deepEqual(list.materials, []);
    const response = await f.request(`/api/files/${file.id}/download`, {
      cookie: f.clients[0].cookie,
    });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  } finally {
    await f.close();
  }
});

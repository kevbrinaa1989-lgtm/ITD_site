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
  const root = await mkdtemp(join(tmpdir(), "itd-workspace-test-")),
    dataDir = join(root, "data"),
    secret = password();
  let app, base;
  let clock = Date.now();
  async function start(folder = dataDir) {
    // Capture the same controllable clock in review's existing now default;
    // restore the process clock immediately, before asynchronous work resumes.
    const originalNow = Date.now;
    try {
      Date.now = () => clock;
      app = createApp({
        dataDir: folder,
        adminEmail: "admin@example.test",
        adminPassword: secret,
        workspaceNow: () => clock,
      });
    } finally {
      Date.now = originalNow;
    }
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
    setNow: (value) => {
      clock = typeof value === "string" ? Date.parse(value) : value;
    },
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

const DASH = "/api/admin/workspace",
  TASKS = "/api/admin/tasks";
const isoDay = (date, offset) =>
  new Date(Date.parse(date + "T12:00:00Z") + offset * 86400000)
    .toISOString()
    .slice(0, 10);
test("admin working center uses actual actionable material threads, tasks, dates and current ownership", async (t) => {
  const f = await fixture();
  const [owner, other] = f.clients;
  let adminId, project, stage, materialId, v1, v2, createdTask;
  let inactiveProjects = [];
  let today = "2026-03-08";
  f.setNow("2026-03-08T07:30:00Z");
  const dashboard = (zone = "UTC") =>
    f.json(`${DASH}?timeZone=${encodeURIComponent(zone)}`, { cookie: f.admin });
  const tasks = (query = "") => f.json(TASKS + query, { cookie: f.admin });
  const createTask = (title, extra = {}, status = 201) =>
    f.mutate(
      TASKS,
      {
        title,
        description: "Внутренняя задача студии",
        projectId: project.id,
        stageId: stage.id,
        assigneeId: adminId,
        ...extra,
      },
      "POST",
      status,
    );
  const material = () =>
    f.json(`/api/materials/${materialId}`, { cookie: f.admin });
  const upload = (name, extra = {}) => {
    const [, type, bytes] = fixtures.find((row) => row[1] === "image/jpeg");
    return f.mutate(
      `/api/projects/${project.id}/files`,
      {
        name,
        contentType: type,
        data: bytes.toString("base64"),
        category: "result",
        stageId: stage.id,
        ...extra,
      },
      "POST",
      201,
    );
  };
  try {
    adminId = (await f.json("/api/me", { cookie: f.admin })).user.id;
    await t.test(
      "1. empty administrator dashboard and task list work without fabricated metrics",
      async () => {
        const d = await dashboard();
        for (const value of Object.values(d.counts)) assert.equal(value, 0);
        assert.deepEqual(d.attention, []);
        assert.deepEqual(d.waiting, []);
        assert.deepEqual((await tasks()).tasks, []);
        assert.equal(d.todayDate, today);
      },
    );
    await t.test(
      "2. clients anonymous and disabled sessions cannot read internal dashboard or task data",
      async () => {
        for (const cookie of [undefined, owner.cookie]) {
          const status = cookie ? 403 : 401;
          for (const path of [DASH, TASKS, TASKS + "/999999"])
            await f.json(path, { cookie }, status);
          await f.json(
            TASKS,
            { cookie, method: "POST", body: { title: "Недоступно" } },
            status,
          );
        }
        await f.mutate(`${AC}/${other.id}`, { isActive: false, confirm: true });
        await f.json(DASH, { cookie: other.cookie }, 401);
        await f.mutate(`${AC}/${other.id}`, { isActive: true, confirm: true });
        other.cookie = await f.login(other.email);
      },
    );
    await t.test(
      "3. active project count includes paused and new projects but excludes completed and archived",
      async () => {
        for (const status of ["Новый", "В работе", "На паузе", "Завершён"]) {
          const p = await f.mutate(
            "/api/projects",
            { title: "Проект " + status, clientId: owner.id, status },
            "POST",
            201,
          );
          if (status === "В работе") project = p;
          if (status === "Завершён") inactiveProjects.push(p.id);
        }
        const archived = await f.mutate(
          "/api/projects",
          { title: "Архивный проект", clientId: owner.id },
          "POST",
          201,
        );
        await f.mutate(`${AP}/${archived.id}`, {
          status: "Архив",
          confirm: true,
        });
        inactiveProjects.push(archived.id);
        assert.equal((await dashboard()).counts.activeProjects, 3);
        stage = await f.mutate(
          `/api/projects/${project.id}/stages`,
          { title: "Планировка", status: "in_progress", description: "" },
          "POST",
          201,
        );
      },
    );
    await t.test(
      "4. pending material appears only in the client-waiting queue and is initially unviewed",
      async () => {
        const file = await upload("Планировка-v1.jpg", { review: true });
        materialId = file.review.materialId;
        v1 = (await material()).material.currentVersion;
        const d = await dashboard();
        assert.equal(d.counts.pendingApproval, 1);
        assert.equal(d.counts.unviewedPending, 1);
        assert.equal(d.attention.length, 0);
        assert.equal(d.waiting[0].versionId, v1.id);
        assert.equal(d.waiting[0].viewed, false);
        assert.equal(d.waiting[0].projectId, project.id);
      },
    );
    await t.test(
      "5. view changes viewed-waiting state without inventing studio work or an agreement deadline",
      async () => {
        await f.json(`/api/material-versions/${v1.id}/view`, {
          cookie: owner.cookie,
          method: "POST",
          body: {},
        });
        const d = await dashboard();
        assert.equal(d.counts.pendingApproval, 1);
        assert.equal(d.counts.unviewedPending, 0);
        assert.equal(d.waiting[0].viewed, true);
        assert.ok(validDate(d.waiting[0].firstViewedAt));
        assert.equal("dueDate" in d.waiting[0], false);
        assert.equal(d.attention.length, 0);
      },
    );
    await t.test(
      "6. an unanswered client comment creates one version-specific attention thread",
      async () => {
        await f.json(`/api/material-versions/${v1.id}/comments`, {
          cookie: owner.cookie,
          method: "POST",
          body: { text: "Уточните проход" },
        });
        const d = await dashboard();
        assert.equal(d.counts.unansweredThreads, 1);
        assert.equal(d.attention.length, 1);
        assert.ok(d.attention[0].reasons.includes("unanswered_comment"));
        assert.equal(d.attention[0].lastClientMessage.body, "Уточните проход");
      },
    );
    await t.test(
      "7. reading a notification or detail does not silently answer a client thread",
      async () => {
        const list = await f.json("/api/notifications", { cookie: f.admin });
        const n = list.notifications.find((n) => n.materialId === materialId);
        await f.mutate(`/api/notifications/${n.id}/read`, {}, "POST");
        await material();
        assert.equal((await dashboard()).counts.unansweredThreads, 1);
      },
    );
    await t.test(
      "8. an administrator reply clears the unanswered thread and a later client message reopens it",
      async () => {
        await f.mutate(
          `/api/material-versions/${v1.id}/comments`,
          { text: "Ответ студии" },
          "POST",
        );
        assert.equal((await dashboard()).counts.unansweredThreads, 0);
        await f.json(`/api/material-versions/${v1.id}/comments`, {
          cookie: owner.cookie,
          method: "POST",
          body: { text: "Ещё один вопрос" },
        });
        assert.equal((await dashboard()).counts.unansweredThreads, 1);
      },
    );
    await t.test(
      "9. change requests and unanswered comments combine into one attention card while counters stay distinct",
      async () => {
        await f.json(`/api/material-versions/${v1.id}/decision`, {
          cookie: owner.cookie,
          method: "POST",
          body: {
            decision: "changes_requested",
            comment: "Расширить проход",
            expectedRevision: 0,
          },
        });
        const d = await dashboard();
        assert.equal(d.counts.changesRequested, 1);
        assert.equal(d.counts.unansweredThreads, 1);
        assert.equal(d.attention.length, 1);
        assert.deepEqual([...d.attention[0].reasons].sort(), [
          "changes_requested",
          "unanswered_comment",
        ]);
        assert.equal(d.waiting.length, 0);
      },
    );
    await t.test(
      "10. a new version clears old changes but does not pretend to answer the old-version message",
      async () => {
        await upload("Планировка-v2.jpg", {
          materialId,
          expectedVersionId: v1.id,
        });
        v2 = (await material()).material.currentVersion;
        const d = await dashboard();
        assert.equal(d.counts.changesRequested, 0);
        assert.equal(d.counts.pendingApproval, 1);
        assert.equal(d.counts.unviewedPending, 1);
        assert.equal(d.counts.unansweredThreads, 1);
        assert.equal(d.attention[0].versionId, v1.id);
        assert.equal(d.waiting[0].versionId, v2.id);
      },
    );
    await t.test(
      "11. an explicit old-version reply resolves the old thread and approval removes current waiting",
      async () => {
        await f.mutate(
          `/api/material-versions/${v1.id}/comments`,
          { text: "Уточнение предыдущей версии" },
          "POST",
        );
        await f.json(`/api/material-versions/${v2.id}/decision`, {
          cookie: owner.cookie,
          method: "POST",
          body: { decision: "approved", confirm: true, expectedRevision: 0 },
        });
        const d = await dashboard();
        assert.equal(d.counts.unansweredThreads, 0);
        assert.equal(d.waiting.length, 0);
        assert.equal(d.counts.pendingApproval, 0);
      },
    );
    await t.test(
      "12. task creation uses only actual project stage administrator and explicit date values",
      async () => {
        const answer = await createTask("Позвонить заказчику", {
          dueDate: today,
          priority: "high",
        });
        createdTask = answer.task;
        assert.equal(createdTask.projectId, project.id);
        assert.equal(createdTask.stageId, stage.id);
        assert.equal(createdTask.assigneeId, adminId);
        assert.equal(createdTask.revision, 0);
        assert.equal(createdTask.status, "todo");
        assert.equal(createdTask.dueDate, today);
        assert.ok(validDate(createdTask.createdAt));
        assert.equal((await dashboard()).counts.todayTasks, 1);
      },
    );
    await t.test(
      "13. task edits preserve metadata and reject stale revisions",
      async () => {
        const updated = await f.mutate(`${TASKS}/${createdTask.id}`, {
          title: "Позвонить и согласовать встречу",
          status: "in_progress",
          priority: "urgent",
          expectedRevision: 0,
        });
        assert.equal(updated.task.revision, 1);
        assert.equal(updated.task.status, "in_progress");
        await f.mutate(
          `${TASKS}/${createdTask.id}`,
          { title: "Устаревшая правка", expectedRevision: 0 },
          "PATCH",
          409,
        );
        const current = await f.json(`${TASKS}/${createdTask.id}`, {
          cookie: f.admin,
        });
        assert.equal(current.task.title, "Позвонить и согласовать встречу");
      },
    );
    await t.test(
      "14. completion and cancellation preserve task history and remove active deadline warnings",
      async () => {
        const done = await createTask("Выполненная просроченная", {
            dueDate: isoDay(today, -1),
          }),
          cancelled = await createTask("Отменённая просроченная", {
            dueDate: isoDay(today, -1),
          });
        await f.mutate(`${TASKS}/${done.task.id}`, {
          status: "completed",
          expectedRevision: 0,
        });
        await f.mutate(`${TASKS}/${cancelled.task.id}`, {
          status: "cancelled",
          expectedRevision: 0,
        });
        assert.equal((await dashboard()).counts.overdueTasks, 0);
        const p = await f.json(`${AP}/${project.id}`, { cookie: f.admin });
        assert.ok(p.events.some((e) => e.type === "task.completed"));
        assert.ok(p.events.some((e) => e.type === "task.cancelled"));
      },
    );
    await t.test(
      "15. absent due dates remain null and never become automatically overdue",
      async () => {
        const none = await createTask("Задача без срока", { stageId: null });
        assert.equal(none.task.dueDate, null);
        assert.equal(none.task.stageId, null);
        assert.equal(none.task.assigneeId, adminId);
        const result = await tasks("?deadline=none");
        assert.ok(result.tasks.some((t) => t.id === none.task.id));
      },
    );
    await t.test(
      "16. overdue and upcoming queues use calendar dates with tomorrow through day seven inclusive",
      async () => {
        const overdue = await createTask("Открытая просроченная", {
            dueDate: isoDay(today, -1),
          }),
          tomorrow = await createTask("Завтра", { dueDate: isoDay(today, 1) }),
          last = await createTask("Через семь дней", {
            dueDate: isoDay(today, 7),
          }),
          outside = await createTask("Через восемь дней", {
            dueDate: isoDay(today, 8),
          });
        const d = await dashboard();
        assert.equal(d.counts.overdueTasks, 1);
        assert.equal(d.counts.upcomingTasks, 2);
        assert.ok(d.overdue.tasks.some((t) => t.id === overdue.task.id));
        const upcoming = await tasks("?deadline=upcoming");
        assert.ok(upcoming.tasks.some((t) => t.id === tomorrow.task.id));
        assert.ok(upcoming.tasks.some((t) => t.id === last.task.id));
        assert.equal(
          upcoming.tasks.some((t) => t.id === outside.task.id),
          false,
        );
        assert.equal(
          upcoming.tasks.some((t) => t.id === createdTask.id),
          false,
        );
      },
    );
    await t.test(
      "17. task filters and search use real title project assignee status and priority values",
      async () => {
        for (const query of [
          `?search=${encodeURIComponent("Позвонить")}`,
          `?search=${encodeURIComponent("Проект В работе")}`,
          `?projectId=${project.id}&stageId=${stage.id}&assigneeId=${adminId}&status=in_progress&priority=urgent`,
        ])
          assert.ok(
            (await tasks(query)).tasks.some((t) => t.id === createdTask.id),
          );
        assert.deepEqual((await tasks("?search=never-match-this")).tasks, []);
        assert.ok(
          (await tasks("?status=completed")).tasks.some(
            (t) => t.status === "completed",
          ),
        );
      },
    );
    await t.test(
      "18. tasks reject invalid calendar dates foreign stages clients as assignees and unsupported fields",
      async () => {
        const foreignProject = await f.mutate(
            "/api/projects",
            { title: "Для проверки привязки", clientId: other.id },
            "POST",
            201,
          ),
          foreignStage = await f.mutate(
            `/api/projects/${foreignProject.id}/stages`,
            { title: "Другой этап", status: "planned", description: "" },
            "POST",
            201,
          );
        for (const extra of [
          { dueDate: "2026-02-30" },
          { dueDate: "2026-2-3" },
          { stageId: foreignStage.id },
          { assigneeId: owner.id },
          { status: "unknown" },
          { priority: "unknown" },
          { description: "x".repeat(4001) },
          { title: "" },
          { email: "not-an-allowed-field" },
        ])
          await createTask("Некорректная задача", extra, 400);
      },
    );
    await t.test(
      "19. task writes require administrator session same origin CSRF and do not support physical deletion",
      async () => {
        for (const cookie of [undefined, owner.cookie]) {
          const status = cookie ? 403 : 401;
          await f.json(`${TASKS}/${createdTask.id}`, { cookie }, status);
          await f.json(
            `${TASKS}/${createdTask.id}`,
            {
              cookie,
              method: "PATCH",
              body: { status: "completed", expectedRevision: 1 },
            },
            status,
          );
        }
        for (const options of [
          { csrf: false },
          { origin: "https://evil.example" },
        ])
          await f.json(
            TASKS,
            {
              cookie: f.admin,
              method: "POST",
              body: { title: "Forbidden", projectId: project.id },
              ...options,
            },
            403,
          );
        const response = await f.request(`${TASKS}/${createdTask.id}`, {
          cookie: f.admin,
          method: "DELETE",
          body: { confirm: true },
        });
        assert.ok([404, 405].includes(response.status));
        await response.arrayBuffer();
      },
    );
    await t.test(
      "20. stage dates are explicit nullable values with strict real calendar and ordered ranges",
      async () => {
        const previousStatus = (
          await f.json(`${AP}/${project.id}`, { cookie: f.admin })
        ).project.stages.find((s) => s.id === stage.id).status;
        for (const patch of [
          { startDate: "2026-02-30" },
          { plannedEndDate: "2026-03-07", startDate: "2026-03-08" },
          { plannedEndDate: "2026-3-8" },
        ])
          await f.mutate(`/api/stages/${stage.id}`, patch, "PATCH", 400);
        await f.mutate(`/api/stages/${stage.id}`, {
          startDate: "2026-03-01",
          plannedEndDate: "2026-03-07",
        });
        let p = (await f.json(`${AP}/${project.id}`, { cookie: f.admin }))
          .project;
        assert.equal(
          p.stages.find((s) => s.id === stage.id).status,
          previousStatus,
        );
        assert.equal(
          p.stages.find((s) => s.id === stage.id).startDate,
          "2026-03-01",
        );
        assert.equal(
          p.stages.find((s) => s.id === stage.id).plannedEndDate,
          "2026-03-07",
        );
        assert.ok(
          (await dashboard()).overdue.stages.some((s) => s.id === stage.id),
        );
        await f.mutate(`/api/stages/${stage.id}`, { status: "completed" });
        assert.equal(
          (await dashboard()).overdue.stages.some((s) => s.id === stage.id),
          false,
        );
        await f.mutate(`/api/stages/${stage.id}`, { status: previousStatus });
      },
    );
    await t.test(
      "21. stage date changes preserve files review history and record actual audit events",
      async () => {
        const before = await material();
        await f.mutate(`/api/stages/${stage.id}`, {
          startDate: null,
          plannedEndDate: null,
        });
        assert.deepEqual(await material(), before);
        const p = await f.json(`${AP}/${project.id}`, { cookie: f.admin });
        assert.ok(p.events.some((e) => e.type === "stage.dates_changed"));
        assert.equal(
          (await dashboard()).overdue.stages.some((s) => s.id === stage.id),
          false,
        );
      },
    );
    await t.test(
      "22. browser timezone decides today near UTC midnight instead of the host timezone",
      async () => {
        f.setNow("2026-03-09T00:30:00Z");
        const local = await dashboard("America/Los_Angeles"),
          utc = await dashboard("UTC");
        assert.equal(local.todayDate, "2026-03-08");
        assert.equal(utc.todayDate, "2026-03-09");
        assert.ok(local.today.tasks.some((t) => t.id === createdTask.id));
        assert.ok(utc.overdue.tasks.some((t) => t.id === createdTask.id));
        await f.json(
          `${DASH}?timeZone=Invalid/Timezone`,
          { cookie: f.admin },
          400,
        );
        f.setNow("2026-03-08T07:30:00Z");
      },
    );
    await t.test(
      "23. waiting days are local calendar days across a DST transition rather than elapsed24hours",
      async () => {
        const sent = Date.parse("2026-03-07T08:00:00Z");
        f.setNow(sent);
        const uploaded = await upload("Планировка-DST.jpg", {
          materialId,
          expectedVersionId: v2.id,
        });
        const version = uploaded.review.versionId;
        f.setNow("2026-03-08T07:30:00Z");
        const d = await dashboard("America/New_York");
        const row = d.waiting.find((v) => v.versionId === version);
        assert.equal(row.waitingDays, 1);
        assert.equal(row.viewed, false);
        assert.ok(Date.parse("2026-03-08T07:30:00Z") - sent < 86400000);
      },
    );
    await t.test(
      "24. current-owner view status resets after ownership transfer and old views remain in material history",
      async () => {
        const current = (await material()).material.currentVersion;
        await f.json(`/api/material-versions/${current.id}/view`, {
          cookie: owner.cookie,
          method: "POST",
          body: {},
        });
        assert.equal(
          (await dashboard()).waiting.find((v) => v.versionId === current.id)
            .viewed,
          true,
        );
        await f.mutate(
          `${AP}/${project.id}/assign`,
          { clientId: other.id, expectedClientId: owner.id, confirm: true },
          "POST",
        );
        assert.equal(
          (await dashboard()).waiting.find((v) => v.versionId === current.id)
            .viewed,
          false,
        );
        assert.ok(
          (await material()).material.currentVersion.views.some(
            (v) => v.userId === owner.id,
          ),
        );
      },
    );
    await t.test(
      "25. completed and archived projects never inflate active task material or stage deadlines",
      async () => {
        for (const id of inactiveProjects) {
          const s = await f.mutate(
            `/api/projects/${id}/stages`,
            {
              title: "Срок завершённого проекта",
              status: "in_progress",
              description: "",
              plannedEndDate: isoDay(today, -1),
            },
            "POST",
            201,
          );
          await f.mutate(
            TASKS,
            {
              title: "Задача неактивного проекта",
              projectId: id,
              stageId: s.id,
              assigneeId: adminId,
              dueDate: isoDay(today, -1),
            },
            "POST",
            201,
          );
          const [, type, bytes] = fixtures.find(
            (row) => row[1] === "image/png",
          );
          await f.mutate(
            `/api/projects/${id}/files`,
            {
              name: "inactive.png",
              contentType: type,
              data: bytes.toString("base64"),
              category: "result",
              stageId: s.id,
              review: true,
            },
            "POST",
            201,
          );
        }
        const d = await dashboard();
        for (const id of inactiveProjects) {
          assert.equal(
            d.waiting.some((r) => r.projectId === id),
            false,
          );
          assert.equal(
            d.overdue.tasks.some((r) => r.projectId === id),
            false,
          );
          assert.equal(
            d.overdue.stages.some((r) => r.projectId === id),
            false,
          );
          assert.equal(
            (await tasks()).tasks.some((r) => r.projectId === id),
            false,
          );
          assert.ok(
            (await tasks(`?projectId=${id}`)).tasks.some(
              (r) => r.projectId === id,
            ),
          );
          for (const deadline of ["overdue", "today", "upcoming"])
            assert.deepEqual(
              (await tasks(`?projectId=${id}&deadline=${deadline}`)).tasks,
              [],
              "Inactive project history never enters active deadline filters",
            );
        }
      },
    );
    await t.test(
      "26. archive hides working queues without changing task status metadata or material history and restoration brings them back",
      async () => {
        const before = await f.json(`${TASKS}/${createdTask.id}`, {
            cookie: f.admin,
          }),
          review = await material();
        await f.mutate(`${AP}/${project.id}`, {
          status: "Архив",
          confirm: true,
        });
        const d = await dashboard();
        assert.equal(
          d.waiting.some((r) => r.projectId === project.id),
          false,
        );
        assert.equal(
          (await tasks()).tasks.some((r) => r.projectId === project.id),
          false,
        );
        const archivedTask = await f.json(`${TASKS}/${createdTask.id}`, {
          cookie: f.admin,
        });
        assert.equal(archivedTask.task.projectStatus, "Архив");
        assert.deepEqual(
          { ...archivedTask.task, projectStatus: before.task.projectStatus },
          before.task,
        );
        assert.deepEqual(await material(), review);
        await f.mutate(
          `${AP}/${project.id}/restore`,
          { confirm: true },
          "POST",
        );
        assert.ok((await tasks()).tasks.some((r) => r.id === createdTask.id));
      },
    );
    await t.test(
      "27. client project responses never contain internal task data or internal dashboard context",
      async () => {
        const p = await f.json("/api/projects", { cookie: other.cookie });
        assert.equal(
          JSON.stringify(p).includes("Внутренняя задача студии"),
          false,
        );
        for (const project of p.projects)
          assert.equal("tasks" in project, false);
      },
    );
    await t.test(
      "28. task and stage dates audit and dashboard states survive restart",
      async () => {
        const before = await tasks();
        await f.restart();
        assert.deepEqual(await tasks(), before);
        assert.equal((await dashboard()).timeZone, "UTC");
      },
    );
    await t.test(
      "29. full backup and restore retain task revisions dates stage fields and project audit",
      async () => {
        const before = await tasks(),
          review = await material();
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
        await f.json("/api/me", { cookie: f.admin }, 401);
        f.admin = await f.login("admin@example.test");
        assert.deepEqual(await tasks(), before);
        assert.deepEqual(await material(), review);
      },
    );
  } finally {
    await f.close();
  }
});

test("additive workspace migration keeps previous projects files review history and old stage dates nullable", async () => {
  const f = await fixture();
  try {
    const project = await f.mutate(
        "/api/projects",
        { title: "Legacy workspace migration", clientId: f.clients[0].id },
        "POST",
        201,
      ),
      stage = await f.mutate(
        `/api/projects/${project.id}/stages`,
        {
          title: "Legacy stage",
          status: "in_progress",
          description: "Keep original",
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
        data: bytes.toString("base64"),
        category: "result",
        stageId: stage.id,
        review: true,
      },
      "POST",
      201,
    );
    await f.json(`/api/material-versions/${file.review.versionId}/view`, {
      cookie: f.clients[0].cookie,
      method: "POST",
      body: {},
    });
    await f.stop();
    let tables, before;
    // Only the new workspace table/columns are removed from this disposable fixture.
    const db = new DatabaseSync(join(f.dataDir, "itd.sqlite"));
    try {
      db.exec(
        "DROP TABLE admin_tasks; ALTER TABLE stages DROP COLUMN startDate; ALTER TABLE stages DROP COLUMN plannedEndDate;",
      );
      tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      before = Object.fromEntries(
        tables.map((table) => [
          table,
          db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ]),
      );
    } finally {
      db.close();
    }
    const settingsFile = join(f.root, "legacy-settings.json");
    const backup = await bindData(f.dataDir, {
      settingsFile,
      backupDestination: join(f.root, "backups"),
    });
    verifyBackup(backup.backupDir);
    const app = createApp({ storageOptions: { settingsFile } });
    await app.close();
    const migrated = new DatabaseSync(join(f.dataDir, "itd.sqlite"), {
      readOnly: true,
    });
    try {
      for (const table of tables) {
        const columns = Object.keys(before[table][0] || {});
        if (table === "stages")
          assert.deepEqual(
            migrated
              .prepare(
                "SELECT id,projectId,title,status,description FROM stages ORDER BY rowid",
              )
              .all(),
            before.stages,
          );
        else
          assert.deepEqual(
            migrated.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
            before[table],
          );
      }
      assert.equal(
        migrated.prepare("SELECT count(*) AS n FROM admin_tasks").get().n,
        0,
      );
      assert.ok(
        migrated
          .prepare("SELECT startDate,plannedEndDate FROM stages")
          .all()
          .every(
            (row) => row.startDate === null && row.plannedEndDate === null,
          ),
      );
    } finally {
      migrated.close();
    }
    const restored = join(f.root, "restored-legacy");
    restoreBackup(backup.backupDir, restored);
    await f.start(restored);
    await f.json("/api/me", { cookie: f.admin }, 401);
    f.admin = await f.login("admin@example.test");
    f.clients[0].cookie = await f.login(f.clients[0].email);
    const review = await f.json(`/api/materials/${file.review.materialId}`, {
      cookie: f.clients[0].cookie,
    });
    assert.equal(review.material.currentVersion.view.viewed, true);
    const response = await f.request(`/api/files/${file.id}/download`, {
      cookie: f.clients[0].cookie,
    });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    const data = await f.json(DASH, { cookie: f.admin });
    assert.equal(data.counts.openTasks, 0);
    assert.equal(data.counts.overdueStages, 0);
  } finally {
    await f.close();
  }
});

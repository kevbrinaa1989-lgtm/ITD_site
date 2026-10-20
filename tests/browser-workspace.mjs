import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp } from "../server.mjs";
import { fixtures } from "./preview-fixtures.mjs";
const { chromium } = await import(
  process.env.ITD_PLAYWRIGHT_MODULE || "playwright"
);
const root = await mkdtemp(join(tmpdir(), "itd-browser-workspace-")),
  password = randomBytes(24).toString("hex"),
  today = "2026-03-08";
let app, browser;
const shots = process.env.ITD_SCREENSHOT_DIR;
if (shots) await mkdir(shots, { recursive: true });
try {
  app = createApp({
    dataDir: join(root, "data"),
    adminEmail: "admin@example.test",
    adminPassword: password,
    workspaceNow: () => Date.parse("2026-03-09T00:30:00Z"),
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  async function api(
    path,
    { body, cookie, method = body ? "POST" : "GET", status = 200 } = {},
  ) {
    const r = await fetch(base + path, {
      method,
      headers: {
        Origin: base,
        "X-ITD-Request": "1",
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(r.status, status, path);
    return r.json();
  }
  const auth = await fetch(base + "/api/login", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@example.test", password }),
  });
  assert.equal(auth.status, 200);
  const adminCookie = auth.headers.get("set-cookie").split(";")[0];
  await auth.json();
  const adminId = (await api("/api/me", { cookie: adminCookie })).user.id;
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 768, height: 1024 },
    { width: 430, height: 932 },
    { width: 375, height: 812 },
  ]) {
    const email = `owner${viewport.width}@example.test`;
    const { user: owner } = await api("/api/register", {
      body: { name: "Анна · демонстрация", email, password },
      status: 201,
    });
    const ownerLogin = await fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const ownerCookie = ownerLogin.headers.get("set-cookie").split(";")[0];
    await ownerLogin.json();
    const title = `Интерьер · рабочий центр ${viewport.width}`,
      project = await api("/api/projects", {
        cookie: adminCookie,
        body: { title, clientId: owner.id, status: "В работе" },
        status: 201,
      }),
      stage = await api(`/api/projects/${project.id}/stages`, {
        cookie: adminCookie,
        body: {
          title: "Планировка со сроком",
          status: "in_progress",
          description: "Материалы",
          startDate: "2026-03-01",
          plannedEndDate: "2026-03-07",
        },
        status: 201,
      });
    const [, type, bytes] = fixtures.find((f) => f[1] === "image/jpeg");
    const upload = (name, extra = {}) =>
      api(`/api/projects/${project.id}/files`, {
        cookie: adminCookie,
        body: {
          name,
          contentType: type,
          data: bytes.toString("base64"),
          category: "result",
          stageId: stage.id,
          ...extra,
        },
        status: 201,
      });
    const initial = await upload("Планировка-v1.jpg", { review: true }),
      mid = initial.review.materialId,
      v1 = initial.review.versionId;
    const clientComment =
      "<script>window.__workspaceXSS=true</script> Уточните проход у кухни";
    await api(`/api/material-versions/${v1}/comments`, {
      cookie: ownerCookie,
      body: { text: clientComment },
    });
    const next = await upload("Планировка-v2.jpg", {
      materialId: mid,
      expectedVersionId: v1,
    });
    const viewed = await upload("Концепция.jpg", { review: true });
    await api(`/api/material-versions/${viewed.review.versionId}/view`, {
      cookie: ownerCookie,
      body: {},
    });
    const changes = await upload("Материал с замечаниями.jpg", {
      review: true,
    });
    await api(`/api/material-versions/${changes.review.versionId}/decision`, {
      cookie: ownerCookie,
      body: {
        decision: "changes_requested",
        comment: "Поменять материал стены",
        expectedRevision: 0,
      },
    });
    async function seedTask(name, extra = {}) {
      return (
        await api("/api/admin/tasks", {
          cookie: adminCookie,
          body: {
            title: name,
            description: "Внутренняя заметка студии",
            projectId: project.id,
            stageId: stage.id,
            assigneeId: adminId,
            ...extra,
          },
          status: 201,
        })
      ).task;
    }
    const late = await seedTask(`Проверить чертежи ${viewport.width}`, {
      dueDate: "2026-03-07",
      priority: "high",
    });
    await seedTask(`Заказать образцы ${viewport.width}`, {
      dueDate: "2026-03-08",
    });
    await seedTask(`Встреча через неделю ${viewport.width}`, {
      dueDate: "2026-03-15",
    });
    await seedTask(`Без срока ${viewport.width}`, { dueDate: null });
    const done = await seedTask(`Выполнено ${viewport.width}`, {
      dueDate: "2026-03-07",
    });
    await api(`/api/admin/tasks/${done.id}`, {
      cookie: adminCookie,
      method: "PATCH",
      body: { status: "completed", expectedRevision: 0 },
    });
    const contexts = [],
      errors = [],
      external = [],
      workspaceQueries = [];
    async function pageFor() {
      const c = await browser.newContext({
        viewport,
        timezoneId: "America/Los_Angeles",
      });
      contexts.push(c);
      await c.route("**/*", (route) => {
        const url = route.request().url();
        if (/^https?:/.test(url) && !url.startsWith(base + "/")) {
          external.push(url);
          return route.abort();
        }
        return route.continue();
      });
      const p = await c.newPage();
      p.setDefaultTimeout(12000);
      p.on("pageerror", (e) => errors.push(e.message));
      p.on("request", (r) => {
        if (r.url().includes("/api/admin/workspace"))
          workspaceQueries.push(r.url());
      });
      await p.goto(base + "/cabinet");
      return p;
    }
    async function signIn(p, email) {
      await p.locator("#login-email").fill(email);
      await p.locator("#login-password").fill(password);
      await p.locator("#login-form button[type=submit]").click();
      await p.locator("#app-view").waitFor({ state: "visible" });
    }
    async function dashboard(p) {
      await p.locator("#tab-workspace").click();
      await p.waitForFunction(
        () =>
          document.querySelectorAll("#workspace-metrics [data-metric]")
            .length === 6 &&
          !document
            .querySelector("#workspace-message")
            .textContent.includes("Загрузка"),
      );
    }
    async function filterProject(p) {
      await p
        .locator("#workspace-project-filter")
        .selectOption(String(project.id));
    }
    async function shot(p, name) {
      assert.ok(
        await p.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `${name}/${viewport.width}: no horizontal overflow`,
      );
      if (shots) {
        await p.screenshot({
          path: join(shots, `workspace-${name}-${viewport.width}.png`),
          fullPage: true,
        });
        if (
          viewport.width === 375 &&
          ["dashboard", "task-editor"].includes(name)
        )
          await p.screenshot({
            path: join(shots, `workspace-${name}-375-viewport.png`),
          });
      }
    }
    async function taskFilters(p, values = {}) {
      for (const [id, value] of Object.entries(values))
        await p.locator("#" + id).selectOption(value);
      const response = p.waitForResponse((r) =>
        r.url().includes("/api/admin/tasks?"),
      );
      await p.locator("#task-filter-form button[type=submit]").click();
      await response;
      await p.waitForFunction(
        () =>
          !document
            .querySelector("#task-message")
            .textContent.includes("Загрузка"),
      );
    }
    const admin = await pageFor();
    await signIn(admin, "admin@example.test");
    assert.equal(
      await admin.locator("#tab-workspace").getAttribute("aria-selected"),
      "true",
    );
    await dashboard(admin);
    await filterProject(admin);
    assert.ok(
      workspaceQueries.some(
        (url) =>
          new URL(url).searchParams.get("timeZone") === "America/Los_Angeles",
      ),
    );
    assert.ok(
      (await admin.locator("#workspace-calendar").textContent()).includes(
        "America/Los_Angeles",
      ),
    );
    const expected = await api(
      "/api/admin/workspace?timeZone=America%2FLos_Angeles",
      { cookie: adminCookie },
    );
    for (const key of [
      "activeProjects",
      "pendingApproval",
      "changesRequested",
      "unansweredThreads",
      "todayTasks",
      "overdueTasks",
    ])
      assert.equal(
        await admin.locator(`[data-metric="${key}"] strong`).textContent(),
        String(expected.counts[key]),
      );
    assert.equal(await admin.evaluate(() => window.__workspaceXSS), undefined);
    assert.equal(await admin.locator("#workspace-attention script").count(), 0);
    assert.ok(
      (await admin.locator("#workspace-attention").textContent()).includes(
        clientComment,
      ),
    );
    assert.equal(
      await admin
        .locator("#workspace-waiting .workspace-attention-card")
        .count(),
      2,
    );
    assert.ok(
      (await admin.locator("#workspace-waiting").textContent()).includes(
        "Не просмотрено клиентом",
      ),
    );
    assert.ok(
      (await admin.locator("#workspace-waiting").textContent()).includes(
        "Просмотрено клиентом",
      ),
    );
    await shot(admin, "dashboard");
    await admin
      .locator("#workspace-type-filter")
      .selectOption("unanswered_comment");
    const oldThread = admin
      .locator(
        "#workspace-attention > .workspace-section .workspace-attention-card",
      )
      .filter({ hasText: "Планировка-v1.jpg" });
    await oldThread
      .getByRole("button", { name: "Открыть материал →", exact: true })
      .click();
    await admin.waitForFunction(
      (id) =>
        document.querySelector("#review-version-select")?.value === String(id),
      v1,
    );
    assert.equal(await admin.locator("#project-title").textContent(), title);
    await admin.locator("#review-material-detail .review-warning").waitFor();
    assert.equal(
      (await api("/api/admin/workspace", { cookie: adminCookie })).counts
        .unansweredThreads,
      expected.counts.unansweredThreads,
    );
    await dashboard(admin);
    await filterProject(admin);
    await admin.locator("#workspace-type-filter").selectOption("");
    const stageCard = admin
      .locator("#workspace-deadlines .workspace-attention-card")
      .filter({ hasText: "Планировка со сроком" })
      .filter({
        has: admin.getByRole("button", { name: "Открыть этап →", exact: true }),
      })
      .filter({ hasText: title });
    await stageCard
      .getByRole("button", { name: "Открыть этап →", exact: true })
      .click();
    await admin.locator(`#stage-list [data-stage-id="${stage.id}"]`).waitFor();
    assert.equal(
      await admin.locator("#tab-stages").getAttribute("aria-selected"),
      "true",
    );
    assert.equal(await admin.locator("#project-title").textContent(), title);
    await dashboard(admin);
    await admin.locator("[data-metric=todayTasks]").click();
    await admin.locator("#task-preset").waitFor();
    assert.equal(await admin.locator("#task-preset").inputValue(), "today");
    await taskFilters(admin, { "task-project-filter": String(project.id) });
    assert.equal(
      await admin.locator("#task-list .workspace-task-card").count(),
      1,
    );
    await shot(admin, "today-tasks");
    await admin.locator("#task-new-button").click();
    await admin.locator("#task-edit-form").waitFor();
    const newTitle = `Согласовать встречу <script>текст</script> ${viewport.width}`;
    await admin.locator("#task-edit-form input[name=title]").fill(newTitle);
    await admin
      .locator("#task-edit-form textarea[name=description]")
      .fill("Внутренний текст задачи, не показываемый клиенту.");
    await admin
      .locator("#task-edit-form select[name=projectId]")
      .selectOption(String(project.id));
    await admin
      .locator("#task-edit-form select[name=stageId]")
      .selectOption(String(stage.id));
    await admin
      .locator("#task-edit-form select[name=assigneeId]")
      .selectOption(String(adminId));
    assert.equal(
      await admin.locator("#task-edit-form input[name=dueDate]").inputValue(),
      "",
    );
    await admin.locator("#task-edit-form input[name=dueDate]").fill(today);
    await admin
      .locator("#task-edit-form select[name=priority]")
      .selectOption("urgent");
    const createdResponse = admin.waitForResponse(
      (r) =>
        r.url().endsWith("/api/admin/tasks") && r.request().method() === "POST",
    );
    await admin
      .getByRole("button", { name: "Создать задачу", exact: true })
      .click();
    const created = (await (await createdResponse).json()).task;
    await admin.waitForFunction(
      (text) => document.querySelector("#task-detail h3")?.textContent === text,
      newTitle,
    );
    assert.equal(await admin.locator("#task-detail script").count(), 0);
    await shot(admin, "task-editor");
    await admin
      .locator("#task-edit-form input[name=title]")
      .fill("Несохранённое изменение");
    await admin
      .locator("#task-edit-form")
      .getByRole("button", { name: "Отмена", exact: true })
      .click();
    assert.equal(
      (await api(`/api/admin/tasks/${created.id}`, { cookie: adminCookie }))
        .task.title,
      newTitle,
    );
    await taskFilters(admin, { "task-preset": "active" });
    await admin
      .locator(`#task-list [data-task-id="${created.id}"]`)
      .getByRole("button", { name: "Открыть карточку →", exact: true })
      .click();
    await admin.locator("#task-edit-form").waitFor();
    await api(`/api/admin/tasks/${created.id}`, {
      cookie: adminCookie,
      method: "PATCH",
      body: {
        description: "Сохранено другим сотрудником",
        expectedRevision: 0,
      },
    });
    await admin
      .locator("#task-edit-form input[name=title]")
      .fill("Устаревшая правка");
    await admin
      .getByRole("button", { name: "Сохранить задачу", exact: true })
      .click();
    await admin.waitForFunction(() =>
      document
        .querySelector("#task-message")
        .textContent.includes("Задача уже изменилась"),
    );
    assert.equal(
      await admin.locator("#task-edit-form input[name=title]").inputValue(),
      newTitle,
    );
    assert.equal(
      await admin
        .locator("#task-edit-form textarea[name=description]")
        .inputValue(),
      "Сохранено другим сотрудником",
    );
    await admin
      .locator("#task-edit-form select[name=status]")
      .selectOption("in_progress");
    await admin.locator("#task-edit-form input[name=dueDate]").fill("");
    await admin
      .getByRole("button", { name: "Сохранить задачу", exact: true })
      .click();
    await admin.waitForFunction(
      () =>
        document.querySelector("#task-message").textContent ===
        "Задача обновлена.",
    );
    assert.equal(
      (await api(`/api/admin/tasks/${created.id}`, { cookie: adminCookie }))
        .task.dueDate,
      null,
    );
    await admin
      .locator("#task-edit-form select[name=status]")
      .selectOption("completed");
    await admin
      .getByRole("button", { name: "Сохранить задачу", exact: true })
      .click();
    await admin.waitForFunction(
      () =>
        document.querySelector("#task-message").textContent ===
        "Задача обновлена.",
    );
    await taskFilters(admin, { "task-preset": "completed" });
    await admin.locator(`#task-list [data-task-id="${created.id}"]`).waitFor();
    assert.equal(
      await admin
        .locator(`#task-list [data-task-id="${created.id}"] .deadline-warning`)
        .count(),
      0,
    );
    await admin
      .locator(`#task-list [data-task-id="${created.id}"]`)
      .getByRole("button", { name: "Открыть карточку →", exact: true })
      .click();
    await admin
      .locator("#task-edit-form select[name=status]")
      .selectOption("cancelled");
    await admin
      .getByRole("button", { name: "Сохранить задачу", exact: true })
      .click();
    await admin.waitForFunction(
      () =>
        document.querySelector("#task-message").textContent ===
        "Задача обновлена.",
    );
    await taskFilters(admin, { "task-preset": "active" });
    assert.equal(
      await admin.locator(`#task-list [data-task-id="${created.id}"]`).count(),
      0,
    );
    await admin
      .locator("#task-search")
      .fill(`Проверить чертежи ${viewport.width}`);
    await taskFilters(admin, { "task-preset": "overdue" });
    assert.equal(
      await admin.locator("#task-list .workspace-task-card").count(),
      1,
    );
    await admin
      .locator(`#task-list [data-task-id="${late.id}"] .deadline-warning`)
      .waitFor();
    await shot(admin, "overdue");
    await admin.locator("#task-search").fill("never-find-this");
    await taskFilters(admin);
    await admin
      .getByText("По выбранным условиям задач нет.", { exact: true })
      .waitFor();
    await admin.locator("#task-search").fill("");
    await taskFilters(admin, { "task-preset": "mine" });
    assert.ok(
      (await admin.locator("#task-list .workspace-task-card").count()) > 0,
    );
    await taskFilters(admin, { "task-preset": "nodue" });
    assert.ok(
      (await admin.locator("#task-list").textContent()).includes("Без срока"),
    );
    await dashboard(admin);
    await filterProject(admin);
    for (const [target, key] of [
      ["Клиенты →", "clients"],
      ["Открыть проекты →", "projects"],
      ["Запросы на восстановление →", "recovery"],
      ["Создать проект →", "management"],
    ]) {
      await admin
        .locator(".workspace-quick-actions")
        .getByRole("button", { name: target, exact: true })
        .click();
      assert.equal(
        await admin.locator(`#tab-${key}`).getAttribute("aria-selected"),
        "true",
      );
      if (key === "management") {
        await admin
          .locator("#create-project-form")
          .waitFor({ state: "visible" });
        assert.equal(
          await admin
            .locator("#create-project-form")
            .locator("..")
            .evaluate((el) => el.open),
          true,
        );
        assert.equal(
          await admin
            .locator('#create-project-form input[name="title"]')
            .evaluate((el) => document.activeElement === el),
          true,
        );
      }
      await dashboard(admin);
    }
    await admin
      .locator("#project-list button")
      .filter({ hasText: title })
      .click();
    await admin.locator("#tab-management").click();
    const addDetails = admin.locator("#add-stage-form").locator("..");
    if (await addDetails.evaluate((e) => e.tagName === "DETAILS" && !e.open))
      await addDetails.locator("summary").click();
    await admin.locator("#stage-title").fill("Этап с проверенными датами");
    await admin.locator("#stage-start-date").fill("2026-03-10");
    await admin.locator("#stage-end-date").fill("2026-03-09");
    await admin.locator("#add-stage-form button[type=submit]").click();
    await admin.waitForFunction(() =>
      document.querySelector("#status-message").textContent.includes("раньше"),
    );
    await admin.locator("#stage-end-date").fill("2026-03-15");
    await admin.locator("#add-stage-form button[type=submit]").click();
    await admin.waitForFunction(
      () =>
        document.querySelector("#status-message").textContent ===
        "Этап добавлен",
    );
    await admin.locator("#tab-stages").click();
    const datesStage = admin
      .locator("#stage-list .stage-card")
      .filter({ hasText: "Этап с проверенными датами" });
    await datesStage.waitFor();
    assert.ok((await datesStage.textContent()).includes("15.03.2026"));
    await shot(admin, "stage-dates");
    await api(`/api/admin/projects/${project.id}`, {
      cookie: adminCookie,
      method: "PATCH",
      body: { status: "Архив", confirm: true },
    });
    await dashboard(admin);
    assert.equal(
      await admin
        .locator(`#workspace-project-filter option[value="${project.id}"]`)
        .count(),
      0,
    );
    assert.equal(
      await admin
        .locator("#workspace-waiting .workspace-attention-card")
        .filter({ hasText: title })
        .count(),
      0,
    );
    assert.equal(
      await admin
        .locator("#workspace-attention .workspace-attention-card")
        .filter({ hasText: title })
        .count(),
      0,
    );
    await admin.locator("#tab-tasks").click();
    await admin
      .locator("#task-search")
      .fill(`Проверить чертежи ${viewport.width}`);
    await taskFilters(admin, {
      "task-project-filter": "",
      "task-preset": "active",
    });
    assert.equal(
      await admin.locator(`#task-list [data-task-id="${late.id}"]`).count(),
      0,
    );
    await taskFilters(admin, { "task-project-filter": String(project.id) });
    await admin.locator(`#task-list [data-task-id="${late.id}"]`).waitFor();
    assert.equal(
      await admin
        .locator(`#task-list [data-task-id="${late.id}"] .deadline-warning`)
        .count(),
      0,
      "Archived history task is not shown as overdue",
    );
    await taskFilters(admin, { "task-preset": "overdue" });
    assert.equal(
      await admin.locator(`#task-list [data-task-id="${late.id}"]`).count(),
      0,
    );
    await taskFilters(admin, { "task-preset": "active" });
    await api(`/api/admin/projects/${project.id}/restore`, {
      cookie: adminCookie,
      body: { confirm: true },
    });
    await taskFilters(admin, { "task-project-filter": "" });
    await admin.locator(`#task-list [data-task-id="${late.id}"]`).waitFor();
    const client = await pageFor();
    await signIn(client, email);
    assert.equal(await client.locator("#tab-workspace").isVisible(), false);
    assert.equal(await client.locator("#tab-tasks").isVisible(), false);
    assert.equal(
      (
        await client.context().request.get(base + "/api/admin/workspace")
      ).status(),
      403,
    );
    assert.equal(
      (await client.context().request.get(base + "/api/admin/tasks")).status(),
      403,
    );
    await client.locator("#tab-stages").click();
    await client
      .locator("#stage-list")
      .getByRole("heading", { name: "Этап с проверенными датами", exact: true })
      .waitFor();
    assert.equal(
      (await client.locator("#app-view").textContent()).includes(
        "Внутренний текст задачи",
      ),
      false,
    );
    await shot(client, "client-dates");
    await admin.locator("#logout-button").click();
    await admin.locator("#login-form").waitFor({ state: "visible" });
    assert.equal(await admin.locator("#task-detail").textContent(), "");
    assert.equal(await admin.locator("#workspace-metrics").textContent(), "");
    assert.equal(
      (await admin.context().request.get(base + "/api/admin/tasks")).status(),
      401,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    for (const context of contexts) await context.close();
    console.log(
      `Workspace browser ${viewport.width}px: real default dashboard, waiting vs studio work, old-version/stage/task deep navigation, CRUD/CAS/filters/search/dates/archive, client privacy and responsive layout PASS`,
    );
  }
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

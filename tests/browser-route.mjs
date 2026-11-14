import assert from "node:assert/strict";
import { mkdtemp, readFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createApp } from "../server.mjs";
import { fixtures } from "./preview-fixtures.mjs";
import { prepareFixtureUpload } from "./upload-fixture.mjs";
import { openGlobal, openProject, openFiles } from "./browser-navigation.mjs";
const { chromium } = await import(
  process.env.ITD_PLAYWRIGHT_MODULE || "playwright"
);
const root = await mkdtemp(join(tmpdir(), "itd-route-qa-"));
const password = randomBytes(24).toString("hex");
let app, browser;
const shots = process.env.ITD_SCREENSHOT_DIR;
const results = [];
try {
  app = createApp({
    dataDir: join(root, "data"),
    adminEmail: "studio@example.test",
    adminPassword: password,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function login(email) {
    const r = await fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(r.status, 200);
    return r.headers.get("set-cookie").split(";")[0];
  }
  const cookie = await login("studio@example.test");
  async function api(
    path,
    body,
    method = body ? "POST" : "GET",
    auth = cookie,
  ) {
    body = await prepareFixtureUpload(base, path, body, auth, method);
    const r = await fetch(base + path, {
      method,
      headers: {
        Origin: base,
        "X-ITD-Request": "1",
        "Content-Type": "application/json",
        Cookie: auth,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await r.json();
    assert.ok(r.ok, `${path}: ${JSON.stringify(data)}`);
    return data;
  }
  const { user } = await api("/api/register", {
    name: "Мария Соколова",
    email: "client@example.test",
    password,
  });
  const clientCookie = await login("client@example.test");
  const { user: admin } = await api("/api/me");
  const projects = [];
  for (const title of [
    "Квартира у парка",
    "Дом в соснах",
    "Студия на набережной",
  ]) {
    const p = await api("/api/projects", {
      title,
      clientId: user.id,
      status: "В работе",
    });
    projects.push(p);
    for (const [title, status] of [
      ["Знакомство", "completed"],
      ["Планировка", "completed"],
      ["Концепция", "completed"],
      ["Визуализации", "pending_approval"],
      ["Рабочая документация", "in_progress"],
    ]) {
      const stage = await api(`/api/projects/${p.id}/stages`, {
        title,
        status,
        description: "Согласуем свет, материалы и композицию пространства.",
        startDate: "2026-11-01",
        plannedEndDate: "2026-11-18",
      });
      if (title === "Визуализации") p.stage = stage;
    }
  }
  const project = projects[0],
    pdf = fixtures.find((f) => f[1] === "application/pdf");
  const photo = process.env.ITD_BROWSER_IMAGE
    ? [
        "Визуализация.webp",
        "image/webp",
        await readFile(process.env.ITD_BROWSER_IMAGE),
      ]
    : fixtures.find((f) => f[1] === "image/jpeg");
  const upload = (name, type, bytes, extra = {}) =>
    api(`/api/projects/${project.id}/files`, {
      name,
      contentType: type,
      data: bytes.toString("base64"),
      category: "result",
      stageId: project.stage.id,
      ...extra,
    });
  const old = await upload("Гостиная-v1.pdf", pdf[1], pdf[2], { review: true });
  let current = await upload(photo[0], photo[1], photo[2], {
    materialId: old.review.materialId,
    expectedVersionId: old.review.versionId,
  });
  const second = await upload(
    "Спальня" + (photo[1] === "image/webp" ? ".webp" : ".jpg"),
    photo[1],
    photo[2],
    { review: true },
  );
  await upload("Договор.pdf", pdf[1], pdf[2], { category: "document" });
  await api(`/api/material-versions/${current.review.versionId}/comments`, {
    text: "Обновила расположение светильников. Посмотрите, всё ли вам подходит.",
  });
  await api(
    `/api/material-versions/${current.review.versionId}/comments`,
    { text: "Уточните, пожалуйста, оттенок подсветки у дивана." },
    "POST",
    clientCookie,
  );
  for (const [i, title, dueDate] of [
    [1, "Обновить подборку отделки", "2026-11-09"],
    [0, "Ответить на комментарий заказчика", "2026-11-10"],
    [2, "Проверить комплект чертежей", "2026-11-18"],
  ])
    await api("/api/admin/tasks", {
      title,
      description: "Задача студии",
      projectId: projects[i].id,
      assigneeId: admin.id,
      dueDate,
      priority: "normal",
    });
  if (shots) await mkdir(shots, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  for (const width of (process.env.ITD_TEST_WIDTHS || "360,390,768,1024,1440")
    .split(",")
    .map(Number)) {
    const errors = [],
      external = [];
    const context = await browser.newContext({
      viewport: { width, height: width < 768 ? 844 : 1000 },
      hasTouch: true,
    });
    await context.route("**/*", (r) => {
      if (
        /^https?:/.test(r.request().url()) &&
        !r
          .request()
          .url()
          .startsWith(base + "/")
      ) {
        external.push(r.request().url());
        return r.abort();
      }
      return r.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", (e) => errors.push(e.message));
    async function signIn(email) {
      await page.goto(base + "/cabinet");
      await page.locator("#login-email").fill(email);
      await page.locator("#login-password").fill(password);
      await page.locator("#login-form .primary").click();
      await page.locator("#app-view").waitFor({ state: "visible" });
      if (shots)
        await page.waitForFunction(
          () => !document.querySelector("#status-message").textContent,
        );
    }
    async function capture(name, fullPage = true) {
      await page.evaluate(() => document.fonts.ready);
      if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `${name}/${width} document overflow`,
      );
      if (shots)
        await page.screenshot({
          path: join(shots, `${name}-${width}.png`),
          fullPage,
        });
      if (shots && ["admin", "client", "approval", "gallery"].includes(name))
        await page.screenshot({
          path: join(shots, `${name}-viewport-${width}.png`),
          fullPage: false,
        });
    }
    await signIn("studio@example.test");
    await page
      .locator("#workspace-task-queue .workspace-task-card")
      .first()
      .waitFor();
    await capture("admin");
    for (const section of [
      "projects",
      "clients",
      "tasks",
      "recovery",
      "notifications",
    ]) {
      await openGlobal(page, section);
      await capture("admin-" + section);
    }
    await openProject(page, project.id);
    for (const tab of ["overview", "settings", "documents"]) {
      if (tab === "documents")
        await openFiles(page, "document", { stageIndex: 3 });
      else await page.locator("#tab-" + tab).click();
      await capture("admin-" + tab);
    }
    await page.locator("#logout-button").click();
    await signIn("client@example.test");
    await page.locator(".route-feature").first().waitFor();
    await capture("client");
    for (const section of [
      "client-projects",
      "client-review",
      "profile",
      "notifications",
    ]) {
      await openGlobal(page, section);
      await capture(section);
    }
    await openProject(page, project.id, { client: true });
    await openFiles(page, "result", { album: true, stageIndex: 3 });
    await page.locator(".album-hero-media img").waitFor();
    await page.waitForFunction(
      () => document.querySelector(".album-hero-media img")?.naturalWidth > 0,
    );
    const firstImage = await page
      .locator(".album-hero-media img")
      .getAttribute("alt");
    await page.locator(".album-next").click();
    assert.notEqual(
      await page.locator(".album-hero-media img").getAttribute("alt"),
      firstImage,
    );
    await page.locator(".album-prev").click();
    await capture("gallery");
    await page.locator("#tab-review").click();
    if (width < 768)
      await page
        .locator(".ac-mobile-tools")
        .getByRole("button", { name: "Материалы", exact: true })
        .click();
    await page
      .locator(
        `.ac-material[data-material-id="${old.review.materialId}"] .ac-material-open`,
      )
      .click();
    await page.getByText("Изображение загружено", { exact: true }).waitFor();
    assert.ok(
      (await page.locator(".ac-view-heading p").textContent()).includes(
        photo[0],
      ),
    );
    await capture("approval");
    const notes = async () => {
      if (width < 768)
        await page
          .locator(".ac-mobile-tools")
          .getByRole("button", { name: "Замечания и решение", exact: true })
          .click();
    };
    const view = async () => {
      if (width < 768)
        await page
          .locator(".ac-mobile-tools")
          .getByRole("button", { name: "Просмотр", exact: true })
          .click();
    };
    await notes();
    const draftText = "Черновик: уточнить оттенок " + width;
    const failDraft = "**/api/approval-center/projects/*/stages/*/draft";
    await page.route(failDraft, (r) =>
      r.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Временно недоступно" }),
      }),
    );
    await page
      .getByLabel("Пояснение дизайнеру", { exact: true })
      .fill(draftText);
    await page
      .getByRole("button", { name: "Сохранить сейчас", exact: true })
      .click();
    await page
      .getByText("Не сохранено — повторите сохранение", { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByLabel("Пояснение дизайнеру", { exact: true })
        .inputValue(),
      draftText,
    );
    await page.unroute(failDraft);
    await page
      .getByRole("button", { name: "Сохранить сейчас", exact: true })
      .click();
    await page
      .getByText("Черновик сохранён на сервере", { exact: true })
      .waitFor();
    await view();
    await page
      .getByLabel("Версия", { exact: true })
      .selectOption(String(old.review.versionId));
    await page.locator(".ac-sheet canvas").waitFor();
    await notes();
    await page
      .getByText(
        "Историческая версия — только просмотр. Решение по ней сохранено.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await page.locator(".ac-decisions").count(), 0);
    await capture("history-pdf");
    await page
      .getByRole("button", { name: "К текущей версии", exact: true })
      .click();
    await notes();
    assert.equal(
      await page
        .getByLabel("Пояснение дизайнеру", { exact: true })
        .inputValue(),
      draftText,
    );
    const failRoute = `**/api/material-versions/${current.review.versionId}/comments`;
    await page
      .getByLabel("Комментарий к версии", { exact: true })
      .fill(draftText);
    await page.route(failRoute, (r) =>
      r.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Временно недоступно" }),
      }),
    );
    await page
      .getByRole("button", {
        name: "Отправить комментарий сейчас",
        exact: true,
      })
      .click();
    await page
      .locator(".ac-notice")
      .filter({ hasText: "Временно недоступно" })
      .waitFor();
    assert.equal(
      await page
        .getByLabel("Комментарий к версии", { exact: true })
        .inputValue(),
      draftText,
    );
    await page.unroute(failRoute);
    await page
      .getByRole("button", {
        name: "Отправить комментарий сейчас",
        exact: true,
      })
      .click();
    await page
      .getByText("Комментарий отправлен и сохранён в истории", { exact: true })
      .waitFor();
    assert.ok(
      (await api(`/api/materials/${old.review.materialId}`)).events.some(
        (e) => e.body === draftText,
      ),
    );
    assert.equal(
      await page
        .getByLabel("Комментарий к версии", { exact: true })
        .inputValue(),
      "",
    );
    page.on("dialog", (d) => d.accept());
    await page.reload();
    await openProject(page, project.id, { client: true });
    await page.locator("#tab-review").click();
    await page.locator(".ac-view-heading").waitFor();
    await notes();
    assert.equal(
      await page
        .getByLabel("Пояснение дизайнеру", { exact: true })
        .inputValue(),
      draftText,
    );
    await page
      .getByText("Комментарии и история решений", { exact: true })
      .click();
    await page
      .locator(".ac-rail")
      .getByText(draftText, { exact: false })
      .waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    results.push({
      width,
      admin: true,
      client: true,
      album: true,
      formats: true,
      drafts: true,
      persistence: true,
      noOverflow: true,
      noExternalRequests: true,
    });
    console.log(
      `Route ${width}px: admin/client sections, album, selected PDF/image version, mobile actions/discussion, failed/successful comments, per-version drafts and reload persistence PASS`,
    );
    await context.close();
  }
  if (shots)
    await writeFile(
      join(shots, "route-results.json"),
      JSON.stringify(results, null, 2) + "\n",
    );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

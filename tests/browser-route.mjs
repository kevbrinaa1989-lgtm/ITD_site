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
    await page
      .locator(
        `#review-material-list [data-material-id="${old.review.materialId}"] .review-open-button`,
      )
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".material-preview")?.dataset.loaded === "true",
    );
    assert.equal(
      await page.locator(".review-actual-file").textContent(),
      photo[0],
    );
    await capture("approval");
    if (width < 768) {
      const box = await page.locator(".review-decision-actions").boundingBox();
      assert.ok(
        box.y + box.height <= 844 + 1 && box.y > 600,
        "fixed decisions in viewport",
      );
      assert.equal(await page.locator("#mobile-bottom-nav").isVisible(), false);
      await page
        .getByRole("button", { name: "Комментарии к версии", exact: true })
        .click();
    }
    // An unsent draft belongs to its version and survives switching and network conflicts.
    await page
      .locator("#review-comment-form textarea")
      .fill("Черновик: уточнить оттенок " + width);
    await capture("discussion", false);
    if (width < 768)
      await page
        .locator(".review-sheet")
        .getByRole("button", { name: "Закрыть", exact: true })
        .click();
    await page
      .locator("#review-version-select")
      .selectOption(String(old.review.versionId));
    await page.locator(".review-warning").waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Согласовать", exact: true })
        .count(),
      0,
    );
    await page.waitForFunction(
      () => document.querySelector(".material-preview canvas")?.width > 0,
    );
    assert.equal(
      await page.locator(".review-actual-file").textContent(),
      "Гостиная-v1.pdf",
    );
    await capture("history-pdf");
    await page
      .getByRole("button", { name: "Открыть текущую версию", exact: true })
      .click();
    await page.locator(".review-decision-actions").waitFor();
    if (width < 768)
      await page
        .getByRole("button", { name: "Комментарии к версии", exact: true })
        .click();
    assert.equal(
      await page.locator("#review-comment-form textarea").inputValue(),
      "Черновик: уточнить оттенок " + width,
    );
    const failRoute = `**/api/material-versions/${current.review.versionId}/comments`;
    await page.route(failRoute, (r) =>
      r.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Временно недоступно" }),
      }),
    );
    await page.locator("#review-comment-form button[type=submit]").click();
    await page.waitForFunction(
      () => !document.querySelector("#review-comment-form button").disabled,
    );
    assert.equal(
      await page.locator("#review-comment-form textarea").inputValue(),
      "Черновик: уточнить оттенок " + width,
    );
    await page.unroute(failRoute);
    const saved = page.waitForResponse(
      (r) =>
        r
          .url()
          .endsWith(
            `/api/material-versions/${current.review.versionId}/comments`,
          ) && r.status() === 200,
    );
    await page.locator("#review-comment-form button[type=submit]").click();
    await saved;
    await page.waitForFunction(
      () =>
        document.querySelector("#review-message").textContent ===
        "Изменения сохранены.",
    );
    assert.ok(
      (await api(`/api/materials/${old.review.materialId}`)).events.some(
        (e) => e.body === "Черновик: уточнить оттенок " + width,
      ),
    );
    if (width < 768)
      await page
        .getByRole("button", { name: "Комментарии к версии", exact: true })
        .click();
    assert.equal(
      await page.locator("#review-comment-form textarea").inputValue(),
      "",
    );
    if (width < 768)
      await page
        .locator(".review-sheet")
        .getByRole("button", { name: "Закрыть", exact: true })
        .click();
    await page.locator(".material-preview-expand").click();
    await page.waitForFunction(
      () => document.querySelector(".viewer-content img")?.naturalWidth > 0,
    );
    await page.getByRole("button", { name: "Увеличить", exact: true }).click();
    assert.match(
      await page
        .getByRole("button", { name: /Сбросить масштаб/ })
        .textContent(),
      /125%/,
    );
    await page.getByRole("button", { name: /Сбросить масштаб/ }).click();
    await page.locator(".viewer-viewport").evaluate((viewport) => {
      const rect = viewport.getBoundingClientRect();
      const touch = (id, x) =>
        new Touch({
          identifier: id,
          target: viewport,
          clientX: rect.x + x,
          clientY: rect.y + 100,
        });
      const start = [touch(1, 80), touch(2, 160)],
        move = [touch(1, 40), touch(2, 200)];
      viewport.dispatchEvent(
        new TouchEvent("touchstart", {
          touches: start,
          changedTouches: start,
          bubbles: true,
          cancelable: true,
        }),
      );
      viewport.dispatchEvent(
        new TouchEvent("touchmove", {
          touches: move,
          changedTouches: move,
          bubbles: true,
          cancelable: true,
        }),
      );
      viewport.dispatchEvent(
        new TouchEvent("touchend", {
          touches: [],
          changedTouches: move,
          bubbles: true,
        }),
      );
    });
    assert.match(
      await page
        .getByRole("button", { name: /Сбросить масштаб/ })
        .textContent(),
      /200%/,
    );
    await page.getByRole("button", { name: /Сбросить масштаб/ }).click();
    await capture("viewer", false);
    await page
      .getByRole("button", { name: "Комментарий к версии", exact: true })
      .click();
    await page
      .locator("#review-comment-form textarea")
      .waitFor({ state: "visible" });
    if (width < 768)
      await page
        .locator(".review-sheet")
        .getByRole("button", { name: "Закрыть", exact: true })
        .click();
    // Reload proves the thread is persisted, not just optimistic DOM state.
    await page.reload();
    await page.locator("#app-view").waitFor({ state: "visible" });
    await openProject(page, project.id, { client: true });
    await page.locator("#tab-review").click();
    await page
      .locator(
        `#review-material-list [data-material-id="${old.review.materialId}"] .review-open-button`,
      )
      .click();
    if (width < 768)
      await page
        .getByRole("button", { name: "Комментарии к версии", exact: true })
        .click();
    await page
      .locator(".review-comment-body")
      .getByText("Черновик: уточнить оттенок " + width, { exact: true })
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

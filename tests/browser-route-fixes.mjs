import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp } from "../server.mjs";
import { fixtures } from "./preview-fixtures.mjs";
import { prepareFixtureUpload } from "./upload-fixture.mjs";
import { openProject } from "./browser-navigation.mjs";
const { chromium } = await import(
  process.env.ITD_PLAYWRIGHT_MODULE || "playwright"
);
const root = await mkdtemp(join(tmpdir(), "itd-route-fixes-")),
  password = randomBytes(24).toString("hex");
const before = process.env.ITD_CAPTURE_BASELINE === "1",
  shots = process.env.ITD_SCREENSHOT_DIR;
let app, browser;
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
    assert.ok(r.ok, path);
    return r.json();
  }
  const { user } = await api("/api/register", {
    name: "Заказчик проверки",
    email: "client@example.test",
    password,
  });
  const clientCookie = await login("client@example.test");
  const project = await api("/api/projects", {
    title: "Квартира · проверка маршрута",
    clientId: user.id,
    status: "В работе",
  });
  const stages = [];
  for (const [title, status] of [
    ["Обмеры", "in_progress"],
    ["Планировочное решение", "in_progress"],
    ["Концепция интерьера и подбор основных отделочных материалов", "planned"],
    ["Визуализации всех помещений квартиры", "planned"],
    ["Рабочая документация и технические чертежи", "planned"],
    ["Комплектация и спецификация мебели, оборудования и освещения", "planned"],
    ["Авторское сопровождение реализации проекта", "planned"],
  ])
    stages.push(
      await api(`/api/projects/${project.id}/stages`, {
        title,
        status,
        description: "Работы выполняются по согласованному плану.",
      }),
    );
  const photo = process.env.ITD_BROWSER_IMAGE
    ? ["image/webp", await readFile(process.env.ITD_BROWSER_IMAGE)]
    : fixtures.find((f) => f[1] === "image/jpeg").slice(1);
  const filename =
    "CAMERA_EXPORT_20261111_1234567890_ABCDEFGHIJKLMNOPQRSTUVWXYZ_ABCDEFGHIJKLMNOPQRSTUVWXYZ_ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
    (photo[0] === "image/webp" ? ".webp" : ".jpg");
  const file = await api(`/api/projects/${project.id}/files`, {
    name: filename,
    contentType: photo[0],
    data: photo[1].toString("base64"),
    category: "result",
    stageId: stages[0].id,
    review: true,
  });
  const detail = await api(`/api/materials/${file.review.materialId}`);
  await api(
    `/api/material-versions/${file.review.versionId}/decision`,
    {
      decision: "approved",
      confirm: true,
      expectedRevision: detail.material.currentVersion.revision,
    },
    "POST",
    clientCookie,
  );
  const original = (await api("/api/projects")).projects.find(
    (p) => p.id === project.id,
  );
  assert.deepEqual(
    original.stages.map((s) => s.status),
    [
      "approved",
      "in_progress",
      "planned",
      "planned",
      "planned",
      "planned",
      "planned",
    ],
  );
  if (shots) await mkdir(shots, { recursive: true });
  browser = await chromium.launch({
    executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const reports = [];
  for (const width of [360, 390, 768, 1024, 1440]) {
    const context = await browser.newContext({
        viewport: { width, height: width < 768 ? 844 : 1000 },
      }),
      page = await context.newPage(),
      errors = [],
      external = [];
    page.setDefaultTimeout(15000);
    page.on("pageerror", (e) => errors.push(e.message));
    await context.route("**/*", (r) => {
      const url = r.request().url();
      if (/^https?:/.test(url) && !url.startsWith(base + "/")) {
        external.push(url);
        return r.abort();
      }
      return r.continue();
    });
    async function signIn(email) {
      await page.goto(base + "/cabinet");
      await page.locator("#login-email").fill(email);
      await page.locator("#login-password").fill(password);
      await page.locator("#login-form .primary").click();
      await page.locator("#app-view").waitFor({ state: "visible" });
      await page.waitForFunction(
        () => !document.querySelector("#status-message").textContent,
      );
    }
    async function shot(name) {
      await page.waitForFunction(
        () => !document.querySelector("#status-message").textContent,
      );
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => scrollTo(0, 0));
      if (!before) {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        );
        if (overflow)
          console.log(
            "WIDE",
            await page.evaluate(() =>
              [...document.querySelectorAll("#app-view *")]
                .filter(
                  (e) =>
                    e.getBoundingClientRect().right > innerWidth + 1 &&
                    e.getBoundingClientRect().width > 0,
                )
                .map((e) => ({
                  tag: e.tagName,
                  cls: e.className,
                  id: e.id,
                  width: e.clientWidth,
                }))
                .slice(0, 15),
            ),
          );
        assert.ok(!overflow, name + " overflow " + width);
      }
      if (shots)
        await page.screenshot({
          path: join(
            shots,
            `${before ? "before" : "after"}-${name}-${width}.png`,
          ),
          fullPage: true,
        });
    }
    await signIn("client@example.test");
    if (!before) {
      await page.locator("#client-guide").waitFor({ state: "visible" });
      assert.match(await page.locator("#client-guide h2").textContent(), /Здравствуйте, Заказчик/);
      assert.equal(await page.locator("#client-guide-body").isVisible(), true);
      await page.locator("#client-guide-toggle").click();
      assert.equal(await page.locator("#client-guide-body").isVisible(), false);
      assert.equal(await page.evaluate((id) =>
        localStorage.getItem("itd-client-guide-v1:" + id), user.id
      ), "1");
      await page.locator("#client-guide-toggle").click();
      assert.equal(await page.locator("#client-guide-body").isVisible(), true);
    }
    await page.locator("#client-home-panel .route-feature").waitFor();
    const current = await page
      .locator("#client-home-panel .route-stage-heading h2")
      .textContent();
    const progress = await page
      .locator("#client-home-panel .route-progress")
      .innerText();
    if (!before) {
      assert.equal(current, "Планировочное решение");
      assert.match(progress, /14%/);
      assert.match(progress, /Согласовано: 1/);
      assert.match(progress, /Завершено: 0/);
      assert.equal(
        await page.locator("#client-home-panel .route-feature-image").count(),
        0,
      );
      assert.equal(
        await page.locator("#client-home-panel .route-step.is-current").count(),
        1,
      );
      assert.match(
        await page
          .locator("#client-home-panel .route-step.is-current")
          .innerText(),
        /Планировочное решение/,
      );
    }
    await shot("client-home");
    await openProject(page, project.id, { client: true });
    await page.locator("#tab-overview").click();
    if (!before) {
      assert.match(
        await page.locator("#project-header-progress-text").textContent(),
        /14%/,
      );
      assert.match(
        await page.locator("#project-header-progress-text").textContent(),
        /1 из 7/,
      );
    }
    await page.locator("#tab-review").click();
    await page.locator("#review-material-list .review-open-button").click();
    await page.locator("#review-version-select").waitFor();
    if (!before) {
      assert.doesNotMatch(
        await page.locator(".review-detail-heading h2").textContent(),
        /CAMERA_EXPORT/,
      );
      assert.match(
        await page.locator(".review-detail-heading h2").textContent(),
        /Обмеры/,
      );
      assert.equal(
        await page.locator(".review-actual-file").textContent(),
        filename,
      );
      assert.match(
        await page.locator("#review-version-select").inputValue(),
        /\d/,
      );
    }
    await shot("material");
    await page.locator("#logout-button").click();
    await signIn("studio@example.test");
    await page.locator("#workspace-metrics button").first().waitFor();
    if (!before) {
      assert.equal(
        await page.getByRole("button", { name: /Обновить/ }).count(),
        1,
      );
      const response = page.waitForResponse((r) =>
        r.url().includes("/api/admin/workspace"),
      );
      await page.locator("#refresh-button").click();
      await response;
    }
    await shot("admin-home");
    await openProject(page, project.id);
    await page.locator("#tab-stages").click();
    await page
      .locator(`[data-stage-id="${stages[1].id}"]`)
      .getByRole("button", { name: "Открыть этап", exact: true })
      .click();
    if (!before) {
      const host = page.locator(`[data-stage-id="${stages[1].id}"]`);
      const a = await host
          .getByRole("button", { name: "Все этапы", exact: true })
          .boundingBox(),
        b = await host
          .getByRole("button", {
            name: "Загрузить материал в этап",
            exact: true,
          })
          .boundingBox();
      assert.ok(
        b.y >= a.y + a.height + 7 || b.x >= a.x + a.width + 7,
        "stage action gap",
      );
    }
    await shot("admin-stage");
    // Passive navigation must never change actual stages or approval decisions.
    const after = (await api("/api/projects")).projects.find(
      (p) => p.id === project.id,
    );
    assert.deepEqual(after.stages, original.stages);
    assert.equal(
      (await api(`/api/materials/${file.review.materialId}`)).material
        .currentVersion.status,
      "approved",
    );
    if (!before && width === 1440) {
      await page
        .getByRole("button", { name: "Все этапы", exact: true })
        .first()
        .click();
      const stageCard = page.locator(`[data-stage-id="${stages[0].id}"]`);
      await stageCard.locator(".stage-edit summary").click();
      await stageCard
        .getByLabel("Статус этапа", { exact: true })
        .selectOption("completed");
      const saved = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/api/stages/${stages[0].id}`) &&
          r.request().method() === "PATCH",
      );
      await stageCard
        .getByRole("button", { name: "Сохранить этап", exact: true })
        .click();
      assert.ok((await saved).ok());
      await page.waitForFunction(() =>
        document
          .querySelector("#project-header-progress-text")
          .textContent.includes("Завершено: 1"),
      );
      const p = (await api("/api/projects")).projects.find(
        (p) => p.id === project.id,
      );
      assert.equal(p.stages[0].status, "completed");
      assert.equal(p.stages[1].status, "in_progress");
      assert.equal(
        (await api(`/api/materials/${file.review.materialId}`)).material
          .currentVersion.status,
        "approved",
      );
      assert.match(
        await page.locator("#project-header-progress-text").textContent(),
        /14%/,
      );
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    reports.push({
      width,
      current,
      progress,
      unchangedStages: true,
      noErrors: true,
    });
    console.log(`${before ? "Baseline" : "Regression"} ${width}px PASS`);
    await context.close();
  }
  if (shots)
    await writeFile(
      join(shots, `${before ? "before" : "after"}-results.json`),
      JSON.stringify(reports, null, 2) + "\n",
    );
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

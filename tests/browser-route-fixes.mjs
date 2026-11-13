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
    // Simulate a reused numeric user ID after the previous test database was
    // cleared: this browser still remembers that old account's walkthrough.
    if (!before) {
      await page.goto(base + "/cabinet");
      await page.evaluate((id) => {
        localStorage.setItem("itd-client-tour-v2:" + id, "done");
        localStorage.setItem("itd-client-tour-v3:" + id + ":old-account-created-at", "done");
      }, user.id);
    }
    await signIn("client@example.test");
    if (!before) {
      await page.locator("#itd-tour-layer").waitFor({ state: "visible" });
      assert.match(await page.locator("#itd-tour-layer h2").textContent(), /Добро пожаловать, Заказчик/);
      await page.getByRole("button", { name: /Начать обзор/ }).click();
      for (const [i, [title, tabId]] of [
        ["Главная", "tab-client-home"],
        ["Мои проекты", "tab-client-projects"],
        ["На согласование", "tab-client-review"],
        ["Уведомления", "tab-notifications"],
        ["Мой профиль", "tab-profile"],
      ].entries()) {
        await page.waitForFunction(
          (title) => document.querySelector("#itd-tour-layer h2")?.textContent === title,
          title,
        );
        const tab = page.locator("#" + tabId);
        assert.equal(await tab.isVisible(), true, "Global menu item must be visible");
        assert.equal(await tab.getAttribute("aria-selected"), "true");
        await page.waitForFunction((id) => {
          const a = document.getElementById(id)?.getBoundingClientRect();
          const b = document.querySelector(".itd-tour-focus")?.getBoundingClientRect();
          return a && b && Math.abs(a.left - b.left) < 12 &&
            Math.abs(a.top - b.top) < 12 && Math.abs(a.width - b.width) < 24;
        }, tabId);
        if (i < 4)
          await page.getByRole("button", { name: /Далее/ }).click();
        else
          await page.getByRole("button", { name: /Завершить/ }).click();
      }
      await page.locator("#itd-tour-layer").waitFor({ state: "detached" });
      assert.equal(await page.evaluate((account) =>
        localStorage.getItem("itd-client-tour-v5:" + account.id + ":" + account.createdAt + ":project"),
        user
      ), "done");
      assert.equal(await page.evaluate((id) =>
        localStorage.getItem("itd-client-tour-v2:" + id), user.id
      ), "done", "Legacy marker must stay untouched and must not block new onboarding");
      assert.equal(await page.locator("#client-guide-trigger").isVisible(), true);
      await page.locator("#client-guide-trigger").click();
      await page.locator("#itd-tour-layer").waitFor({ state: "visible" });
      await page.getByRole("button", { name: /Пропустить/ }).click();
    }
    await page.locator("#client-home-panel .route-feature").waitFor();
    // A horizontal stage card is a preview, not navigation to the stage list.
    const clientRoute = page.locator("#client-home-panel .project-journey");
    const clientPreview = clientRoute.locator(".route-feature");
    const stageCount = await clientRoute.locator(".route-step").count();
    assert.equal(stageCount, stages.length);
    const routeStage = clientRoute.locator(".route-step").nth(2);
    await routeStage.click();
    assert.equal(await page.locator("#tab-client-home").getAttribute("aria-selected"), "true");
    assert.equal(await clientRoute.locator(".route-strip").isVisible(), true);
    assert.equal(await clientPreview.isVisible(), true);
    assert.equal(await clientRoute.locator(".route-links").isVisible(), true);
    assert.equal(await clientPreview.locator(".route-feature-body > .route-links").count(), 1);
    assert.equal(await clientRoute.locator(".route-step").count(), stageCount);
    // The shortcuts are INSIDE the selected stage card. No overlap or horizontal overflow.
    const geometry = await clientPreview.evaluate((element) => {
      const feature = element.getBoundingClientRect();
      const image = element.querySelector(".route-stage-artwork, .route-feature-placeholder").getBoundingClientRect();
      const shortcuts = element.querySelector(".route-feature-body > .route-links").getBoundingClientRect();
      return {
        withinCard: shortcuts.left >= feature.left - 1 && shortcuts.right <= feature.right + 1,
        separated: image.right <= shortcuts.left + 1 || image.bottom <= shortcuts.top + 1,
      };
    });
    assert.ok(geometry.withinCard, "Album and documents cannot extend outside the stage feature");
    assert.ok(geometry.separated, "Album and documents cannot overlap the illustration");
    assert.match(await clientPreview.locator(".route-stage-heading h2").innerText(), /Концепция интерьера/);
    assert.equal(
      await clientPreview.locator(".route-stage-artwork img").getAttribute("src"),
      "/assets/stages/03.webp",
      "Stage artwork is independent of uploaded materials",
    );
    assert.equal(await routeStage.getAttribute("aria-pressed"), "true");
    assert.match(await clientPreview.locator(".route-stage-heading .eyebrow").innerText(), /Просмотр этапа/i);
    await clientRoute.locator(".route-step").nth(1).click();
    assert.match(await clientPreview.locator(".route-stage-heading h2").innerText(), /Планировочное решение/);
    assert.equal(
      await clientPreview.locator(".route-stage-artwork img").getAttribute("src"),
      "/assets/stages/02.webp",
    );
    // All seven editorial illustrations are based on stage meaning, not uploads.
    for (let i = 0; i < 7; i++) {
      await clientRoute.locator(".route-step").nth(i).click();
      assert.equal(
        await clientPreview.locator(".route-stage-artwork img").getAttribute("src"),
        `/assets/stages/${String(i + 1).padStart(2, "0")}.webp`,
        `Art for stage ${i + 1} should match the semantic stage title`,
      );
    }
    await clientRoute.locator(".route-step").nth(1).click();
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
        1,
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
    // Admin must keep the same overview route, too.
    const adminRoute = page.locator("#project-route");
    const beforeProgress = await page.locator("#project-header-progress-text").innerText();
    await adminRoute.locator(".route-step").nth(2).click();
    assert.equal(await page.locator("#tab-overview").getAttribute("aria-selected"), "true");
    assert.equal(await adminRoute.locator(".route-strip").isVisible(), true);
    assert.equal(await adminRoute.locator(".route-feature").isVisible(), true);
    assert.equal(await adminRoute.locator(".route-links").isVisible(), true);
    assert.equal(await adminRoute.locator(".route-feature-body > .route-links").count(), 1);
    assert.match(await adminRoute.locator(".route-stage-heading h2").innerText(), /Концепция интерьера/);
    assert.equal(
      await adminRoute.locator(".route-stage-artwork img").getAttribute("src"),
      "/assets/stages/03.webp",
    );
    assert.equal(await adminRoute.locator(".route-step").nth(2).getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#project-header-progress-text").innerText(), beforeProgress);
    await adminRoute.locator(".route-step").nth(1).click();
    assert.match(await adminRoute.locator(".route-stage-heading h2").innerText(), /Планировочное решение/);
    // The redesigned right-hand shortcuts still open the unified file library.
    await adminRoute.locator(".route-links > .panel").nth(0).getByRole("button").click();
    assert.equal(await page.locator("#tab-files").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator('[data-library-category="result"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#library-stage").inputValue(), String(stages[1].id));
    await page.locator("#tab-overview").click();
    await page.locator("#project-route .route-links > .panel").nth(1).getByRole("button").click();
    assert.equal(await page.locator("#tab-files").getAttribute("aria-selected"), "true");
    assert.equal(await page.locator('[data-library-category="document"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#library-stage").inputValue(), String(stages[1].id));
    await page.locator("#tab-files").click();
    assert.equal(await page.locator("#library-stage").inputValue(), "unassigned");
    assert.equal(await page.locator('[data-library-category="all"]').getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator("#tab-review").isVisible(), true);
    // The redundant Stages tab is gone; staff can still edit status and dates.
    assert.equal(await page.locator("#tab-stages, #panel-stages").count(), 0);
    await page.locator("#tab-settings").click();
    await page.locator("#settings-stage-management > summary").click();
    const settingsStage = page.locator(`#stage-list [data-stage-id="${stages[1].id}"]`);
    await settingsStage.waitFor({ state: "visible" });
    assert.equal(await page.locator("#tab-settings").getAttribute("aria-selected"), "true");
    assert.equal(await settingsStage.getByRole("button", {
      name: "Загрузить материал в этап", exact: true,
    }).count(), 1);
    await shot("admin-stage-settings");
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

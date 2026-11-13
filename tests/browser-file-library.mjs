import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp } from "../server.mjs";
import { fixtures } from "./preview-fixtures.mjs";
import { prepareFixtureUpload } from "./upload-fixture.mjs";
import { openProject, dismissWelcome } from "./browser-navigation.mjs";
const { chromium } = await import(
  process.env.ITD_PLAYWRIGHT_MODULE || "playwright"
);
const root = await mkdtemp(join(tmpdir(), "itd-file-library-")),
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
    const data = await r.json();
    assert.ok(r.ok, JSON.stringify(data));
    return data;
  }
  const { user } = await api("/api/register", {
    name: "Мария · тестовый проект",
    email: "client@example.test",
    password,
  });
  const clientCookie = await login("client@example.test");
  const project = await api("/api/projects", {
      title: "Квартира у парка",
      clientId: user.id,
      status: "В работе",
    }),
    stages = [];
  for (const title of [
    "Обмеры",
    "Планировочное решение",
    "Концепция интерьера",
    "Визуализации",
    "Рабочая документация",
    "Комплектация",
    "Авторское сопровождение",
  ])
    stages.push(
      await api(`/api/projects/${project.id}/stages`, {
        title,
        status: "planned",
      }),
    );
  const pdf = fixtures.find((f) => f[1] === "application/pdf");
  const jpg = fixtures.find((f) => f[1] === "image/jpeg");
  const photo = process.env.ITD_BROWSER_IMAGE
    ? [
        "interior.webp",
        "image/webp",
        await readFile(process.env.ITD_BROWSER_IMAGE),
      ]
    : jpg;
  // Optional public WebP assets for review screenshots; CI uses self-contained fixtures.
  const photos = process.env.ITD_BROWSER_IMAGES
    ? await Promise.all(
        process.env.ITD_BROWSER_IMAGES.split(",").map(async (path) => [
          path,
          "image/webp",
          await readFile(path),
        ]),
      )
    : [photo];
  const raw = new Map();
  async function upload(name, type, data, extra) {
    const f = await api(`/api/projects/${project.id}/files`, {
      name,
      contentType: type,
      data: data.toString("base64"),
      category: "result",
      ...extra,
    });
    raw.set(f.id, data);
    return f;
  }
  for (let i = 0; i < 3; i++) {
    const selectedPhoto = photos[i % photos.length];
    await upload(
      `render_${i}.${selectedPhoto[1] === "image/webp" ? "webp" : "jpg"}`,
      selectedPhoto[1],
      selectedPhoto[2],
      { stageId: stages[3].id },
    );
  }
  const old = await upload("ARCHIVE_PLAN_V1.pdf", pdf[1], pdf[2], {
    stageId: stages[1].id,
    review: true,
  });
  const current = await upload(
    "CAMERA_EXPORT_CURRENT." + (photo[1] === "image/webp" ? "webp" : "jpg"),
    photo[1],
    photo[2],
    {
      stageId: stages[1].id,
      review: true,
      materialId: old.review.materialId,
      expectedVersionId: old.review.versionId,
    },
  );
  const approved = await upload("measurements.jpg", jpg[1], jpg[2], {
    stageId: stages[0].id,
    review: true,
  });
  const d = await api(`/api/materials/${approved.review.materialId}`);
  await api(
    `/api/material-versions/${approved.review.versionId}/decision`,
    {
      decision: "approved",
      confirm: true,
      expectedRevision: d.material.currentVersion.revision,
    },
    "POST",
    clientCookie,
  );
  await api(`/api/stages/${stages[1].id}`, { status: "in_progress" }, "PATCH");
  const contract = await upload(
    "SCAN_000013492_LONG_TECHNICAL_CONTRACT_NAME.pdf",
    pdf[1],
    pdf[2],
    {
      category: "document",
      document: {
        title: "Договор на разработку дизайн-проекта",
        kind: "Договор",
        number: "Д-024",
        date: "2026-11-01",
      },
    },
  );
  await upload("estimate.pdf", pdf[1], pdf[2], {
    category: "document",
    stageId: stages[1].id,
    document: {
      title: "Смета отделочных материалов и оборудования",
      kind: "Смета",
      number: "С-007",
      date: "2026-11-12",
    },
  });
  await upload(
    "Очень_длинное_имя_файла_без_сокращений_для_проверки_мобильного_интерфейса_ABCDEFGHIJKLMNOPQRSTUVWXYZ.txt",
    "text/plain",
    Buffer.from("Тестовый документ, не пользовательские данные."),
    {
      category: "document",
      document: {
        title: "Приложение: состав работ и порядок взаимодействия со студией",
        kind: "Другое",
        number: "1",
      },
    },
  );
  const original = (await api("/api/projects")).projects.find(
    (p) => p.id === project.id,
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
        hasTouch: width < 768,
      }),
      page = await context.newPage(),
      errors = [],
      external = [];
    page.setDefaultTimeout(20000);
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
      await dismissWelcome(page);
    }
    async function shot(name) {
      await page.waitForFunction(
        () => !document.querySelector("#status-message").textContent,
      );
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => {
        const d = document.querySelector("#library-upload-dialog[open]");
        if (d) d.scrollTop = 0;
        else if (!document.querySelector("dialog[open]")) scrollTo(0, 0);
      });
      if (!before)
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          name + " overflow " + width,
        );
      if (shots)
        await page.screenshot({
          path: join(
            shots,
            `${before ? "before" : "after"}-${name}-${width}.png`,
          ),
        });
    }
    await signIn("client@example.test");
    await openProject(page, project.id, { client: true });
    await page.locator(before ? "#tab-results" : "#tab-files").click();
    if (!before) {
      // Top-level "Файлы проекта" is restricted to unassigned documents.
      assert.equal(await page.locator('[data-library-category="document"]').getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator("#library-stage").inputValue(), "unassigned");
      assert.equal(await page.locator("[data-library-key]").count(), 2);
      assert.equal(await page.locator(`[data-file-id="${contract.id}"]`).count(), 1);
      assert.equal(await page.locator("#library-content").getByText("Смета отделочных материалов и оборудования").count(), 0);
      await shot("client-unassigned-documents");
      // Clicking the stage-02 Documents shortcut must show ONLY stage-02
      // documents (not the contract, not another stage's photos).
      await page.locator("#tab-overview").click();
      await page.locator("#project-route .route-step").nth(1).click();
      await page.locator("#project-route .route-links > .panel").nth(1).getByRole("button").click();
      assert.equal(await page.locator('[data-library-category="document"]').getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator("#library-stage").inputValue(), String(stages[1].id));
      assert.equal(await page.locator("[data-library-key]").count(), 1);
      assert.equal(await page.locator("#library-content").getByText("Смета отделочных материалов и оборудования").count(), 1);
      assert.equal(await page.locator(`[data-file-id="${contract.id}"]`).count(), 0);
      // Switching stages discards the previous stage-specific document filter.
      await page.locator("#tab-overview").click();
      await page.locator("#project-route .route-step").nth(0).click();
      await page.locator("#project-route .route-links > .panel").nth(1).getByRole("button").click();
      assert.equal(await page.locator("#library-stage").inputValue(), String(stages[0].id));
      assert.equal(await page.locator("[data-library-key]").count(), 0);
      // "Альбом проекта" likewise scopes photographic materials to the stage.
      await page.locator("#tab-overview").click();
      await page.locator("#project-route .route-step").nth(3).click();
      await page.locator("#project-route .route-links > .panel").nth(0).getByRole("button").click();
      assert.equal(await page.locator("#library-stage").inputValue(), String(stages[3].id));
      assert.equal(await page.locator('[data-library-category="result"]').getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator("[data-library-key]").count(), 3);
      // The global nav must not inherit the stage-04 filter.
      await page.locator("#tab-files").click();
      assert.equal(await page.locator("#library-stage").inputValue(), "unassigned");
      assert.equal(await page.locator('[data-library-category="document"]').getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator("[data-library-key]").count(), 2);
      // The full library remains accessible through its manual filters.
      await page.locator("#library-stage").selectOption("");
      await page.locator('[data-library-category="all"]').click();
      assert.equal(await page.locator("[data-library-key]").count(), 8);
      assert.equal(await page.locator("#library-upload").isVisible(), false);
      assert.equal(await page.locator(`[data-file-id="${old.id}"]`).count(), 0);
      assert.equal(
        await page.locator(`[data-file-id="${current.id}"]`).count(),
        1,
      );
    }
    await shot("client-library");
    if (!before) {
      await page.locator('[data-library-category="result"]').click();
      await page.locator("#library-filters summary").click();
      await page.locator("#library-stage").selectOption(String(stages[3].id));
      assert.equal(await page.locator("[data-library-key]").count(), 3);
      await page.locator("#library-filters summary").click();
      await shot("client-materials");
      // Three photographs of one stage open as a proper lightbox sequence.
      // They must never include the approved photo from the "Обмеры" stage.
      await page.locator("#library-content .library-material .gallery-open").first().click();
      const viewer = page.locator("dialog.file-viewer");
      await viewer.waitFor({ state: "visible" });
      async function readyPhoto(number, total) {
        await page.waitForFunction(({ number, total }) =>
          document.querySelector("dialog.file-viewer .viewer-status")?.textContent ===
          `Изображение ${number} из ${total}`, { number, total });
      }
      await readyPhoto(1, 3);
      const firstPhoto = await viewer.locator(".viewer-toolbar h2").innerText();
      assert.match(firstPhoto, /render_\d/);
      assert.equal(await viewer.locator(".viewer-side-arrow:not([hidden])").count(), 2);
      assert.equal(await viewer.locator(".viewer-side-prev").isDisabled(), true);
      await viewer.getByRole("button", { name: "Следующее фото" }).click();
      await readyPhoto(2, 3);
      assert.notEqual(await viewer.locator(".viewer-toolbar h2").innerText(), firstPhoto);
      await page.keyboard.press("ArrowRight");
      await readyPhoto(3, 3);
      assert.equal(await viewer.locator(".viewer-side-next").isDisabled(), true);
      await page.keyboard.press("ArrowLeft");
      await readyPhoto(2, 3);
      if (width === 390) {
        await viewer.locator(".viewer-viewport").evaluate((host) => {
          const start = new Touch({ identifier: 1, target: host, clientX: 280, clientY: 320 }),
            end = new Touch({ identifier: 1, target: host, clientX: 130, clientY: 322 });
          host.dispatchEvent(new TouchEvent("touchstart", {
            bubbles: true, touches: [start], targetTouches: [start], changedTouches: [start],
          }));
          host.dispatchEvent(new TouchEvent("touchend", {
            bubbles: true, touches: [], targetTouches: [], changedTouches: [end],
          }));
        });
        await readyPhoto(3, 3);
      }
      await shot("stage-photo-gallery");
      await viewer.getByRole("button", { name: "Закрыть", exact: true }).click();
      assert.equal(await viewer.isVisible(), false);
      // A reviewed image still opens fullscreen, while its separate review
      // action remains visible. A single-photo stage cannot leave its stage.
      await page.locator("#library-filters summary").click();
      await page.locator("#library-stage").selectOption(String(stages[0].id));
      await page.locator("#library-filters summary").click();
      await page.locator("#library-content .library-material .gallery-open").click();
      await readyPhoto(1, 1);
      assert.equal(await viewer.locator(".viewer-side-arrow:not([hidden])").count(), 0);
      assert.equal(await viewer.getByRole("button", { name: "Следующий →" }).isDisabled(), true);
      await viewer.getByRole("button", { name: "Закрыть", exact: true }).click();
      assert.equal(
        await page.locator("#library-content .library-history").filter({ hasText: "Комментарии и согласование" }).count(),
        1,
      );
      await page.locator("#library-filters summary").click();
      await page.locator("#library-stage").selectOption("");
      await page.locator("#library-filters summary").click();
    }
    await page
      .locator(before ? "#tab-documents" : '[data-library-category="document"]')
      .click();
    await shot("client-documents");
    if (!before) {
      assert.equal(await page.locator("[data-library-key]").count(), 3);
      await page.locator("#library-search").fill("Д-024");
      assert.equal(await page.locator("[data-library-key]").count(), 1);
      await page.locator(".library-document-open").click();
      assert.equal(
        await page.locator("#library-document-title").textContent(),
        "Договор на разработку дизайн-проекта",
      );
      assert.match(
        await page.locator("#library-document-detail").textContent(),
        /SCAN_000013492/,
      );
      await shot("document-detail");
      await page.locator("#library-document-detail .file-preview").click();
      await page.locator(".viewer-content canvas").waitFor();
      await page.locator(".file-viewer .viewer-toolbar button").click();
      await page.locator("#library-document-close").click();
      await page.locator("#library-search").fill("");
      await page.locator('[data-library-category="all"]').click();
      await page.locator("#library-search").fill("ARCHIVE_PLAN_V1");
      assert.equal(await page.locator("[data-library-key]").count(), 1);
      await page.locator(".library-material .gallery-open").click();
      await page.waitForFunction(
        (id) =>
          document.querySelector("#review-version-select")?.value ===
          String(id),
        old.review.versionId,
      );
      assert.equal(await page.locator(".review-decision-actions").count(), 0);
      await page.locator(".review-library-back").click();
      assert.equal(
        await page.locator("#library-search").inputValue(),
        "ARCHIVE_PLAN_V1",
      );
      await page.locator("#library-search").fill("");
      await page.locator("#library-filters summary").click();
      await page.locator("#library-stage").selectOption(String(stages[1].id));
      assert.equal(await page.locator("[data-library-key]").count(), 2);
      await page.locator("#library-type").selectOption("kind:Смета");
      assert.equal(await page.locator("[data-library-key]").count(), 1);
      await page.locator("#library-type").selectOption("");
      await page.locator("#library-stage").selectOption("");
      await page.locator('[data-library-category="document"]').click();
      await page.locator("#library-sort").selectOption("document-date");
      assert.equal(
        await page
          .locator("[data-library-key]")
          .first()
          .locator("h3")
          .textContent(),
        "Смета отделочных материалов и оборудования",
      );
    }
    await page.locator("#logout-button").click();
    await signIn("studio@example.test");
    await openProject(page, project.id);
    await page
      .locator("#project-actions")
      .getByRole("button", { name: "Добавить документ", exact: true })
      .click();
    const files = [1, 2, 3].map((i) => ({
      name: `batch-${i}.pdf`,
      mimeType: "application/pdf",
      buffer: pdf[2],
    }));
    await page.locator("#upload-file").setInputFiles(files);
    for (let i = 0; i < 3; i++) {
      const card = page.locator(".upload-document-card").nth(i);
      if (!before) await card.locator("summary").click();
      await page
        .locator(`[data-document-index="${i}"][data-document-field="title"]`)
        .fill(`Документ очереди ${i + 1}`);
      if (!before) await card.locator("summary").click();
    }
    await shot("admin-upload");
    if (!before) {
      await page.locator("#library-upload-close").click();
      await page
        .locator("#project-actions")
        .getByRole("button", { name: "Добавить документ", exact: true })
        .click();
      assert.equal(await page.locator(".upload-document-card").count(), 3);
      if (width === 1440) {
        let attempts = 0;
        await context.route(
          `**/api/projects/${project.id}/files`,
          async (route) => {
            if (route.request().method() !== "POST") return route.continue();
            attempts++;
            if (attempts === 2) {
              await route.fetch();
              return route.abort("failed");
            }
            return route.continue();
          },
        );
        await page.locator("#upload-file-form button[type=submit]").click();
        await page.waitForFunction(() =>
          document
            .querySelector("#upload-batch-status")
            .textContent.includes("Загружено 1 из 3"),
        );
        assert.match(
          await page.locator(".upload-document-state").nth(1).textContent(),
          /Ошибка/,
        );
        await page.locator("#upload-file-form button[type=submit]").click();
        await page
          .locator("#library-upload-dialog")
          .waitFor({ state: "hidden" });
        const p = (await api("/api/projects")).projects.find(
          (p) => p.id === project.id,
        );
        assert.equal(p.files.length, original.files.length + 3);
        assert.deepEqual(p.stages, original.stages);
        assert.equal(attempts, 4);
        for (let i = 1; i <= 3; i++)
          assert.equal(
            p.files.filter((f) => f.document?.title === `Документ очереди ${i}`)
              .length,
            1,
          );
      } else {
        await page.locator("#upload-file").setInputFiles([]);
        await page.locator("#library-upload-close").click();
      }
    }
    const after = (await api("/api/projects")).projects.find(
      (p) => p.id === project.id,
    );
    assert.deepEqual(after.stages, original.stages);
    assert.deepEqual(
      after.files.filter((f) => raw.has(f.id)),
      original.files,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    reports.push({
      width,
      library: !before,
      unchangedOriginalFiles: true,
      unchangedStages: true,
      noErrors: true,
    });
    console.log(
      `Library ${before ? "baseline" : "regression"} ${width}px PASS`,
    );
    await context.close();
  }
  for (const [id, bytes] of raw) {
    const r = await fetch(base + `/api/files/${id}/download`, {
      headers: { Cookie: clientCookie },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes);
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

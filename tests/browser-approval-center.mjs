import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ownershipFixture } from "./ownership-fixture.mjs";
import { fixtures } from "./preview-fixtures.mjs";
import { openProject } from "./browser-navigation.mjs";
const { chromium, webkit } = await import(
  process.env.ITD_PLAYWRIGHT_MODULE || "playwright"
);
const f = await ownershipFixture(),
  shots = process.env.ITD_SCREENSHOT_DIR || "/tmp/itd-approval-shots";
await mkdir(shots, { recursive: true });
let browser;
try {
  const p = f.projects[0],
    s = p.stages[0];
  // Reuse the repository's existing PNG fixture. Optional local artwork is only for screenshots.
  const previewBytes = process.env.ITD_BROWSER_IMAGE
    ? await readFile(process.env.ITD_BROWSER_IMAGE)
    : fixtures[0][2];
  const materialCount = Number(process.env.ITD_MATERIAL_COUNT || 10);
  for (let i = 0; i < materialCount; i++)
    await f.api(
      `/api/projects/${p.id}/files`,
      {
        name: `Гостиная-${i + 1}.png`,
        contentType: "image/png",
        data: previewBytes.toString("base64"),
        category: "result",
        stageId: s.id,
        review: true,
      },
      f.admin,
      "POST",
      201,
    );
  browser =
    process.env.ITD_BROWSER === "webkit"
      ? await webkit.launch({ headless: true })
      : await chromium.launch({
          executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium",
          headless: true,
          args: ["--no-sandbox"],
        });
  const errors = [];
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      ...(process.env.ITD_USER_AGENT
        ? {
            userAgent: process.env.ITD_USER_AGENT,
            isMobile: true,
            hasTouch: true,
          }
        : {}),
    }),
    page = await context.newPage();
  const initialPreviews = new Set();
  page.on("request", (r) => {
    if (/\/api\/files\/\d+\/preview$/.test(r.url()))
      initialPreviews.add(r.url());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      !m.text().startsWith("Failed to load resource:")
    )
      errors.push(m.text());
  });
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (
      r.status() >= 400 &&
      !(
        /^\/assets\/stages\/0[1-7]\.webp$/.test(u.pathname) &&
        r.status() === 404
      ) &&
      !(u.pathname === "/api/me" && r.status() === 401)
    )
      errors.push(`${r.status()} ${u.pathname}`);
  });

  await page.goto(f.base + "/cabinet");
  await page.locator("#login-email").fill("client0@example.test");
  await page.locator("#login-password").fill(f.password);
  await page.locator("#login-form .primary").click();
  await openProject(page, p.id, { client: true });
  await page.locator("#tab-review").click();
  await page.locator("#approval-center .ac-material").first().waitFor();
  await page.getByText("Изображение загружено", { exact: true }).waitFor();
  if (materialCount === 100)
    assert.ok(
      initialPreviews.size < 15,
      `loaded ${initialPreviews.size} previews upfront`,
    );
  assert.equal(
    await page
      .locator(".ac-decisions")
      .getByRole("button", { name: "Согласовать", exact: true })
      .isDisabled(),
    true,
  );
  await page
    .getByRole("button", { name: "Я проверил(а) все страницы", exact: true })
    .click();
  await page
    .locator(".ac-decisions")
    .getByRole("button", { name: "Согласовать", exact: true })
    .click();
  await page.waitForTimeout(650);
  await page
    .getByRole("button", { name: "Сохранить сейчас", exact: true })
    .click();
  let state = await f.api(
    `/api/approval-center/projects/${p.id}/stages/${s.id}`,
    null,
    f.clients[0].cookie,
  );
  assert.equal(state.draft.entries[0].decision, "approved");
  // Marker creation and editing at normalized coordinates.
  await page.getByText("Изображение загружено", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Добавить замечание", exact: true })
    .click();
  await page.locator(".ac-sheet").click({ position: { x: 1, y: 1 } });
  await page
    .getByRole("dialog")
    .getByLabel("Текст замечания", { exact: true })
    .fill("Заменить светильник");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await page
    .getByLabel("Пояснение дизайнеру", { exact: true })
    .fill("Проверить свет");
  await page.getByRole("button", { name: "На доработку", exact: true }).click();
  await page
    .getByRole("button", { name: "Сохранить сейчас", exact: true })
    .click();
  // Reload resumes position and server drafts.
  page.on("dialog", (d) => d.accept());
  await page.reload();
  await openProject(page, p.id, { client: true });
  await page.locator("#tab-review").click();
  await page.locator(".ac-material").first().waitFor();
  state = await f.api(
    `/api/approval-center/projects/${p.id}/stages/${s.id}`,
    null,
    f.clients[0].cookie,
  );
  assert.equal(state.draft.entries.length, 2);
  assert.equal(state.draft.entries[1].markers.length, 1);
  for (const width of [360, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(200);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      `horizontal overflow at ${width}`,
    );
    if (!process.env.ITD_NO_SCREENSHOTS)
      await page.screenshot({
        path: join(shots, `client-${width}.png`),
        fullPage: true,
        caret: "initial",
      });
  }
  await page
    .getByRole("button", { name: "Проверить и отправить", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Подтверждаю отправку", exact: true })
    .click();
  await page.getByText(/Пакет принят. Ведомость/).waitFor();
  state = await f.api(
    `/api/approval-center/projects/${p.id}/stages/${s.id}`,
    null,
    f.clients[0].cookie,
  );
  assert.equal(state.packages.length, 1);
  assert.equal(
    state.materials.filter((m) => m.currentVersion.status === "approved")
      .length,
    1,
  );
  await page
    .getByRole("button", { name: "История и ведомости", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Ведомость №/ })
    .click();
  const link = page
    .getByRole("dialog")
    .getByRole("link", { name: "Скачать ведомость в PDF" });
  await link.waitFor({ state: "visible" });
  if (!process.env.ITD_NO_SCREENSHOTS)
    await page.screenshot({
      path: join(shots, "statement.png"),
      fullPage: true,
      caret: "initial",
    });
  assert.deepEqual(errors, []);
  await context.close();
  const adminContext = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    a = await adminContext.newPage();
  await a.goto(f.base + "/cabinet");
  await a.locator("#login-email").fill("admin@example.test");
  await a.locator("#login-password").fill(f.password);
  await a.locator("#login-form .primary").click();
  await openProject(a, p.id);
  await a.locator("#tab-review").click();
  await a.locator(".ac-material").first().waitFor();
  if (!process.env.ITD_NO_SCREENSHOTS)
    await a.screenshot({
      path: join(shots, "admin-1440.png"),
      fullPage: true,
      caret: "initial",
    });
  await a
    .getByRole("button", { name: "Очередь замечаний", exact: true })
    .click();
  const queue = a.getByRole("dialog");
  await queue.getByText("Заменить светильник", { exact: true }).waitFor();
  await queue
    .getByLabel("Статус в очереди", { exact: true })
    .selectOption("confirmed");
  await queue
    .getByText("В этой выборке замечаний нет.", { exact: true })
    .waitFor();
  await queue.getByRole("button", { name: "Закрыть", exact: true }).click();
  const updatedState = await f.api(
    `/api/approval-center/projects/${p.id}/stages/${s.id}`,
    null,
    f.admin,
  );
  const revisionMaterial = updatedState.materials.find((m) => m.notes.length);
  await a
    .locator(
      `.ac-material[data-material-id="${revisionMaterial.id}"] .ac-material-open`,
    )
    .click();
  await a
    .getByRole("button", { name: "Загрузить исправленную версию", exact: true })
    .click();
  await a
    .getByRole("dialog")
    .getByLabel("Что изменено", { exact: true })
    .fill("Заменён светильник");
  await a
    .getByRole("dialog")
    .getByLabel(/Исправлено замечание/)
    .check();
  await a
    .getByRole("dialog")
    .getByLabel("Результат или причина, почему не исправлено", { exact: true })
    .fill("Исправлено в новой версии");
  await a.getByRole("dialog").locator("input[type=file]").setInputFiles({
    name: "Новая-версия.png",
    mimeType: "image/png",
    buffer: previewBytes,
  });
  await a
    .getByRole("dialog")
    .getByRole("button", { name: "Отправить новую версию", exact: true })
    .click();
  await a
    .getByText("Исправленная версия отправлена клиенту.", { exact: true })
    .waitFor();
  const corrected = (
    await f.api(
      `/api/approval-center/projects/${p.id}/stages/${s.id}`,
      null,
      f.admin,
    )
  ).materials.find((m) => m.id === revisionMaterial.id);
  assert.equal(corrected.currentVersion.versionNumber, 2);
  assert.equal(corrected.notes[0].status, "fixed");
  await a.getByRole("button", { name: "Было / Стало", exact: true }).click();
  await a.getByLabel("Разделитель «Было / Стало»", { exact: true }).waitFor();
  await a.getByLabel("Разделитель «Было / Стало»", { exact: true }).fill("60");
  if (!process.env.ITD_NO_SCREENSHOTS)
    await a.screenshot({
      path: join(shots, "comparison.png"),
      fullPage: true,
      caret: "initial",
    });
  await adminContext.close();
  console.log(
    "PASS",
    browser.browserType().name(),
    browser.version(),
    "approval workflow, server drafts, markers, submission, statement, admin upload/comparison and 5 widths",
  );
} finally {
  await browser?.close();
  await f.close();
}

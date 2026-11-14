import assert from "node:assert/strict";
import { PDFDocument, rgb } from "pdf-lib";
import { ownershipFixture } from "./ownership-fixture.mjs";
import { openProject } from "./browser-navigation.mjs";
const { chromium, webkit } = await import(
  process.env.ITD_PLAYWRIGHT_MODULE || "playwright"
);
const f = await ownershipFixture();
let browser;
try {
  const p = f.projects[0],
    stage = p.stages[0],
    scope = `/api/approval-center/projects/${p.id}/stages/${stage.id}`;
  async function pdfBytes(count) {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < count; i++) {
      const page = pdf.addPage([600, 400]);
      page.drawRectangle({
        x: 50 + i * 30,
        y: 50,
        width: 200,
        height: 150,
        color: rgb(0.3, 0.5, 0.6),
      });
    }
    return Buffer.from(await pdf.save()).toString("base64");
  }
  const original = await f.api(
    `/api/projects/${p.id}/files`,
    {
      name: "План-v1.pdf",
      contentType: "application/pdf",
      category: "result",
      stageId: stage.id,
      review: true,
      data: await pdfBytes(2),
    },
    f.admin,
    "POST",
    201,
  );
  browser =
    process.env.ITD_BROWSER === "webkit"
      ? await webkit.launch()
      : await chromium.launch({
          executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium",
          headless: true,
          args: ["--no-sandbox"],
        });
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage(),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(f.base + "/cabinet");
  await page.locator("#login-email").fill("client0@example.test");
  await page.locator("#login-password").fill(f.password);
  await page.locator("#login-form .primary").click();
  await openProject(page, p.id, { client: true });
  await page.locator("#tab-review").click();
  await page.locator(".ac-sheet canvas").waitFor();
  await page
    .getByRole("button", { name: "Я проверил(а) все страницы", exact: true })
    .click();
  await page.getByText("Просмотрены 1 из 2 страниц", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Следующая страница", exact: true })
    .click();
  await page.getByText("Страница 2 из 2", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Добавить замечание", exact: true })
    .click();
  const box = await page.locator(".ac-sheet").boundingBox();
  await page
    .locator(".ac-sheet")
    .click({ position: { x: box.width * 0.25, y: box.height * 0.7 } });
  await page
    .getByRole("dialog")
    .getByLabel("Текст замечания", { exact: true })
    .fill("Сместить стену на второй странице");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить черновик", exact: true })
    .click();
  await page
    .getByLabel("Пояснение дизайнеру", { exact: true })
    .fill("Исправить план");
  await page.getByRole("button", { name: "На доработку", exact: true }).click();
  await page
    .getByRole("button", { name: "Сохранить сейчас", exact: true })
    .click();
  let state = await f.api(scope, null, f.clients[0].cookie),
    marker = state.draft.entries[0].markers[0];
  assert.equal(marker.page, 2);
  assert.ok(Math.abs(marker.x - 0.25) < 0.02);
  assert.ok(Math.abs(marker.y - 0.7) < 0.02);
  await page
    .locator(".ac-view-tools")
    .getByRole("button", { name: "+", exact: true })
    .click();
  const rect = await page.locator(".ac-sheet").boundingBox(),
    pin = await page.locator(".ac-pin").boundingBox();
  assert.ok(
    Math.abs((pin.x + pin.width / 2 - rect.x) / rect.width - marker.x) < 0.01,
  );
  await page
    .getByRole("button", { name: "Проверить и отправить", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Подтверждаю отправку", exact: true })
    .click();
  await page.getByText(/Пакет принят/).waitFor();
  state = await f.api(scope, null, f.clients[0].cookie);
  const note = state.materials[0].notes[0];
  const newer = await f.api(
    `/api/projects/${p.id}/files`,
    {
      name: "План-v2.pdf",
      contentType: "application/pdf",
      category: "result",
      stageId: stage.id,
      materialId: original.review.materialId,
      expectedVersionId: original.review.versionId,
      data: await pdfBytes(3),
      correctionReport: {
        description: "Стена смещена, добавлен лист",
        resolutions: [
          {
            noteId: note.id,
            fixed: true,
            explanation: "Вторая страница обновлена",
          },
        ],
      },
    },
    f.admin,
    "POST",
    201,
  );
  await page
    .getByRole("button", { name: "Обновить данные", exact: true })
    .click();
  await page.locator(".ac-material-open").click();
  await page.getByRole("button", { name: "Было / Стало", exact: true }).click();
  await page.getByText(/Количество страниц различается/).waitFor();
  assert.equal(
    await page
      .getByLabel("Разделитель «Было / Стало»", { exact: true })
      .count(),
    0,
  );
  const left = page.locator(".ac-compare-side").nth(0),
    right = page.locator(".ac-compare-side").nth(1);
  await left
    .getByRole("button", { name: "Следующая страница", exact: true })
    .click();
  await left.getByText("Страница 2 из 2", { exact: true }).waitFor();
  assert.equal(await left.locator(".ac-pin").count(), 1);
  assert.equal(await right.locator(".ac-pin").count(), 0);
  await page
    .getByRole("button", { name: "Подтвердить исправление", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Пояснение", { exact: true })
    .fill("Проверено на новом плане");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Сохранить в истории", exact: true })
    .click();
  await page
    .locator(".ac-note button")
    .filter({ hasText: "Подтверждено клиентом" })
    .first()
    .waitFor();
  state = await f.api(scope, null, f.clients[0].cookie);
  assert.equal(state.materials[0].currentVersion.status, "pending_approval");
  assert.equal(state.materials[0].notes[0].status, "confirmed");
  assert.equal(state.materials[0].versions[0].status, "changes_requested");
  assert.deepEqual(errors, []);
  await context.close();
  console.log(
    "PASS PDF",
    browser.browserType().name(),
    browser.version(),
    "all-page criterion, normalized markers/zoom, different page counts, old marker only on old version, correction is separate from file decision",
  );
} finally {
  await browser?.close();
  await f.close();
}

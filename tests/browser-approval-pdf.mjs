import { action, button, notes, saved, summary } from "./approval-navigation.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, rgb } from "pdf-lib";
import { ownershipFixture } from "./ownership-fixture.mjs";
import { drawing } from "./approval-demo.mjs";
import { openGlobal, openProject } from "./browser-navigation.mjs";
const { chromium, webkit } = await import(
  process.env.ITD_PLAYWRIGHT_MODULE || "playwright"
);
const f = await ownershipFixture();
let browser;
try {
  const p = f.projects[0],
    stage = p.stages[0],
    scope = `/api/approval-center/projects/${p.id}/stages/${stage.id}`;
  const sheetName = "План перегородок";
  async function planFile(sheets, corrected = false) {
    const pdf = await PDFDocument.create();
    for (const [index, title] of sheets.entries()) {
      const original = await PDFDocument.load(await drawing(title, sheets.length));
      const [sheet] = await pdf.copyPages(original, [index]);
      if (corrected && title === sheetName) {
        const line = (x, y, endX, endY) => sheet.drawLine({
          start: { x, y }, end: { x: endX, y: endY }, thickness: 1, color: rgb(0.25, 0.30, 0.25),
        });
        line(236, 190, 267, 190);
        line(236, 186, 236, 194);
        line(267, 186, 267, 194);
        sheet.drawText("1 000", { x: 240, y: 193, size: 8 });
      }
      pdf.addPage(sheet);
    }
    return Buffer.from(await pdf.save()).toString("base64");
  }
  const original = await f.api(
    `/api/projects/${p.id}/files`,
    {
      name: "Планировка квартиры.pdf",
      contentType: "application/pdf",
      category: "result",
      stageId: stage.id,
      review: true,
      data: await planFile(["План помещений", sheetName]),
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
  const clientState = () => f.api(scope, null, f.clients[0].cookie);
  const capture = async (name) => {
    if (!process.env.ITD_SCREENSHOT_DIR || process.env.ITD_NO_SCREENSHOTS) return;
    await mkdir(process.env.ITD_SCREENSHOT_DIR, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(process.env.ITD_SCREENSHOT_DIR, name + ".png"), animations: "disabled" });
  };
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(f.base + "/cabinet");
  await page.locator("#login-email").fill("client0@example.test");
  await page.locator("#login-password").fill(f.password);
  await page.locator("#login-form .primary").click();
  await openProject(page, p.id, { client: true });
  await page.locator("#tab-review").click();
  await page.locator(".ac-sheet canvas").waitFor();
  await page
    .getByRole("button", { name: "Согласовать и далее", exact: true })
    .click();
  await page.getByText("Чтобы согласовать материал, просмотрите все страницы. Просмотрено 1 из 2. Осталось 1", { exact: true }).waitFor();
  await button(page, "Нужны правки").click();
  await button(page.getByRole("dialog"), "Поставить отметку на документе").click();
  // Between selecting a new page and painting it, the old sheet must not accept pins.
  await page
    .getByRole("button", { name: "Следующая страница", exact: true })
    .evaluate((next) => {
      next.click();
      document.querySelector(".ac-sheet").click();
    });
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByText("Страница 2 из 2", { exact: true }).waitFor();
  // The page number changes immediately. Measure the new sheet after it has painted and registered.
  await page.getByText("Все страницы просмотрены", { exact: true }).waitFor();
  const box = await page.locator(".ac-sheet").boundingBox();
  await page
    .locator(".ac-sheet")
    .click({ position: { x: box.width * 0.25, y: box.height * 0.7 } });
  await page
    .getByRole("dialog")
    .getByLabel("Текст замечания", { exact: true })
    .fill("Укажите ширину прохода между кухней и гостиной на плане перегородок.");
  await button(page.getByRole("dialog"), "Подготовить и далее").click();
  await saved(page);
  let state = await clientState(),
    marker = state.draft.entries[0].markers[0];
  assert.equal(marker.page, 2);
  assert.ok(Math.abs(marker.x - 0.25) < 0.02);
  assert.ok(Math.abs(marker.y - 0.7) < 0.02);
  await page
    .locator(".ac-view-tools")
    .getByRole("button", { name: "Увеличить масштаб", exact: true })
    .click();
  const rect = await page.locator(".ac-sheet").boundingBox(),
    pin = await page.locator(".ac-pin").boundingBox();
  assert.ok(
    Math.abs((pin.x + pin.width / 2 - rect.x) / rect.width - marker.x) < 0.01,
  );
  await page.getByLabel("Перейти на страницу").selectOption("1");
  await notes(page);
  await button(page, "Добавить ещё одну отметку").click();
  await page.locator(".ac-sheet").click({ position: { x: rect.width * 0.6, y: rect.height * 0.4 } });
  await page.getByRole("dialog").getByLabel("Текст замечания").fill("Подпишите дверной проём в спальне.");
  await button(page.getByRole("dialog"), "Подготовить и далее").click();
  await saved(page);
  await summary(page);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Подтверждаю отправку", exact: true })
    .click();
  await page.getByText(/Пакет принят/).waitFor();
  state = await clientState();
  const [note, otherNote] = state.materials[0].notes;
  assert.deepEqual([note.page, otherNote.page], [2, 1]);
  assert.deepEqual(state.materials[0].versions[0].viewedPageNumbers, [1, 2]);
  await openGlobal(page, "client-review");
  const fixedText = "План перегородок теперь на третьем листе. Добавлен размер прохода 1 000 мм.";
  const replacement = await planFile(["План мебели", "План помещений", sheetName], true);
  const newer = await f.api(
    `/api/projects/${p.id}/files`,
    {
      name: "Планировка квартиры · редакция 2.pdf",
      contentType: "application/pdf",
      category: "result",
      stageId: stage.id,
      materialId: original.review.materialId,
      expectedVersionId: original.review.versionId,
      data: replacement,
      correctionReport: {
        description: "Добавлен план мебели, уточнены размеры и подписи.",
        resolutions: [
          { noteId: note.id, fixed: true, explanation: fixedText },
          { noteId: otherNote.id, fixed: true, explanation: "Уточнена подпись к проёму." },
        ],
      },
    },
    f.admin,
    "POST",
    201,
  );
  const v2 = newer.review.versionId;
  const seen = async (id) => (await clientState()).materials[0].versions.find(v => v.id === id).viewedPageNumbers;
  await page.reload();
  await openGlobal(page, "client-review");
  const decisions = page.locator("#client-review-panel");
  await button(decisions, "История").click();
  await button(decisions.locator(`[data-version-id="${original.review.versionId}"]`), "Исходное замечание · версия 1").click();
  const card = page.locator(`#ac-note-${note.id}`), otherCard = page.locator(`#ac-note-${otherNote.id}`);
  const check = button(card, "Проверить исправление · версия 2");
  const confirm = button(card, "Подтвердить исправление");
  await button(card, "Исходное замечание · версия 1").click();
  await page.locator(".ac-sheet .ac-pin.is-located").click();
  await page.getByText(/Историческая версия — только просмотр/).waitFor();
  await card.getByText(fixedText, { exact: true }).waitFor();
  assert.equal(await confirm.count(), 0);
  assert.equal(await page.locator(".ac-note-actions button").count(), 0);
  assert.deepEqual(await seen(v2), []);
  await page.getByTitle("Вернуть исходный масштаб").click();
  await page.locator(".ac-rail-body").evaluate(el => { el.scrollTop = 0; });
  await saved(page);
  await capture("archive-read-only");

  // A PDF that fails to open contributes no pages, even when its thumbnail is already visible.
  const previewUrl = "**/api/files/" + newer.id + "/preview";
  await page.route(previewUrl, route => route.fulfill({ status: 200, contentType: "application/pdf", body: "" }));
  await check.click();
  await card.getByText(/Не удалось отобразить исправленный файл/).waitFor();
  assert.ok(await confirm.isDisabled());
  assert.deepEqual(await seen(v2), []);
  await page.unroute(previewUrl);
  await check.click();
  await card.getByText(/Просмотрено 1 из 3/).waitFor();
  assert.ok(await confirm.isDisabled());
  assert.deepEqual(await seen(v2), [1]);
  assert.equal(await page.locator(".ac-sheet .ac-pin").count(), 0);

  const viewUrl = "**/versions/" + v2 + "/view";
  await page.route(viewUrl, route => route.request().postDataJSON().page === 3
    ? route.fulfill({ status: 503, json: { error: "Не удалось сохранить просмотр" } }) : route.continue());
  await page.getByLabel("Перейти на страницу").selectOption("3");
  await card.getByText(/Не удалось сохранить просмотр версии 2/).waitFor();
  assert.ok(await confirm.isDisabled());
  assert.deepEqual(await seen(v2), [1]);
  await page.unroute(viewUrl);
  await button(card, "Повторить сохранение").click();
  await card.getByText(/Просмотрено 2 из 3/).waitFor();
  assert.deepEqual(await seen(v2), [1, 3]);
  assert.ok(await confirm.isDisabled());
  await page.getByLabel("Перейти на страницу").selectOption("2");
  await card.getByText("Просмотр исправленной версии 2 сохранён.", { exact: true }).waitFor();
  await page.getByLabel("Перейти на страницу").selectOption("3");
  await page.getByText("Страница 3 из 3", { exact: true }).waitFor();
  await page.locator(".ac-sheet canvas").waitFor();
  assert.ok(await confirm.isEnabled());
  assert.deepEqual(await seen(v2), [1, 2, 3]);
  await saved(page);
  await capture("review-correction-v2");

  await action(page, "Было / Стало");
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
  await left.locator(".ac-pin").first().waitFor();
  assert.equal(await left.locator(".ac-pin").count(), 1);
  assert.equal(await right.locator(".ac-pin").count(), 0);
  await notes(page);
  await confirm.click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText(/исправленная версия 2/).waitFor();
  await dialog.getByText("Ответ студии: " + fixedText, { exact: true }).waitFor();
  await page
    .getByRole("dialog")
    .getByLabel("Пояснение", { exact: true })
    .fill("Проверено на новом плане");
  await button(dialog, "Сохранить в истории").evaluate(b => { b.click(); b.click(); });
  await card.locator(".ac-note-state").getByText("Подтверждено клиентом", { exact: true }).waitFor();
  state = await clientState();
  assert.equal(state.materials[0].currentVersion.status, "pending_approval");
  assert.deepEqual(state.materials[0].notes.map(n => n.status), ["confirmed", "fixed"]);
  assert.equal(state.materials[0].notes[0].history.filter(e => e.type === "confirmed").length, 1);
  assert.equal(state.materials[0].versions.find(v => v.id === v2).confirmedView, false);
  assert.equal(state.materials[0].versions[0].status, "changes_requested");
  assert.equal(state.stage.approved, false);

  // The studio publishes another revision while the client's confirmation dialog is open.
  await button(otherCard, "Подтвердить исправление").click();
  await dialog.getByLabel("Пояснение").fill("Проверена вторая версия.");
  const third = await f.api(`/api/projects/${p.id}/files`, {
    name: "Планировка квартиры · редакция 3.pdf", contentType: "application/pdf", category: "result",
    stageId: stage.id, materialId: original.review.materialId, expectedVersionId: v2, data: replacement,
    correctionReport: { description: "Уточнена подпись.",
      resolutions: [{ noteId: otherNote.id, fixed: true, explanation: "Подпись обновлена в третьей редакции." }] },
  }, f.admin, "POST", 201);
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().endsWith("/notes/" + otherNote.id + "/events")),
    button(dialog, "Сохранить в истории").click(),
  ]);
  assert.equal(response.status(), 409);
  assert.equal(response.request().postDataJSON().versionId, v2);
  await dialog.getByRole("alert").waitFor();
  assert.ok(await button(dialog, "Сохранить в истории").isDisabled());
  assert.deepEqual(await seen(third.review.versionId), []);
  state = await clientState();
  assert.equal(state.materials[0].notes[1].status, "fixed");
  assert.equal(state.materials[0].notes[1].history.filter(e => e.type === "confirmed").length, 0);
  await button(dialog, "Открыть актуальное исправление").click();
  await button(otherCard, "Проверить исправление · версия 3").waitFor();
  await otherCard.getByText(/Просмотрено 1 из 3/).waitFor();
  assert.ok(await button(otherCard, "Подтвердить исправление").isDisabled());
  assert.deepEqual(errors, []);
  await context.close();
  console.log(
    "PASS PDF",
    browser.browserType().name(),
    browser.version(),
    "read-only archive, reordered plans, rendering and registration failures, explicit version-bound confirmation, double click, stale dialog, comparison and independent material/stage decisions",
  );
} finally {
  await browser?.close();
  await f.close();
}

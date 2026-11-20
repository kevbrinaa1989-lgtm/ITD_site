import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ownershipFixture } from "./ownership-fixture.mjs";
import { drawing } from "./approval-demo.mjs";
import { openProject } from "./browser-navigation.mjs";
import { button, closeNotes, queue, saved } from "./approval-navigation.mjs";

const { chromium } = await import(process.env.ITD_PLAYWRIGHT_MODULE || "playwright");
const f = await ownershipFixture();
let browser;
try {
  const project = f.projects[0], client = f.clients[0];
  const [stage, adjacent] = project.stages;
  const route = stageId => `/api/approval-center/projects/${project.id}/stages/${stageId}`;
  const state = (stageId = stage.id, cookie = client.cookie) => f.api(route(stageId), null, cookie);
  async function upload(title, pages = 1, stageId = stage.id, replacement = {}) {
    return f.api(`/api/projects/${project.id}/files`, {
      name: title + ".pdf", data: await drawing(title, pages), contentType: "application/pdf",
      category: "result", review: true, stageId, ...replacement,
    }, f.admin, "POST", 201);
  }
  const entry = (m, comment, markers, decision) => ({
    materialId: m.id, versionId: m.currentVersion.id, expectedRevision: m.currentVersion.revision,
    decision, comment, markers,
  });
  async function prepare(stageId, entries) {
    const { draft } = await state(stageId);
    return f.api(route(stageId) + "/draft", {
      expectedRevision: draft.revision, position: {}, entries,
    }, client.cookie, "PUT");
  }
  await upload("План перегородок", 2);
  await upload("План мебели");
  await upload("План освещения");
  await upload("Схема выключателей", 1, adjacent.id);
  const [original, alreadyReturned, next] = (await state()).materials;
  const [outside] = (await state(adjacent.id)).materials;
  const previous = "Указать высоту полки над столом.", privateOther = "Замечание к выключателю в другом этапе.";
  const historical = "Показать размер проёма в первой версии.";
  const previousDraft = await prepare(stage.id, [
    entry(original, historical, [], "changes_requested"),
    entry(alreadyReturned, "", [{ page: 1, x: 0.45, y: 0.37, body: previous }], "changes_requested"),
  ]);
  await f.api(route(stage.id) + "/submit", {
    expectedRevision: previousDraft.revision, operationId: randomUUID(), confirm: true,
  }, client.cookie);
  await upload("План перегородок", 2, stage.id, {
    materialId: original.id, expectedVersionId: original.currentVersion.id,
    correctionReport: { description: "Добавлен размер проёма.", resolutions: [] },
  });
  const plan = (await state()).materials.find(m => m.id === original.id);
  await prepare(adjacent.id, [entry(outside, privateOther, [], null)]);

  browser = await chromium.launch({ executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox"] });
  async function enter(phone = false) {
    const page = await browser.newPage({
      viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile: phone, hasTouch: phone,
    });
    await page.goto(f.base + "/cabinet");
    await page.locator("#login-email").fill(client.email);
    await page.locator("#login-password").fill(f.password);
    await page.locator("#login-form .primary").click();
    await openProject(page, project.id, { client: true });
    await page.locator("#tab-review").click();
    await page.locator(".ac-sheet canvas").waitFor();
    return page;
  }
  const heading = (page, m) => page.locator(".ac-title").getByRole("heading", { name: m.title.replace(/\.pdf$/i, ""), exact: true });
  const list = page => page.locator(".ac-rail .ac-notes");
  const field = page => page.getByRole("dialog").getByLabel("Текст замечания", { exact: true });
  const saveAndNext = "Сохранить правки и далее";
  const general = "Проверить размеры после обмеров.", first = "Сместить перегородку у окна.";
  const second = "Указать ширину ниши.", edited = "Указать чистовую ширину ниши.";
  const desktop = await enter();
  const dialog = desktop.getByRole("dialog");
  await heading(desktop, plan).waitFor();
  await button(desktop, "Согласовать и далее").waitFor();
  await button(desktop, "Нужны правки").click();
  await field(desktop).fill(first);
  await button(dialog, "Поставить отметку на документе").click();
  await desktop.locator(".ac-sheet").click({ position: { x: 120, y: 85 } });
  await button(dialog, "Добавить ещё одну отметку").click();
  await desktop.getByLabel("Перейти на страницу").selectOption("2");
  await desktop.getByText("Все страницы просмотрены", { exact: true }).waitFor();
  await desktop.locator(".ac-sheet").click({ position: { x: 165, y: 110 } });
  await field(desktop).fill(second);
  await dialog.locator(".ac-composer-marks summary").click();
  await button(dialog, "Общее замечание к материалу").click();
  await field(desktop).fill(general);
  await button(dialog, "Все замечания · 4").click();
  await desktop.locator(".ac-rail").getByRole("heading", { name: "Замечания · 4" }).waitFor();
  assert.equal(await list(desktop).locator(".ac-draft-note").count(), 3);
  for (const text of [first, second, general, historical])
    assert.equal(await list(desktop).getByText(text, { exact: true }).count(), 1);
  const card = (page, body) => list(page).locator(".ac-draft-note").filter({ hasText: body });
  await button(card(desktop, second), "Изменить").click();
  await field(desktop).fill(edited);
  await button(dialog, "Все замечания · 4").click();
  await button(card(desktop, first), "Показать на листе 1").click();
  await desktop.getByText("Страница 1 из 2", { exact: true }).waitFor();
  await button(desktop.locator(".ac-sheet"), "Замечание 1: " + first).waitFor();
  await closeNotes(desktop);
  await button(desktop.locator(".ac-view-heading"), "Замечания · 4").click();
  await button(desktop.locator(".ac-rail"), "Замечания по всем материалам").click();
  await dialog.getByText(previous, { exact: true }).waitFor();
  for (const text of [general, first, edited]) assert.equal(await dialog.getByText(text, { exact: true }).count(), 1);
  assert.equal(await dialog.getByText(privateOther, { exact: true }).count(), 0);
  await dialog.getByLabel("Материал в очереди").selectOption(String(alreadyReturned.id));
  assert.equal(await dialog.getByText(first, { exact: true }).count(), 0);
  await button(dialog, "Закрыть").click();
  await saved(desktop);
  const studio = await state(stage.id, f.admin);
  assert.deepEqual(studio.draft.entries, []);
  assert.deepEqual(studio.materials.find(m => m.id === plan.id).notes, []);
  await desktop.context().close();

  const phone = await enter(true), footer = phone.locator(".ac-footer");
  await button(phone.locator(".ac-view-heading"), "Замечания · 4").tap();
  for (const text of [general, first, edited, historical]) await list(phone).getByText(text, { exact: true }).waitFor();
  const editor = phone.getByRole("dialog");
  await button(card(phone, general), "Изменить").tap();
  await field(phone).fill("");
  await button(editor, "Все замечания · 3").tap();
  await phone.locator(".ac-rail").getByRole("heading", { name: "Замечания · 3" }).waitFor();
  assert.equal(await list(phone).locator(".ac-draft-note").count(), 2);
  await button(card(phone, first), "Изменить").tap();
  await editor.locator(".ac-composer-marks summary").tap();
  await button(editor, "Общее замечание к материалу").tap();
  await field(phone).fill(general);
  await button(editor, "Все замечания · 4").tap();
  await button(card(phone, edited), "Показать на листе 2").tap();
  await button(phone.locator(".ac-sheet"), "Замечание 2: " + edited).waitFor();
  await button(footer, saveAndNext).waitFor();
  assert.equal(await button(footer, "Согласовать и далее").count(), 0);
  await saved(phone);
  const draftPath = "**" + route(stage.id) + "/draft";
  const holdRetry = Promise.withResolvers();
  let attempts = 0;
  const savesReturn = request => request.method() === "PUT" && request.url().endsWith("/draft") &&
    request.postDataJSON().entries.some(e => e.materialId === plan.id && e.decision === "changes_requested");
  await phone.route(draftPath, async intercepted => {
    if (savesReturn(intercepted.request())) {
      if (++attempts === 1) {
        await intercepted.fulfill({ status: 503, json: { error: "Не удалось сохранить черновик" } });
        return;
      }
      await holdRetry.promise;
    }
    await intercepted.continue();
  });
  await button(footer, saveAndNext).tap();
  await button(footer, "Повторить сохранение").waitFor();
  assert.ok(await heading(phone, plan).isVisible());
  assert.equal((await state()).draft.entries.find(e => e.materialId === plan.id).decision, null);
  try {
    await Promise.all([phone.waitForRequest(savesReturn), button(footer, "Повторить сохранение").tap()]);
    assert.ok(await heading(phone, plan).isVisible());
  } finally {
    holdRetry.resolve();
  }
  await heading(phone, next).waitFor();
  await phone.unroute(draftPath);
  await button(phone, "К отправке · 1").waitFor();
  assert.equal(attempts, 2);
  assert.equal((await state()).packages.length, 1);
  await button(footer, "Нужны правки").tap();
  await field(phone).fill("Добавить размер у окна.");
  await button(phone.getByRole("dialog"), "Закрыть").tap();
  await button(footer, saveAndNext).tap();
  await button(phone, "Перейти к сводке").tap();
  const summary = phone.getByRole("dialog");
  await summary.getByText(/2 на доработку/).waitFor();
  assert.equal((await state()).packages.length, 1);
  await button(summary, "Подтверждаю отправку").tap();
  await phone.getByText(/Пакет принят/).waitFor();
  const sent = await state(stage.id, f.admin);
  const delivered = sent.materials.find(m => m.id === plan.id);
  assert.equal(sent.packages.length, 2);
  assert.equal(delivered.currentVersion.status, "changes_requested");
  assert.deepEqual(delivered.returnComments.filter(c => c.versionId === plan.currentVersion.id).map(c => c.body), [general]);
  assert.ok(delivered.returnComments.some(c => c.body === historical && c.versionId === original.currentVersion.id));
  assert.deepEqual(delivered.notes.map(n => [n.number, n.page, n.body]), [[1, 1, first], [2, 2, edited]]);
  assert.equal((await state(adjacent.id)).draft.entries[0].comment, privateOther);

  await queue(phone);
  await phone.locator(`.ac-material[data-material-id="${plan.id}"] .ac-material-open`).tap();
  await saved(phone);
  const zoomBefore = (await state()).draft.position.zoom;
  const savesZoom = request => request.method() === "PUT" && request.url().endsWith("/draft") &&
    request.postDataJSON().position.materialId === plan.id && request.postDataJSON().position.zoom > zoomBefore;
  const failPosition = Promise.withResolvers();
  let positionAttempts = 0;
  await phone.route(draftPath, async intercepted => {
    if (savesZoom(intercepted.request()) && ++positionAttempts === 1) {
      await failPosition.promise;
      await intercepted.fulfill({ status: 503, json: { error: "Не удалось сохранить масштаб" } });
    } else await intercepted.continue();
  });
  try {
    const changedPosition = phone.waitForRequest(savesZoom);
    await button(phone, "Увеличить масштаб").tap();
    await Promise.all([changedPosition, button(footer, "Далее без решения").tap()]);
  } finally {
    failPosition.resolve();
  }
  await button(footer, "Повторить сохранение").waitFor();
  assert.ok(await heading(phone, plan).isVisible());
  await button(footer, "Повторить сохранение").tap();
  await heading(phone, alreadyReturned).waitFor();
  await saved(phone);
  assert.equal(positionAttempts, 2);
  await phone.unroute(draftPath);
  const skipped = await state();
  assert.deepEqual(skipped.draft.entries, []);
  assert.equal(skipped.packages.length, 2);

  const note = skipped.materials.find(m => m.id === alreadyReturned.id).notes[0];
  const event = `/api/approval-center/notes/${note.id}/events`, versionId = note.versionId;
  await f.api(event, { type: "fixed", body: "Высота полки уточнена.", versionId, expectedRevision: note.revision }, f.admin);
  await f.api(`/api/approval-center/versions/${versionId}/view`, { page: 1 }, client.cookie);
  await f.api(event, { type: "confirmed", body: "Исправление проверено.", versionId, expectedRevision: note.revision + 1 }, client.cookie);
  await phone.reload();
  await openProject(phone, project.id, { client: true });
  await phone.locator("#tab-review").click();
  await queue(phone);
  await phone.locator(`.ac-material[data-material-id="${alreadyReturned.id}"] .ac-material-open`).tap();
  await button(footer, "Согласовать и далее").waitFor();
  assert.equal(await button(footer, "Далее без решения").count(), 0);
  await phone.context().close();

  const uploaded = await upload("План потолка");
  const ceiling = (await state()).materials.find(m => m.id === uploaded.review.materialId);
  const review = await enter(), form = review.getByRole("dialog");
  const ceilingRow = review.locator(`.ac-material[data-material-id="${ceiling.id}"]`);
  const sameText = "Уточнить привязку светильника у входа.";
  await ceilingRow.locator(".ac-material-open").click();
  await heading(review, ceiling).waitFor();
  await review.getByText("Все страницы просмотрены", { exact: true }).waitFor();
  await button(review, "Нужны правки").click();
  await field(review).fill(sameText);
  await button(form, "Поставить отметку на документе").click();
  await review.locator(".ac-sheet").click({ position: { x: 120, y: 85 } });
  await form.locator(".ac-composer-marks summary").click();
  await button(form, "Общее замечание к материалу").click();
  await field(review).fill(sameText);
  await button(form, "Все замечания · 2").click();
  await review.locator(".ac-rail").getByRole("heading", { name: "Замечания · 2" }).waitFor();
  assert.equal(await card(review, sameText).count(), 2);
  await Promise.all([
    review.waitForEvent("dialog").then(d => { assert.equal(d.type(), "confirm"); return d.accept(); }),
    button(review.locator(".ac-rail"), "Согласовать с замечаниями").click(),
  ]);
  await button(review, "К отправке · 1").click();
  const decision = form.locator("article").filter({ hasText: "План потолка" });
  await decision.getByText("К отправке: согласование", { exact: true }).waitFor();
  await decision.getByText(sameText, { exact: true }).waitFor();
  await decision.getByText("Отметка 1 · стр. 1 · " + sameText, { exact: true }).waitFor();
  assert.equal((await state()).materials.find(m => m.id === ceiling.id).currentVersion.status, "pending_approval");
  await button(form, "Подтверждаю отправку").click();
  await review.getByText(/Пакет принят/).waitFor();
  await ceilingRow.getByText("Согласовано", { exact: true }).waitFor();
  await ceilingRow.locator(".ac-material-open").click();
  await button(review.locator(".ac-view-heading"), "Замечания · 2").click();
  const published = list(review).locator("article").filter({ hasText: sameText });
  assert.equal(await published.count(), 2);
  assert.equal(await published.getByText(sameText, { exact: true }).count(), 2);
  await published.getByText("Замечание к версии", { exact: true }).waitFor();
  await published.getByText("Замечание клиента №1", { exact: true }).waitFor();
  const accepted = (await state(stage.id, f.admin)).materials.find(m => m.id === ceiling.id);
  assert.equal(accepted.currentVersion.status, "approved");
  assert.equal(accepted.notes[0].status, "open");
  await f.api(`/api/material-versions/${accepted.currentVersion.id}/cancel`, {
    confirm: true, reason: "Повторно проверить привязку светильника.", expectedRevision: accepted.currentVersion.revision,
  }, f.admin);
  await review.reload();
  await openProject(review, project.id, { client: true });
  await review.locator("#tab-review").click();
  await button(review, "Выбрать").click();
  await ceilingRow.getByRole("checkbox").check();
  await button(review, "Согласовать выбранные · 1").click();
  await form.getByRole("heading", { name: "Проверьте состав выбора" }).waitFor();
  await form.getByRole("listitem").filter({ hasText: "План потолка · Есть открытые замечания" }).waitFor();
  assert.equal(await button(form, "Подготовить решения").count(), 0);
  await button(form, "Закрыть").click();
  const reopened = await state();
  assert.equal(reopened.materials.find(m => m.id === ceiling.id).currentVersion.status, "pending_approval");
  assert.deepEqual(reopened.draft.entries, []);
  console.log("PASS", browser.version(), "material and stage remarks, private drafts, save and skip retries, approval with separate remarks, bulk protection and explicit submission");
} finally {
  await browser?.close();
  await f.close();
}

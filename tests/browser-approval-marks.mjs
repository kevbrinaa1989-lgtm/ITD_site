import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ownershipFixture } from "./ownership-fixture.mjs";
import { drawing } from "./approval-demo.mjs";
import { openFiles, openGlobal, openProject } from "./browser-navigation.mjs";
import { action, button, editDraftRemark, notes, saved, summary } from "./approval-navigation.mjs";

const { chromium } = await import(process.env.ITD_PLAYWRIGHT_MODULE || "playwright");
const f = await ownershipFixture();
let browser;
try {
  const project = f.projects[0], stage = project.stages[0], client = f.clients[0];
  const path = `/api/approval-center/projects/${project.id}/stages/${stage.id}`;
  const state = () => f.api(path, null, client.cookie);
  async function upload(title, pages) {
    return f.api(`/api/projects/${project.id}/files`, {
      name: title + ".pdf", contentType: "application/pdf", category: "result",
      stageId: stage.id, review: true, data: await drawing(title, pages),
    }, f.admin, "POST", 201);
  }
  await upload("План перегородок", 2);
  browser = await chromium.launch({ executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox"] });
  const errors = [];
  async function center(page, studio = false) {
    await openProject(page, project.id, { client: !studio });
    await page.locator("#tab-review").click();
    await page.locator(".ac-sheet canvas").waitFor();
    await page.evaluate(() => document.fonts.ready);
  }
  async function enter(studio = false, mobile = false) {
    const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(f.base + "/cabinet");
    await page.locator("#login-email").fill(studio ? "admin@example.test" : client.email);
    await page.locator("#login-password").fill(f.password);
    await page.locator("#login-form .primary").click();
    await center(page, studio);
    return page;
  }
  async function shot(page, name) {
    if (!process.env.ITD_SCREENSHOT_DIR || process.env.ITD_NO_SCREENSHOTS) return;
    await mkdir(process.env.ITD_SCREENSHOT_DIR, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(process.env.ITD_SCREENSHOT_DIR, name + ".png"), animations: "disabled" });
  }
  async function submit(page) {
    await summary(page);
    await button(page.getByRole("dialog"), "Подтверждаю отправку").click();
    await page.getByText(/Пакет принят/).waitFor();
  }

  const author = await enter();
  const form = author.getByRole("dialog"), sheet = author.locator(".ac-sheet");
  const field = form.getByLabel("Текст замечания", { exact: true });
  const marks = [
    { page: 1, x: 0.32, y: 0.44, body: "Уточнить ширину прохода у дивана." },
    { page: 1, x: 0.76, y: 0.66, body: "Подписать ширину дверного проёма." },
    { page: 2, x: 0.48, y: 0.63, body: "Показать расстояние до перегородки." },
  ];
  async function putPoint(page, { x, y }, touch = false) {
    const canvas = page.locator(".ac-sheet");
    // Opening the pin toolbar can resize the fitted sheet. Measure after the
    // browser has painted the page and the target has stopped moving.
    await canvas.locator("canvas").waitFor();
    await canvas.click({ trial: true });
    const box = await canvas.boundingBox();
    const position = { x: box.width * x, y: box.height * y };
    if (touch) await canvas.tap({ position });
    else await canvas.click({ position });
    await page.getByRole("dialog").waitFor();
  }
  function verifyMarks(actual) {
    assert.equal(actual.length, marks.length);
    actual.forEach((actualMark, i) => {
      assert.equal(actualMark.page, marks[i].page);
      assert.equal(actualMark.body, marks[i].body);
      assert.ok(Math.abs(actualMark.x - marks[i].x) < 0.01 && Math.abs(actualMark.y - marks[i].y) < 0.01,
        `Pin ${i + 1} at ${actualMark.x}, ${actualMark.y}, expected ${marks[i].x}, ${marks[i].y}`);
    });
  }
  await button(author, "Нужны правки").click();
  await field.fill("Черновая формулировка первой отметки");
  await button(form, "Поставить отметку на документе").click();
  await putPoint(author, marks[0]);
  assert.equal(await field.inputValue(), "Черновая формулировка первой отметки");
  await field.fill(marks[0].body);
  await button(form, "Добавить ещё одну отметку").click();
  await putPoint(author, { x: 0.58, y: 0.6 });
  await field.fill(marks[1].body);
  await button(form, "Переместить отметку · стр. 1").click();
  await putPoint(author, marks[1]);
  await button(form, "Добавить ещё одну отметку").click();
  await author.getByLabel("Перейти на страницу").selectOption("2");
  await author.getByText("Все страницы просмотрены", { exact: true }).waitFor();
  await putPoint(author, marks[2]);
  await field.fill(marks[2].body);
  await button(form, "Закрыть").click();
  await saved(author);
  let entry = (await state()).draft.entries[0];
  verifyMarks(entry.markers);
  assert.equal(entry.comment, "", "attaching the first text to a point must not leave an obsolete general remark");
  assert.equal(entry.decision, null);

  await author.reload();
  await center(author);
  await author.getByLabel("Перейти на страницу").selectOption("1");
  const firstPin = button(sheet, "Замечание 1: " + marks[0].body);
  await firstPin.click();
  assert.equal(await field.inputValue(), marks[0].body);
  await saved(author);
  await author.context().close();

  const mobileEditor = await enter(false, true);
  const mobileForm = mobileEditor.getByRole("dialog");
  await button(mobileEditor.locator(".ac-sheet"), "Замечание 1: " + marks[0].body).tap();
  await button(mobileForm, "Добавить ещё одну отметку").tap();
  await putPoint(mobileEditor, { x: 0.82, y: 0.37 }, true);
  await mobileForm.getByLabel("Текст замечания").fill("Временная отметка");
  await mobileForm.locator(".ac-composer-marks summary").tap();
  await button(mobileForm, "Убрать отметку").tap();
  const general = "Уточните размеры в трёх отмеченных местах.";
  await mobileForm.getByLabel("Текст замечания").fill(general);
  await button(mobileForm, "Подготовить и далее").tap();
  await saved(mobileEditor);
  entry = (await state()).draft.entries[0];
  verifyMarks(entry.markers);
  assert.equal(entry.comment, general);
  assert.equal(entry.decision, "changes_requested");
  await submit(mobileEditor);
  const returned = await state();
  assert.equal(returned.materials[0].currentVersion.status, "changes_requested");
  verifyMarks(returned.materials[0].notes);
  assert.deepEqual(returned.materials[0].returnComments.map(n => n.body), [general]);
  await mobileEditor.context().close();

  const studio = await enter(true);
  await notes(studio);
  await studio.locator(".ac-notes").getByText(general, { exact: true }).waitFor();
  await studio.getByLabel("Перейти на страницу").selectOption("1");
  await button(studio.locator(".ac-sheet"), "Замечание 2: " + marks[1].body).waitFor();
  for (const note of returned.materials[0].notes) {
    const card = studio.locator("#ac-note-" + note.id);
    await button(card, "Отметить исправленным").click();
    const reply = studio.getByRole("dialog");
    await reply.getByLabel("Пояснение").fill("Размер проверен по чертежу, уточнение по отметке №" + note.number + " передано клиенту.");
    await button(reply, "Сохранить в истории").click();
    await reply.waitFor({ state: "hidden" });
  }
  const phone = await enter(false, true);
  await notes(phone);
  for (const note of returned.materials[0].notes) {
    const card = phone.locator("#ac-note-" + note.id);
    await button(card, "Подтвердить исправление").click();
    const confirmation = phone.getByRole("dialog");
    await confirmation.getByText(note.body, { exact: true }).waitFor();
    await button(confirmation, "Сохранить в истории").click();
    await confirmation.waitFor({ state: "hidden" });
    if (note.number < marks.length) {
      assert.ok(await phone.locator(".ac-rail").isVisible());
      assert.equal((await state()).materials[0].canApproveAfterCorrection, false);
    }
  }
  await phone.locator(".ac-rail").waitFor({ state: "hidden" });
  await phone.locator(".ac-sheet canvas").waitFor();
  const approval = phone.locator(".ac-footer button.ac-approve:enabled");
  await approval.waitFor();
  assert.ok(await approval.evaluate(b => {
    const r = b.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight && b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  }));
  await saved(phone);
  await shot(phone, "marks-ready-mobile");
  assert.equal((await state()).materials[0].currentVersion.status, "changes_requested");
  const awaitingClient = "Ожидает согласования клиента";
  await action(studio, "Обновить данные");
  await studio.locator(".ac-material.is-selected").getByText(awaitingClient, { exact: true }).waitFor();
  await studio.locator(".ac-footer").getByText(awaitingClient, { exact: true }).waitFor();
  await openFiles(studio, "result", { stageIndex: 0 });
  await studio.locator(".library-status").getByText(awaitingClient, { exact: true }).waitFor();
  await studio.context().close();
  await openGlobal(phone, "client-home");
  const next = phone.locator("#client-home-panel .client-next-decision");
  await next.getByRole("heading", { name: "План перегородок", exact: true }).waitFor();
  await button(next, "Перейти к согласованию").tap();
  await phone.locator(".ac-sheet canvas").waitFor();
  await saved(phone);
  const confirmPath = "**/api/approval-center/versions/*/view";
  const confirmation = Promise.withResolvers();
  let rejectFirstConfirmation = true;
  await phone.route(confirmPath, async route => {
    if (route.request().postDataJSON()?.confirm) {
      if (rejectFirstConfirmation) {
        rejectFirstConfirmation = false;
        await route.fulfill({ status: 503, json: { error: "Соединение прервано" } });
        return;
      }
      await confirmation.promise;
    }
    await route.continue();
  });
  await approval.click();
  await phone.locator('.ac-save[data-state="error"]').getByText("Решение не сохранено", { exact: true }).waitFor();
  assert.equal((await state()).draft.entries.length, 0);
  try {
    await Promise.all([
      phone.waitForRequest(request => request.url().endsWith("/view") &&
        request.method() === "POST" && request.postDataJSON()?.confirm === true),
      button(phone, "Повторить сохранение просмотра").click(),
    ]);
    await phone.locator('.ac-save[data-state="saving"]').getByText("Сохраняем", { exact: true }).waitFor();
  } finally {
    confirmation.resolve();
  }
  await button(phone, "К отправке · 1").waitFor();
  await saved(phone);
  await phone.unroute(confirmPath);
  const prepared = await state();
  assert.equal(prepared.materials[0].currentVersion.status, "changes_requested");
  assert.equal(prepared.draft.entries[0].decision, "approved");
  await submit(phone);
  const after = await state();
  assert.equal(after.materials[0].currentVersion.status, "approved");
  assert.equal(after.materials[0].versions.length, 1);
  assert.equal(after.packages.length, 2);
  assert.equal(after.stage.acceptedSeparately, false);
  await openGlobal(phone, "client-review");
  const decisions = phone.locator("#client-review-panel");
  await button(decisions, "История").click();
  const history = decisions.getByRole("list", { name: "История решений по версии 1" });
  assert.match(await history.innerText(), /Отправлено на доработку[\s\S]+Согласовано/);
  await phone.context().close();

  // Restore a large draft, then exercise the last available point in both places a client can add one.
  const fullPlan = await upload("План привязок", 1);
  const before = await state();
  const target = before.materials.find(m => m.id === fullPlan.review.materialId);
  const existing = Array.from({ length: 99 }, (_, i) => ({
    page: 1, x: (i % 10 + 0.5) / 10, y: (Math.floor(i / 10) + 0.5) / 10, body: "Место на плане " + (i + 1),
  }));
  await f.api(path + "/draft", {
    expectedRevision: before.draft.revision, position: { materialId: target.id, versionId: target.currentVersion.id },
    entries: [{ materialId: target.id, versionId: target.currentVersion.id, expectedRevision: target.currentVersion.revision,
      decision: null, comment: "", markers: existing }],
  }, client.cookie, "PUT");
  const large = await enter();
  await large.locator(`.ac-material[data-material-id="${target.id}"] .ac-material-open`).click();
  await large.locator(".ac-sheet canvas").waitFor();
  await editDraftRemark(large, existing[0].body);
  const largeForm = large.getByRole("dialog");
  const add = button(largeForm, "Добавить ещё одну отметку");
  await add.click();
  await putPoint(large, { x: 0.95, y: 0.95 });
  await largeForm.getByLabel("Текст замечания").fill("Сотая отметка");
  assert.ok(await add.isDisabled());
  assert.match(await add.getAttribute("title"), /100/);
  await button(largeForm, "Закрыть").click();
  await saved(large);
  await notes(large);
  assert.ok(await button(large.locator(".ac-rail"), "Добавить ещё одну отметку").isDisabled());
  await editDraftRemark(large, "Сотая отметка");
  await largeForm.locator(".ac-composer-marks summary").click();
  await button(largeForm, "Убрать отметку").click();
  assert.ok(await add.isEnabled());
  await add.click();
  await putPoint(large, { x: 0.92, y: 0.92 });
  await largeForm.getByLabel("Текст замечания").fill("Перенесённая сотая отметка");
  await button(largeForm, "Подготовить и далее").click();
  await saved(large);
  await submit(large);
  const full = (await state()).materials.find(m => m.id === target.id);
  assert.equal(full.notes.length, 100);
  assert.equal(full.notes.at(-1).body, "Перенесённая сотая отметка");
  assert.deepEqual(errors, []);
  console.log("PASS", browser.version(), "three individually restored PDF marks, touch editing, same-version mobile acceptance from Home, both archived decisions and the hundred-point limit");
} finally {
  await browser?.close();
  await f.close();
}

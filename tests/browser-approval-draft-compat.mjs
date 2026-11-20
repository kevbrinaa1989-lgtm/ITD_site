import assert from "node:assert/strict";
import { ownershipFixture } from "./ownership-fixture.mjs";
import { drawing } from "./approval-demo.mjs";
import { openProject, openGlobal } from "./browser-navigation.mjs";
import { button, closeNotes, notes, saved, summary } from "./approval-navigation.mjs";

const { chromium } = await import(process.env.ITD_PLAYWRIGHT_MODULE || "playwright");
const f = await ownershipFixture();
let browser;
try {
  const project = f.projects[0], stage = project.stages[0], client = f.clients[0];
  const route = `/api/approval-center/projects/${project.id}/stages/${stage.id}`;
  const state = () => f.api(route, null, client.cookie);
  await f.api(`/api/projects/${project.id}/files`, {
    name: "Проверка проходов.pdf", contentType: "application/pdf", category: "result",
    stageId: stage.id, review: true, data: await drawing("Проверка проходов", 2),
  }, f.admin, "POST", 201);
  const before = await state(), material = before.materials[0], version = material.currentVersion;
  const oldText = "Увеличить проход до 90 см.", correctedText = "Оставить проход шириной 100 см.";
  // Older drafts automatically copied the first pinned remark into the general comment.
  await f.api(`/api/approval-center/versions/${version.id}/view`, { page: 2 }, client.cookie);
  await f.api(route + "/draft", {
    expectedRevision: before.draft.revision,
    entries: [{ materialId: material.id, versionId: version.id, expectedRevision: version.revision,
      decision: null, comment: oldText, markers: [{ page: 2, x: 0.38, y: 0.46, body: oldText }] }],
    position: { materialId: material.id, versionId: version.id, page: 2 },
  }, client.cookie, "PUT");

  browser = await chromium.launch({ executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept());
  const dialog = page.getByRole("dialog"), field = dialog.getByLabel("Текст замечания", { exact: true });
  const sheet = page.locator(".ac-sheet");
  async function enter() {
    await openProject(page, project.id, { client: true });
    await page.locator("#tab-review").click();
    await sheet.locator("canvas").waitFor();
  }
  async function send() {
    await button(dialog, "Подтверждаю отправку").click();
    await page.getByText(/Пакет принят/).waitFor();
  }
  await page.goto(f.base + "/cabinet");
  await page.locator("#login-email").fill(client.email);
  await page.locator("#login-password").fill(f.password);
  await page.locator("#login-form .primary").click();
  await enter();
  await button(page, "Нужны правки").click();
  await button(dialog, "Переместить отметку · стр. 2").waitFor();
  assert.equal(await field.inputValue(), oldText);
  await field.fill(correctedText);
  await button(dialog, "Подготовить и далее").click();
  await saved(page);
  await summary(page);
  assert.equal(await dialog.getByText(oldText, { exact: true }).count(), 0);
  await send();
  const returned = (await state()).materials[0];
  assert.deepEqual(returned.returnComments, []);
  assert.deepEqual(returned.notes.map(n => n.body), [correctedText]);

  const notePath = `/api/approval-center/notes/${returned.notes[0].id}/events`;
  async function noteEvent(type, body, actor) {
    const note = (await state()).materials[0].notes[0];
    await f.api(notePath, { type, body, versionId: version.id, expectedRevision: note.revision }, actor);
  }
  await noteEvent("fixed", "Размер проверен", f.admin);
  await enter();
  await page.getByLabel("Перейти на страницу").selectOption("1");
  await sheet.locator('canvas[aria-label$="страница 1"]').waitFor();
  await notes(page);
  await button(page.locator("#ac-note-" + returned.notes[0].id), "Подтвердить исправление").click();
  await button(dialog, "Сохранить в истории").click();
  await dialog.waitFor({ state: "hidden" });
  await openGlobal(page, "client-home");
  await button(page.locator("#client-home-panel"), "Перейти к согласованию").click();
  await page.locator(".ac-footer .ac-approve:enabled").click();
  await saved(page);
  await summary(page);

  // The client and the studio finish another round in a different session while the summary is open.
  await noteEvent("reopened", "Перепроверить размер", client.cookie);
  await noteEvent("fixed", "Проверен ещё раз", f.admin);
  await noteEvent("confirmed", "Уточнение принято", client.cookie);
  await button(dialog, "Подтверждаю отправку").click();
  await dialog.getByRole("alert").waitFor();
  assert.equal((await state()).packages.length, 1);
  await button(dialog, "Изменить").click();
  await button(page, "Убрать старый черновик после проверки").click();
  await closeNotes(page);
  await page.locator(".ac-footer .ac-approve:enabled").click();
  await saved(page);
  await summary(page);
  await send();
  const approved = await state();
  assert.equal(approved.packages.length, 2);
  assert.equal(approved.materials[0].currentVersion.status, "approved");

  // The original pin stays on the drawing after the studio asks for another decision on this file.
  await f.api(`/api/material-versions/${version.id}/cancel`, { confirm: true,
    reason: "Нужно уточнить ещё один проход", expectedRevision: approved.materials[0].currentVersion.revision }, f.admin);
  await page.reload();
  await enter();
  await page.getByLabel("Перейти на страницу").selectOption("2");
  await sheet.locator('canvas[aria-label$="страница 2"]').waitFor();
  await button(page, "Нужны правки").click();
  await button(dialog, "Поставить отметку на документе").click();
  const rect = await sheet.boundingBox();
  await sheet.tap({ position: { x: rect.width * 0.7, y: rect.height * 0.7 } });
  await dialog.getByText("Отметка 2 · стр. 2", { exact: true }).waitFor();
  const secondText = "Уточнить размеры второго прохода.", revisedText = "Второй проход оставить шириной 110 см.";
  await field.fill(secondText);
  await dialog.locator(".ac-composer-marks summary").click();
  await button(dialog, "Общее замечание к материалу").click();
  await field.fill(secondText);
  await button(dialog, "Закрыть").click();
  await saved(page);
  await page.reload();
  await enter();
  assert.deepEqual(await sheet.locator(".ac-pin").allTextContents(), ["1", "2"]);
  await button(sheet, `Замечание 2: ${secondText}`).click();
  await field.fill(revisedText);
  await button(dialog, "Подготовить и далее").click();
  await saved(page);
  await summary(page);
  await dialog.getByText(secondText, { exact: true }).waitFor();
  await dialog.getByText(`Отметка 2 · стр. 2 · ${revisedText}`, { exact: true }).waitFor();
  await send();
  const final = await state();
  assert.deepEqual(final.materials[0].notes.map(n => [n.number, n.body]), [[1, correctedText], [2, revisedText]]);
  assert.deepEqual(final.materials[0].returnComments.map(c => c.body), [secondText]);
  const statement = await f.api(`/api/approval-center/packages/${final.packages[0].id}`, null, client.cookie);
  assert.equal(statement.materials[0].markers[0].number, 2);
  assert.deepEqual(errors, []);
  console.log("PASS", browser.version(), "legacy and independent remark text, stale correction recovery, consistent pin numbers after cancellation");
} finally {
  await browser?.close();
  await f.close();
}

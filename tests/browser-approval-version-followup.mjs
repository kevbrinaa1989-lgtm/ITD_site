import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { drawing } from "./approval-demo.mjs";
import { action, button, markForRevision, menu, notes, queue, saved, summary } from "./approval-navigation.mjs";
import { leaveApproval, openFiles, openProject } from "./browser-navigation.mjs";
import { ownershipFixture } from "./ownership-fixture.mjs";
import { jpeg } from "./preview-fixtures.mjs";

const { chromium } = await import(process.env.ITD_PLAYWRIGHT_MODULE || "playwright");
const f = await ownershipFixture();
const [project] = f.projects, [stage, otherStage] = project.stages, [client] = f.clients;
const path = `/api/approval-center/projects/${project.id}/stages/${stage.id}`;
const state = () => f.api(path, null, client.cookie);
const errors = [];
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox"] });
  async function login(studio, mobile = false) {
    const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(f.base + "/cabinet");
    await page.locator("#login-email").fill(studio ? "admin@example.test" : client.email);
    await page.locator("#login-password").fill(f.password);
    await page.locator("#login-form .primary").click();
    await openProject(page, project.id, { client: !studio });
    return page;
  }
  async function upload(destination, name, contentType, bytes) {
    return f.api(`/api/projects/${project.id}/files`, {
      stageId: destination.id, name, contentType, data: bytes.toString("base64"), category: "result", review: true,
    }, f.admin, "POST", 201);
  }
  async function submit(page) {
    await summary(page);
    await button(page.getByRole("dialog"), "Подтверждаю отправку").click();
    await page.getByText(/Пакет принят/).waitFor();
  }
  async function checkDownload(page, link, file, bytes) {
    const href = await link.getAttribute("href");
    assert.equal(href, `/api/files/${file.id}/download`);
    const response = await page.request.get(new URL(href, f.base).href);
    assert.equal(response.status(), 200);
    assert.equal(response.headers()["content-type"].split(";")[0], file.contentType);
    assert.deepEqual(await response.body(), bytes);
  }
  async function shot(page, name) {
    if (!process.env.ITD_SCREENSHOT_DIR || process.env.ITD_NO_SCREENSHOTS) return;
    await mkdir(process.env.ITD_SCREENSHOT_DIR, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: join(process.env.ITD_SCREENSHOT_DIR, name + ".png"), animations: "disabled" });
  }
  const originalPdf = Buffer.from(await drawing("Обмерный план", 1), "base64");
  await upload(stage, "Обмерный план.pdf", "application/pdf", originalPdf);
  const plan = (await state()).materials[0], old = plan.currentVersion;
  const author = await login(false);
  await author.locator("#tab-review").click();
  const canvas = author.locator(".ac-sheet canvas");
  await author.getByText("Все страницы просмотрены", { exact: true }).waitFor();
  const scan = await canvas.screenshot({ type: "jpeg" });
  await markForRevision(author, "Нужен скан обмеров коридора.", { x: 150, y: 90 });
  await submit(author);
  const returned = await state();
  assert.equal(returned.materials[0].currentVersion.status, "changes_requested");
  assert.equal(returned.draft.position.versionId, old.id);
  await author.context().close();

  const furniturePdf = Buffer.from(await drawing("План мебели", 1), "base64");
  await upload(stage, "План мебели.pdf", "application/pdf", furniturePdf);
  await upload(otherStage, "Ракурс другого этапа.jpg", "image/jpeg", jpeg);
  const furniture = (await state()).materials[1];
  const admin = await login(true);
  await admin.locator("#tab-review").click();
  let uploads = 0;
  admin.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === `/api/projects/${project.id}/files`) uploads++;
  });
  const row = material => admin.locator(`.ac-material[data-material-id="${material.id}"]`);
  const form = admin.getByRole("dialog");
  const newName = "Скан обмеров коридора.jpg";
  await button(admin, "Открыть замечания").click();
  await button(admin, "Загрузить исправленную версию").click();
  await form.getByLabel("Файл новой версии").setInputFiles({ name: newName, mimeType: "image/jpeg", buffer: scan });
  await form.getByText(/PDF\s*→\s*JPG/).waitFor();
  await form.getByRole("radio", { name: "Исправлено", exact: true }).check();
  await form.getByLabel("Что исправлено", { exact: true }).fill("Приложен скан обмеров.");
  await shot(admin, "version-format-desktop");
  await button(form, "Отправить новую версию").evaluate(b => { b.click(); b.click(); });
  await form.waitFor({ state: "hidden" });
  await admin.locator(".ac-sheet img").waitFor();
  await row(plan).getByText("Ожидает проверки клиента", { exact: true }).waitFor();
  await admin.locator(".ac-view-heading").getByText(newName, { exact: false }).waitFor();
  const revised = (await state()).materials[0], current = revised.currentVersion;
  assert.deepEqual(revised.versions.map(v => v.id), [old.id, current.id]);
  assert.equal(revised.id, plan.id);
  assert.equal(revised.stageId, stage.id);
  assert.equal(current.file.name, newName);
  assert.equal(current.status, "pending_approval");
  assert.equal(uploads, 1);
  await admin.locator(".ac-notice").getByText(/Версия 2 отправлена клиенту\./).waitFor();
  await shot(admin, "version-delivered-desktop");
  await menu(admin);
  const download = admin.locator(".ac-menu-items a[download]");
  await checkDownload(admin, download, current.file, scan);
  await admin.getByLabel("Версия", { exact: true }).selectOption(String(old.id));
  await admin.locator(".ac-sheet canvas").waitFor();
  await admin.locator(".ac-footer").getByText("Архивная версия", { exact: true }).waitFor();
  await button(admin.locator(".ac-view-heading"), `Полное имя файла: ${old.file.name}`).click();
  await checkDownload(admin, admin.getByRole("link", { name: "Скачать файл этой версии" }), old.file, originalPdf);
  await menu(admin);
  await admin.getByLabel("Версия", { exact: true }).selectOption(String(current.id));
  await action(admin, "Обновить данные");
  await admin.locator(".ac-sheet img").waitFor();

  await queue(admin);
  await row(furniture).locator(".ac-material-open").click();
  await admin.locator(".ac-sheet canvas").waitFor();
  await notes(admin);
  await button(admin, "Загрузить исправленную версию").click();
  const revisedPdf = Buffer.from(await drawing("План мебели", 2, true, 2), "base64");
  const pdfName = "План мебели с размерами.pdf";
  await form.getByLabel("Файл новой версии").setInputFiles({ name: pdfName, mimeType: "application/pdf", buffer: revisedPdf });
  await form.getByText(`Новый файл · PDF · ${pdfName}`, { exact: true }).waitFor();
  await form.getByLabel("Что изменено", { exact: true }).fill("Указаны размеры на втором листе.");
  // The upload succeeds, but the first read of the stage fails after it was saved.
  await admin.route("**" + path, request => request.fulfill({ status: 503, json: { error: "Обновление временно недоступно" } }), { times: 1 });
  await button(form, "Отправить новую версию").click();
  await form.waitFor({ state: "hidden" });
  const retry = button(admin, "Повторить обновление");
  await retry.waitFor();
  assert.equal((await state()).materials[1].versions.length, 2);
  await retry.click();
  await admin.locator(".ac-view-heading").getByText(pdfName, { exact: false }).waitFor();
  assert.equal(uploads, 2, "retrying a read must not upload a third file");
  await admin.getByLabel("Перейти на страницу").selectOption("2");
  const materials = (await state()).materials;
  assert.deepEqual(materials.map(m => m.id), [plan.id, furniture.id]);
  assert.deepEqual(materials.map(m => m.versions.length), [2, 2]);
  await menu(admin);
  await checkDownload(admin, download, materials[1].currentVersion.file, revisedPdf);

  await leaveApproval(admin);
  await admin.locator("#tab-overview").click();
  await admin.locator("#project-route .route-step").first().click();
  const route = admin.locator("#project-route");
  await button(route, "Открыть: Материалы этапа").waitFor();
  await button(route, "Открыть: Альбом этапа").click();
  const album = admin.locator("#project-gallery");
  await admin.locator("#library-title").getByText(`Альбом этапа «${stage.title}»`, { exact: true }).waitFor();
  await admin.locator("#library-count").getByText("Изображений в альбоме · 1", { exact: true }).waitFor();
  assert.equal(await admin.locator("#library-results-count").isVisible(), false);
  await album.locator(".album-filename").getByText(newName, { exact: true }).waitFor();
  assert.match(await album.locator(".album-topline").innerText(), /Версия 2/);
  assert.equal(await album.locator(".album-next").isVisible(), false);
  await checkDownload(admin, album.locator("a[download]"), current.file, scan);
  await album.locator(".album-hero-media button").click();
  const imageViewer = admin.getByRole("dialog", { name: "Просмотр материала" });
  await imageViewer.getByRole("heading", { name: newName }).waitFor();
  await button(imageViewer, "Закрыть").click();
  await shot(admin, "version-stage-album-desktop");
  await button(admin, "Все материалы этапа · 2").click();
  const cards = admin.locator(".library-material");
  assert.deepEqual(await cards.evaluateAll(items => items.map(n => +n.dataset.fileId)),
    materials.map(m => m.currentVersion.file.id));
  await admin.locator("#library-title").getByText(`Материалы этапа «${stage.title}»`, { exact: true }).waitFor();
  await cards.first().getByText(newName, { exact: false }).waitFor();
  await cards.nth(1).locator("canvas").waitFor();
  await shot(admin, "version-stage-materials-desktop");
  await cards.first().locator(".library-history").click();
  await admin.locator(".ac-sheet img").waitFor();
  await admin.locator("[data-library-return]").click();
  await cards.nth(1).locator(".library-history").click();
  await admin.locator(".ac-sheet canvas").waitFor();
  await admin.locator(".ac-view-heading").getByText(pdfName, { exact: false }).waitFor();

  const phone = await login(false, true);
  await openFiles(phone, "result", { stageIndex: 0 });
  const pdfCard = phone.locator(`.library-material[data-file-id="${materials[1].currentVersion.file.id}"]`);
  await pdfCard.scrollIntoViewIfNeeded();
  const cover = pdfCard.locator("canvas");
  await cover.waitFor();
  assert.ok(await cover.evaluate(canvas => canvas.width > 1 && canvas.height > 1));
  for (const m of (await state()).materials) {
    const version = m.versions.find(v => v.id === m.currentVersion.id);
    assert.deepEqual(version.viewedPageNumbers, [], "loading a thumbnail must not register a page view");
    assert.equal(version.confirmedView, false);
  }
  // The client last saw v1 before the designer uploaded v2. An ordinary return must open the current file.
  await phone.locator("#tab-review").click();
  await phone.locator(".ac-sheet img").waitFor();
  const filename = button(phone.locator(".ac-view-heading"), `Полное имя файла: ${newName}`);
  await filename.tap();
  assert.equal(await filename.getAttribute("aria-expanded"), "true");
  assert.equal(await filename.innerText(), newName);
  await checkDownload(phone, phone.getByRole("link", { name: "Скачать файл этой версии" }), current.file, scan);
  await phone.getByText("Все страницы просмотрены", { exact: true }).waitFor();
  await saved(phone);
  await shot(phone, "version-resumed-mobile");
  await notes(phone);
  await button(phone, "Подтвердить исправление").click();
  await button(phone.getByRole("dialog"), "Сохранить в истории").click();
  await phone.locator(".ac-footer .ac-approve:enabled").click();
  await saved(phone);
  await submit(phone);
  const final = (await state()).materials;
  assert.equal(final[0].currentVersion.id, current.id);
  assert.equal(final[0].currentVersion.status, "approved");
  assert.equal(final[0].versions[0].status, "changes_requested");
  assert.equal(final[1].currentVersion.status, "pending_approval");
  await phone.context().close();

  // The server has saved A, but the browser receives the result after the designer starts a reply on B.
  await upload(otherStage, "Развёртка стен.pdf", "application/pdf", furniturePdf);
  const otherPath = `/api/approval-center/projects/${project.id}/stages/${otherStage.id}`;
  const other = await f.api(otherPath, null, client.cookie);
  const [sending, next] = other.materials;
  const pending = await f.api(otherPath + "/draft", {
    expectedRevision: other.draft.revision, position: {},
    entries: other.materials.map(m => ({ materialId: m.id, versionId: m.currentVersion.id,
      expectedRevision: m.currentVersion.revision, decision: "changes_requested", comment: "Уточните размеры.", markers: [] })),
  }, client.cookie, "PUT");
  await f.api(otherPath + "/submit", { expectedRevision: pending.revision, operationId: "delayed-studio-revision", confirm: true }, client.cookie);
  await admin.locator("#approval-center").getByLabel("Этап", { exact: true }).selectOption(String(otherStage.id));
  const filter = admin.getByLabel("Показывать");
  await filter.selectOption("changes_requested");
  await row(sending).locator(".ac-material-open").click();
  await notes(admin);
  await button(admin, "Загрузить исправленную версию").click();
  const delayedName = "Обмер с уточнёнными размерами.pdf";
  await form.getByLabel("Файл новой версии").setInputFiles({ name: delayedName, mimeType: "application/pdf", buffer: originalPdf });
  await form.getByLabel("Что изменено", { exact: true }).fill("Добавлены размеры.");
  const uploadsBeforeMove = uploads;
  const committed = Promise.withResolvers(), release = Promise.withResolvers();
  await admin.route(f.base + `/api/projects/${project.id}/files`, async uploadRequest => {
    const response = await uploadRequest.fetch();
    committed.resolve(response.status());
    await release.promise;
    await uploadRequest.fulfill({ response });
  }, { times: 1 });
  const discussion = admin.getByLabel("Комментарий к версии", { exact: true });
  const message = "Здесь обсудим положение выключателя.";
  const finishRetry = Promise.withResolvers();
  let readsAfterMove = 0;
  try {
    await button(form, "Отправить новую версию").click();
    assert.equal(await committed.promise, 201);
    await button(form, "Закрыть").click();
    await row(next).locator(".ac-material-open").click();
    await notes(admin);
    await admin.locator(".ac-discussion summary").click();
    await discussion.fill(message);
    await admin.route(f.base + otherPath, async read => {
      if (++readsAfterMove === 1)
        return read.fulfill({ status: 503, json: { error: "Этап временно недоступен" } });
      await finishRetry.promise;
      await read.continue();
    }, { times: 2 });
  } finally {
    release.resolve();
  }
  await retry.waitFor();
  assert.ok((await admin.locator(".ac-notice").innerText()).includes(sending.title.replace(/\.jpg$/i, "")));
  assert.equal(await admin.locator(".ac-material.is-selected").getAttribute("data-material-id"), String(next.id));
  assert.equal(await discussion.inputValue(), message);
  assert.equal(await discussion.evaluate(e => e === document.activeElement), true);
  const nextSentence = " Размер сверю в пятницу.";
  try {
    const reading = admin.waitForRequest(r => r.url() === f.base + otherPath && r.method() === "GET");
    await retry.click();
    await reading;
    await discussion.press("End");
    await discussion.pressSequentially(nextSentence);
  } finally {
    finishRetry.resolve();
  }
  await row(sending).waitFor({ state: "detached" });
  assert.equal(readsAfterMove, 2);
  assert.equal(uploads, uploadsBeforeMove + 1);
  assert.equal(await filter.inputValue(), "changes_requested");
  assert.equal(await admin.locator(".ac-material.is-selected").getAttribute("data-material-id"), String(next.id));
  assert.equal(await discussion.inputValue(), message + nextSentence);
  assert.equal(await discussion.evaluate(e => e === document.activeElement), true);
  await filter.selectOption("new");
  await row(sending).getByText("Ожидает проверки клиента", { exact: true }).waitFor();
  await row(sending).locator(".ac-material-open").click();
  await button(admin.locator(".ac-view-heading"), `Полное имя файла: ${delayedName}`).waitFor();
  assert.match(await admin.locator(".ac-title").innerText(), /PDF · v2/);

  // Reassignment revokes the previous client's access while they are reading an existing remark.
  const previousOwner = await login(false);
  await previousOwner.locator("#tab-review").click();
  await previousOwner.locator("#approval-center").getByLabel("Этап", { exact: true }).selectOption(String(stage.id));
  await queue(previousOwner);
  await previousOwner.locator(`.ac-material[data-material-id="${plan.id}"] .ac-material-open`).click();
  await notes(previousOwner);
  const remark = "Нужен скан обмеров коридора.";
  await previousOwner.locator(".ac-note-body").getByText(remark, { exact: true }).waitFor();
  await saved(previousOwner);
  await f.api(`/api/admin/projects/${project.id}/assign`, {
    clientId: f.clients[1].id, expectedClientId: client.id, confirm: true,
  }, f.admin);
  const forbidden = previousOwner.waitForResponse(response => new URL(response.url()).pathname === path && response.status() === 403);
  await action(previousOwner, "Обновить данные");
  await forbidden;
  await previousOwner.locator("#client-projects-panel").waitFor();
  await previousOwner.locator("#approval-center").waitFor({ state: "detached" });
  const visibleText = await previousOwner.locator("body").innerText();
  assert.ok(!visibleText.includes(remark) && !visibleText.includes(newName));
  assert.equal(await previousOwner.locator(`#client-projects-panel [data-project-id="${project.id}"]`).count(), 0);
  assert.deepEqual(errors, []);
  console.log("PASS", browser.version(), "version follow-up, album, archive downloads, mobile approval, delayed upload during a reply and revoked access");
} finally {
  await browser?.close();
  await f.close();
}

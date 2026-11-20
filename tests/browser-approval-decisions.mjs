import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ownershipFixture } from "./ownership-fixture.mjs";
import { drawing, seedApprovalDemo } from "./approval-demo.mjs";
import { openProject, openFiles } from "./browser-navigation.mjs";
import { button, closeNotes, editDraftRemark, markForRevision, menu, notes, saved, summary } from "./approval-navigation.mjs";

const { chromium } = await import(process.env.ITD_PLAYWRIGHT_MODULE || "playwright");
const f = await ownershipFixture();
const folder = process.env.ITD_SCREENSHOT_DIR || "test-results/approval-decisions";
const desktop = { viewport: { width: 1568, height: 1000 } };
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
let browser;
try {
  await mkdir(folder, { recursive: true });
  const { project, full, mobile } = await seedApprovalDemo(f, { firstPlanPages: 5 });
  const path = `/api/approval-center/projects/${project.id}/stages/${full.id}`;
  const clientUser = f.clients[0], state = (user = clientUser.cookie) => f.api(path, null, user);
  const [plan, returned, textOnly, markerOnly, , clean] = (await state()).materials;
  const note = "Уточнить ширину прохода у входа в гостиную";
  browser = await chromium.launch({ executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox"] });
  const errors = [];
  async function login(admin = false, options = desktop) {
    const ctx = await browser.newContext(options), page = await ctx.newPage();
    page.on("pageerror", e => errors.push(e.message));
    page.on("dialog", d => { if (d.type() === "beforeunload") d.accept(); });
    await page.goto(f.base + "/cabinet");
    await page.locator("#login-email").fill(admin ? "admin@example.test" : clientUser.email);
    await page.locator("#login-password").fill(f.password);
    await page.locator("#login-form .primary").click();
    await openProject(page, project.id, { client: !admin });
    return page;
  }
  async function center(page) {
    await page.locator("#tab-review").click();
    await page.locator(".ac-sheet canvas").waitFor();
  }
  const row = (page, m) => page.locator(`.ac-material[data-material-id="${m.id}"]`);
  const heading = (page, m) => page.locator(".ac-view-heading h3").getByText(m.title, { exact: true }).waitFor();
  async function view(page, m) {
    await row(page, m).locator(".ac-material-open").click();
    await heading(page, m);
    await page.locator(".ac-sheet canvas").waitFor();
  }
  const shot = (page, name) => page.screenshot({ path: join(folder, name + ".png"), animations: "disabled" });
  const dialog = page => page.getByRole("dialog");
  const draftOf = (s, m) => s.draft.entries.find(e => e.materialId === m.id);
  const versionOf = (s, m) => s.materials.find(x => x.id === m.id).versions.find(v => v.id === m.currentVersion.id);
  const search = page => page.getByRole("searchbox", { name: "Найти материал" });
  const countChecked = page => page.locator(".ac-material input:checked").count();
  const approval = page => button(page, "Согласовать и далее");
  const saveChanges = page => button(page.locator(".ac-footer"), "Сохранить правки и далее");
  async function approveWithRemarks(page) {
    await notes(page);
    await button(page.locator(".ac-rail"), "Согласовать с замечаниями").click();
  }
  const missing = "Чтобы согласовать материал, просмотрите все страницы. Просмотрено 2 из 5. Осталось 3";

  const client = await login();
  await center(client);
  await client.getByText("Просмотрено 1 из 5", { exact: true }).waitFor();
  const beforeSelect = await state();
  await button(client, "Выбрать").click();
  await button(client, "Выбрать все · 40").click();
  assert.equal(await countChecked(client), 40);
  await client.getByText("Выбрано: 40", { exact: true }).waitFor();
  await saved(client);
  await shot(client, "approval-select-all");
  await row(client, clean).getByRole("checkbox").uncheck();
  await button(client, "Согласовать выбранные · 39").waitFor();
  await search(client).fill("план помещений");
  await client.getByText("Выбор снят после изменения поиска или фильтра.").waitFor();
  assert.equal(await countChecked(client), 0);
  await button(client, "Выбрать все · 4").click();
  assert.equal(await countChecked(client), 4);
  await client.getByLabel("Показывать").selectOption("draft");
  await button(client, "Выбрать все · 0").waitFor();
  assert.equal(await countChecked(client), 0);
  await search(client).fill("");
  await client.getByLabel("Показывать").selectOption("pending_approval");
  await button(client, "Выбрать все · 40").click();
  await button(client, "Снять выбор").click();
  assert.equal(await countChecked(client), 0);
  const afterSelect = await state();
  assert.deepEqual(afterSelect.draft.entries, beforeSelect.draft.entries);
  assert.deepEqual(afterSelect.materials.map(m => m.versions[0].viewedPageNumbers),
    beforeSelect.materials.map(m => m.versions[0].viewedPageNumbers));
  await button(client, "Выбрать все · 40").click();
  await client.locator(".ac-stage select").selectOption(String(mobile[0].id));
  await button(client, "Выбрать").click();
  await button(client, "Выбрать все · 2").waitFor();
  await client.getByText("Выбрано: 0", { exact: true }).waitFor();
  await client.locator(".ac-stage select").selectOption(String(full.id));
  await heading(client, plan);
  await client.getByLabel("Показывать").selectOption("all");

  const viewUrl = "**/versions/" + plan.currentVersion.id + "/view";
  await client.route(viewUrl, route => route.request().postDataJSON().page === 5
    ? route.fulfill({ status: 503, json: { error: "Соединение прервано" } }) : route.continue());
  await client.getByLabel("Перейти на страницу").selectOption("5");
  await button(client, "Повторить сохранение просмотра").waitFor();
  assert.deepEqual(versionOf(await state(), plan).viewedPageNumbers, [1]);
  await client.unroute(viewUrl);
  await button(client, "Повторить сохранение просмотра").click();
  await client.getByText("Просмотрено 2 из 5", { exact: true }).waitFor();
  await button(client, "Нужны правки").click();
  await dialog(client).getByLabel("Текст замечания").fill("Проверить размер на листе 2");
  await button(dialog(client), "Закрыть").click();
  await saved(client);
  await saveChanges(client).waitFor();
  assert.equal(await approval(client).count(), 0);
  await approveWithRemarks(client);
  await client.locator(".ac-footer").getByText(missing, { exact: true }).waitFor();
  await shot(client, "approval-missing-pages");
  let s = await state();
  assert.deepEqual(versionOf(s, plan).viewedPageNumbers, [1, 5]);
  assert.equal(versionOf(s, plan).confirmedView, false);
  assert.equal(draftOf(s, plan).decision, null);
  assert.equal(draftOf(s, plan).comment, "Проверить размер на листе 2");
  await f.api("/api/approval-center/versions/" + plan.currentVersion.id + "/view", { confirm: true }, clientUser.cookie, "POST", 409);

  const mobilePage = await login(false, phone);
  await center(mobilePage);
  await mobilePage.getByText("Страница 5 из 5", { exact: true }).waitFor();
  await approveWithRemarks(mobilePage);
  const feedback = mobilePage.locator(".ac-view-feedback");
  await feedback.getByText(missing, { exact: true }).waitFor();
  const warningBox = await feedback.boundingBox(), actionBox = await saveChanges(mobilePage).boundingBox();
  assert.ok(warningBox.y >= 0 && warningBox.y + warningBox.height <= actionBox.y && actionBox.y + actionBox.height <= 844);
  await shot(mobilePage, "approval-missing-mobile");
  await saved(mobilePage);
  await mobilePage.context().close();
  for (const n of [2, 3, 4]) {
    await button(client, "Открыть непросмотренную страницу").click();
    await client.getByText(`Страница ${n} из 5`, { exact: true }).waitFor();
    if (n < 4) await client.locator(".ac-view-feedback").getByText(new RegExp(`Осталось ${4 - n}$`)).waitFor();
  }
  await client.getByText("Все страницы просмотрены", { exact: true }).waitFor();
  assert.equal(await client.locator(".ac-view-feedback").count(), 0);
  await editDraftRemark(client, "Проверить размер на листе 2");
  await dialog(client).getByLabel("Текст замечания").fill("");
  await button(dialog(client), "Закрыть").click();
  await closeNotes(client);
  await approval(client).click();
  await heading(client, returned);
  assert.equal(draftOf(await state(), plan).decision, "approved");

  await markForRevision(client, note, { x: 420, y: 260 });
  await client.getByText("Правки сохранены в черновик. Дизайнер увидит их после отправки пакета", { exact: true }).waitFor();
  await view(client, returned);
  await Promise.all([client.waitForEvent("dialog").then(async d => {
    assert.match(d.message(), new RegExp(returned.title));
    await d.dismiss();
  }), approveWithRemarks(client)]);
  assert.equal(draftOf(await state(), returned).decision, "changes_requested");
  await view(client, textOnly);
  await button(client, "Нужны правки").click();
  await dialog(client).getByLabel("Текст замечания").fill("Черновой вопрос о габаритах");
  await button(dialog(client), "Закрыть").click();
  await saved(client);
  // Older drafts may contain a pin without any general comment or decision.
  s = await state();
  const pinEntry = { materialId: markerOnly.id, versionId: markerOnly.currentVersion.id,
    expectedRevision: markerOnly.currentVersion.revision, decision: null, comment: "",
    markers: [{ page: 1, x: 0.4, y: 0.6, body: "Уточнить положение розетки" }] };
  await f.api(path + "/draft", { expectedRevision: s.draft.revision, entries: [...s.draft.entries, pinEntry], position: s.draft.position }, clientUser.cookie, "PUT");
  await client.reload();
  await openProject(client, project.id, { client: true });
  await center(client);
  const protectedDraft = await state();
  const protectedItems = [returned, textOnly, markerOnly];
  await row(client, returned).getByText("К отправке: правки", { exact: true }).waitFor();
  await row(client, plan).getByText("К отправке: согласование", { exact: true }).waitFor();
  await view(client, clean);
  await client.getByText("Все страницы просмотрены", { exact: true }).waitFor();
  await button(client, "Выбрать").click();
  for (const m of [...protectedItems, clean]) await row(client, m).getByRole("checkbox").check();
  await button(client, "Согласовать выбранные · 4").click();
  for (const m of protectedItems) await dialog(client).getByRole("listitem").filter({ hasText: m.title }).waitFor();
  await button(dialog(client), "Исключить перечисленные").click();
  assert.deepEqual(await dialog(client).getByRole("listitem").allTextContents(), [clean.title + " · v1"]);
  assert.ok(!draftOf(await state(), clean)?.decision);
  await button(dialog(client), "Закрыть").click();
  assert.ok(!draftOf(await state(), clean)?.decision);
  await button(client, "Согласовать выбранные · 1").click();
  await button(dialog(client), "Подготовить решения").click();
  await dialog(client).waitFor({ state: "hidden" });
  s = await state();
  for (const m of protectedItems) assert.deepEqual(draftOf(s, m), draftOf(protectedDraft, m));
  assert.equal(draftOf(s, clean).decision, "approved");

  const admin = await login(true);
  await openFiles(admin, "result", { stageIndex: 0 });
  await admin.locator("#library-search").fill(returned.title);
  const card = admin.locator(`.library-material[data-file-id="${returned.currentVersion.file.id}"]`);
  await card.getByText("На согласовании", { exact: true }).waitFor();
  await card.locator(".library-history").click();
  await heading(admin, returned);
  await search(admin).fill(returned.title);
  await row(admin, returned).getByText("Ожидает решения", { exact: true }).waitFor();
  assert.deepEqual((await state(f.admin)).draft.entries, []);
  assert.equal(await admin.locator(".ac-pin").count(), 0);

  await summary(client);
  for (const [m, label] of [[plan, "согласование"], [clean, "согласование"], [returned, "правки"]]) {
    const line = dialog(client).locator("article").filter({ hasText: m.title });
    await line.getByText("К отправке: " + label, { exact: true }).waitFor();
  }
  assert.equal(await dialog(client).locator("article").count(), 3);
  const totals = () => f.rows(`SELECT (SELECT count(*) FROM approval_packages) AS packets,
    (SELECT count(*) FROM review_events WHERE type IN ('approved','changes_requested')) AS decisions,
    (SELECT count(*) FROM review_notifications) AS notifications, (SELECT count(*) FROM approval_notes) AS pins`)[0];
  const before = totals();
  const [response] = await Promise.all([client.waitForResponse(r => r.url().endsWith(path + "/submit")),
    button(dialog(client), "Подтверждаю отправку").click()]);
  await client.getByText(/Пакет принят/).waitFor();
  const receipt = await response.json();
  const replay = await f.api(path + "/submit", response.request().postDataJSON(), clientUser.cookie);
  assert.equal(replay.replayed, true);
  assert.equal(replay.packageId, receipt.packageId);
  assert.deepEqual(totals(), { packets: before.packets + 1, decisions: before.decisions + 3,
    notifications: before.notifications + 1, pins: before.pins + 1 });
  s = await state(f.admin);
  const statementUrl = "/api/approval-center/packages/" + receipt.packageId;
  const statement = await f.api(statementUrl, null, f.admin);
  assert.equal(statement.projectId, project.id);
  assert.equal(statement.scope, full.id);
  const libraryFiles = (await f.api(`/api/projects/${project.id}/files?stageId=${full.id}`, null, f.admin)).files;
  for (const [m, decision] of [[plan, "approved"], [clean, "approved"], [returned, "changes_requested"]]) {
    const v = versionOf(s, m), item = statement.materials.find(i => i.materialId === m.id);
    assert.equal(v.status, decision);
    assert.equal(item.versionId, v.id);
    assert.equal(item.decision, decision);
    const library = libraryFiles.find(file => file.id === v.file.id).review;
    assert.deepEqual([library.materialId, library.versionId, library.status], [m.id, v.id, decision]);
  }
  for (const m of [textOnly, markerOnly]) assert.deepEqual(draftOf(await state(), m), draftOf(protectedDraft, m));
  const pdfText = await admin.evaluate(async url => {
    const lib = await import("/vendor/pdfjs/pdf.mjs");
    lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
    const task = lib.getDocument({ data: await (await fetch(url)).arrayBuffer() });
    const doc = await task.promise;
    const parts = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      parts.push(...(await page.getTextContent()).items.map(item => item.str));
    }
    await task.destroy();
    return parts.join(" ").replace(/\s+/g, " ");
  }, statementUrl + "/pdf");
  for (const [m, label] of [[plan, "Согласовано"], [returned, "На доработку"], [clean, "Согласовано"]])
    assert.ok(pdfText.includes(`${m.title} · v1 ${m.currentVersion.file.name} ${label}`), m.title);
  assert.ok(pdfText.includes(note));

  await view(client, returned);
  await row(client, returned).getByText("На доработку", { exact: true }).waitFor();
  await button(client.locator(".ac-footer"), "Далее без решения").waitFor();
  await client.locator(".ac-pin").waitFor();
  await saved(client);
  await shot(client, "approval-returned-client");
  await button(admin, "← Файлы этапа").click();
  await card.getByText("На доработку", { exact: true }).waitFor();
  assert.equal(await admin.locator("#library-search").inputValue(), returned.title);
  await center(admin);
  await heading(admin, returned);
  assert.equal(await search(admin).inputValue(), returned.title);
  await row(admin, returned).getByText("На доработку", { exact: true }).waitFor();
  await notes(admin);
  await admin.locator(".ac-rail").getByText(note, { exact: false }).first().waitFor();
  await shot(admin, "approval-returned-admin");
  // Exercise the browser window's return event in addition to the real cabinet tab transitions above.
  await admin.locator(".ac-note-filter > summary").click();
  await admin.locator(".ac-notes select").selectOption("open");
  await admin.locator(".ac-discussion summary").click();
  await admin.getByLabel("Комментарий к версии").fill("Текст ответа до отправки");
  await admin.locator(".ac-properties > summary").click();
  await admin.getByLabel("Помещение", { exact: true }).fill("Кухня");
  await Promise.all([admin.waitForResponse(r => r.url().endsWith(path) && r.request().method() === "GET"),
    admin.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); })]);
  await admin.waitForFunction(() => document.querySelector(".ac-discussion[open] textarea")?.value === "Текст ответа до отправки" &&
    document.querySelector(".ac-notes select")?.value === "open" &&
    document.querySelector('.ac-rail input[aria-label="Помещение"]')?.value === "Кухня" &&
    !document.querySelector(".ac-work").inert);
  await button(admin, "Закрыть панель").click();
  await search(admin).fill("");
  await view(admin, plan);
  await admin.locator(".ac-brand").click();
  const replacement = await f.api(`/api/projects/${project.id}/files`, {
    name: "Обмерный план-v2.pdf", contentType: "application/pdf", data: await drawing(plan.title, 2, true),
    category: "result", stageId: full.id, materialId: plan.id, expectedVersionId: plan.currentVersion.id,
  }, f.admin, "POST", 201);
  await center(admin);
  await row(admin, plan).getByText("Проверить исправления", { exact: true }).waitFor();
  await admin.locator(".ac-footer").getByText("Ожидает решения", { exact: true }).waitFor();
  await menu(admin);
  assert.equal(await admin.getByLabel("Версия", { exact: true }).inputValue(), String(replacement.review.versionId));
  await admin.getByLabel("Версия", { exact: true }).selectOption(String(plan.currentVersion.id));
  await admin.locator(".ac-footer").getByText("Архивная версия", { exact: true }).waitFor();
  await admin.locator(".ac-brand").click();
  await center(admin);
  await admin.locator(".ac-footer").getByText("Архивная версия", { exact: true }).waitFor();
  assert.equal(versionOf(await state(f.admin), plan).status, "approved");
  assert.deepEqual(await f.api(statementUrl, null, f.admin), statement);
  assert.deepEqual(errors, []);
  console.log("PASS", browser.version(), "40 scoped selections, sparse PDF page views, retry, protected drafts, explicit exclusion, mixed packet, PDF statement, two admin returns, archived v1 and pending v2");
} finally {
  await browser?.close();
  await f.close();
}

import { action, notes, queue, saved, summary, markForRevision } from "./approval-navigation.mjs";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { ownershipFixture } from "./ownership-fixture.mjs";
import { fixtures } from "./preview-fixtures.mjs";
import { drawing } from "./approval-demo.mjs";
import { openProject } from "./browser-navigation.mjs";

const { chromium } = await import(process.env.ITD_PLAYWRIGHT_MODULE || "playwright");
const f = await ownershipFixture();
let browser;
try {
  const project = f.projects[0];
  const stage = project.stages[0];
  const scope = `/api/approval-center/projects/${project.id}/stages/${stage.id}`;
  const state = () => f.api(scope, null, f.clients[0].cookie);
  const [, mimeType, bytes] = fixtures[0];
  const ids = [];
  for (let i = 1; i <= 40; i++) {
    const document = i === 40
      ? { name: "План освещения.pdf", contentType: "application/pdf", data: await drawing("План освещения", 1) }
      : { name: `План-${i}.png`, contentType: mimeType, data: bytes.toString("base64") };
    const file = await f.api(`/api/projects/${project.id}/files`, {
      ...document, category: "result", stageId: stage.id, review: true,
    }, f.admin, "POST", 201);
    ids.push(file.review.materialId);
  }
  browser = await chromium.launch({
    executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox"],
  });
  const button = (root, name) => root.getByRole("button", { name, exact: true });
  async function openCenter(page, client) {
    await openProject(page, project.id, { client });
    await page.locator("#tab-review").click();
    await page.locator(".ac-work:not([inert])").waitFor();
  }
  async function login(client, mobile = false) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 960 },
      isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    page.on("dialog", (dialog) => dialog.accept());
    await page.goto(f.base + "/cabinet");
    await page.locator("#login-email").fill(client ? f.clients[0].email : "admin@example.test");
    await page.locator("#login-password").fill(f.password);
    await page.locator("#login-form .primary").click();
    await openCenter(page, client);
    return page;
  }
  const row = (page, id) => page.locator(`.ac-material[data-material-id="${id}"]`);
  async function view(page, id) {
    await queue(page);
    await row(page, id).locator(".ac-material-open").click();
    await page.locator(".ac-sheet :is(img, canvas)").waitFor();
  }
  const client = await login(true);
  await button(client, "Выбрать").click();
  for (const id of ids.slice(0, 35)) {
    await view(client, id);
    await client.getByText("Все страницы просмотрены", { exact: true }).waitFor();
    await row(client, id).getByRole("checkbox").check();
  }
  await button(client, "Согласовать выбранные · 35").click();
  await button(client.getByRole("dialog"), "Подготовить решения").click();
  const returned = ids.slice(35);
  for (const id of returned) {
    await view(client, id);
    await markForRevision(client, `Сместить светильник на плане ${id}`);
  }
  await saved(client);
  await client.reload();
  await openCenter(client, true);
  async function submit(page, approved, changes, round) {
    await summary(page);
    await page.getByText(`Подготовлено: ${approved} согласований · ${changes} на доработку`, { exact: true }).waitFor();
    await button(page.getByRole("dialog"), "Подтверждаю отправку").click();
    await page.getByText(new RegExp(`Пакет принят.*раунд ${round}\\.`)).waitFor();
  }
  await submit(client, 35, 5, 1);
  const first = await state();
  assert.equal(first.materials.filter(m => m.currentVersion.status === "approved").length, 35);
  assert.equal(first.materials.filter(m => m.currentVersion.status === "changes_requested").length, 5);
  assert.ok(first.stage.blockers.length);
  const designer = await login(false);
  for (const id of returned) {
    await view(designer, id);
    await notes(designer);
    await button(designer, "Загрузить исправленную версию").click();
    const report = designer.getByRole("dialog");
    await report.getByRole("radio", { name: "Исправлено", exact: true }).check();
    await report.getByLabel("Что исправлено", { exact: true }).fill("Светильник смещён по отметке клиента");
    const replacement = id === ids.at(-1)
      ? { name: "План освещения-v2.pdf", mimeType: "application/pdf", buffer: Buffer.from(await drawing("План освещения", 1, true, 1), "base64") }
      : { name: "План-v2.png", mimeType, buffer: bytes };
    await report.locator("input[type=file]").setInputFiles(replacement);
    await button(report, "Отправить новую версию").click();
    await report.waitFor({ state: "hidden" });
    await designer.getByText("Исправленная версия отправлена клиенту.", { exact: true }).waitFor();
  }
  const revised = (await state()).materials.filter(m => returned.includes(m.id));
  assert.ok(revised.every(m => m.currentVersion.versionNumber === 2 && m.notes[0].status === "fixed"));
  const phone = await login(true, true);
  for (const id of returned) {
    await view(phone, id);
    await phone.getByText("Все страницы просмотрены", { exact: true }).waitFor();
    await notes(phone);
    await button(phone, "Проверить исправление · версия 2").waitFor();
    await button(phone, "Исходное замечание · версия 1").waitFor();
    await button(phone, "Подтвердить исправление").click();
    const confirmation = phone.getByRole("dialog");
    if (id !== ids.at(-1)) await confirmation.getByLabel("Пояснение").fill("Исправление проверено");
    await button(confirmation, "Сохранить в истории").click();
    await confirmation.waitFor({ state: "hidden" });
    await phone.locator(".ac-rail").waitFor({ state: "hidden" });
    const current = (await state()).materials.find(m => m.id === id);
    assert.equal(current.notes[0].status, "confirmed");
    assert.equal(current.versions.at(-1).confirmedView, false);
    assert.equal(current.currentVersion.status, "pending_approval");
    const approve = phone.locator(".ac-footer .ac-approve:enabled");
    await approve.waitFor();
    if (id === ids.at(-1) && process.env.ITD_SCREENSHOT_DIR && !process.env.ITD_NO_SCREENSHOTS) {
      await mkdir(process.env.ITD_SCREENSHOT_DIR, { recursive: true });
      await phone.locator(".ac-sheet canvas").waitFor();
      await phone.evaluate(() => document.fonts.ready);
      await saved(phone);
      await phone.screenshot({ path: join(process.env.ITD_SCREENSHOT_DIR, "replacement-ready-mobile.png"), animations: "disabled" });
    }
    await approve.click();
    await saved(phone);
  }
  await submit(phone, 5, 0, 2);
  await phone.context().close();
  const second = await state();
  assert.deepEqual(second.packages.map(p => p.roundNumber), [2, 1]);
  assert.ok(second.materials.every(m => m.currentVersion.status === "approved"));
  assert.equal(second.stage.approved, false);
  await action(client, "Обновить данные");
  await action(client, "История и ведомости");
  const history = client.getByRole("dialog");
  await history.getByRole("button", { name: new RegExp(`Ведомость №${second.packages[0].id}\\b`) }).click();
  const link = client.getByRole("dialog").getByRole("link", { name: "Скачать ведомость в PDF" });
  const response = await client.request.get(new URL(await link.getAttribute("href"), f.base).href);
  assert.equal(response.status(), 200);
  assert.ok((await PDFDocument.load(await response.body())).getPageCount() >= 1);
  await button(client.getByRole("dialog"), "Закрыть").click();
  await action(client, "Готовность этапа");
  const stageEvents = () => f.rows("SELECT COUNT(*) AS count FROM approval_stage_events WHERE stageId=?", stage.id)[0].count;
  const beforeAcceptance = stageEvents();
  await button(client.getByRole("dialog"), "Подтверждаю согласование этапа").evaluate(b => { b.click(); b.click(); });
  const accepted = client.locator(".ac-stage-approved").filter({ hasText: "Этап согласован отдельным действием" });
  await accepted.waitFor();
  assert.equal((await state()).stage.approved, true);
  await action(client, "Обновить данные");
  await view(client, ids[0]);
  await accepted.waitFor();
  await action(client, "Готовность этапа");
  const stageDialog = client.getByRole("dialog");
  await stageDialog.getByText("Этап уже согласован или завершён.", { exact:true }).waitFor();
  assert.equal(await button(stageDialog, "Подтверждаю согласование этапа").count(), 0);
  assert.equal(stageEvents(), beforeAcceptance + 1);
  console.log("PASS", browser.version(), "40 materials, 35 bulk approvals, 5 returns and uploads, 5 client confirmations, 2 rounds, PDF statement and persistent separate stage acceptance without a duplicate event");
} finally {
  await browser?.close();
  await f.close();
}

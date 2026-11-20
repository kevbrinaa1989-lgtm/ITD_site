import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ownershipFixture } from "./ownership-fixture.mjs";
import { drawing, seedApprovalDemo } from "./approval-demo.mjs";
import { openProject } from "./browser-navigation.mjs";
import { action, button, markForRevision, queue, summary } from "./approval-navigation.mjs";

const { chromium } = await import(process.env.ITD_PLAYWRIGHT_MODULE || "playwright");
const f = await ownershipFixture();
const folder = process.env.ITD_SCREENSHOT_DIR || "test-results/approval-feedback";
let browser;
try {
  const { project, full } = await seedApprovalDemo(f);
  const client = f.clients[0];
  const path = `/api/approval-center/projects/${project.id}/stages/${full.id}`;
  const state = () => f.api(path, null, client.cookie);
  const original = await state();
  const [general, marked] = original.materials.slice(3, 5);
  const plain = "Укажите ширину прохода между кухней и обеденным столом.";
  const remark = "Сместите дверной проём на 15 см в сторону гостиной.";
  browser = await chromium.launch({ executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium", args: ["--no-sandbox"] });
  await mkdir(folder, { recursive: true });
  const errors = [];
  async function enter(studio, mobile = false) {
    const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1568, height: 1000 },
      isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(f.base + "/cabinet");
    await page.locator("#login-email").fill(studio ? "admin@example.test" : client.email);
    await page.locator("#login-password").fill(f.password);
    await page.locator("#login-form .primary").click();
    await openProject(page, project.id, { client: !studio });
    await page.locator("#tab-review").click();
    await page.locator(".ac-sheet canvas").waitFor();
    return page;
  }
  async function openMaterial(page, m) {
    await queue(page);
    await page.locator(`.ac-material[data-material-id="${m.id}"] .ac-material-open`).click();
    await page.locator(".ac-view-heading h3").getByText(m.title, { exact: true }).waitFor();
    await page.locator(".ac-sheet canvas").waitFor();
  }
  async function shot(page, name) {
    await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: join(folder, name + ".png"), animations: "disabled" });
  }
  const author = await enter(false);
  await openMaterial(author, general);
  await button(author, "Нужны правки").click();
  await author.getByRole("dialog").getByLabel("Текст замечания").fill(plain);
  await button(author.getByRole("dialog"), "Подготовить и далее").click();
  await author.locator(".ac-view-heading h3").getByText(marked.title, {exact:true}).waitFor();
  await author.getByText("Просмотрено 1 из 2", {exact:true}).waitFor();
  await author.getByLabel("Перейти на страницу").selectOption("2");
  await author.getByText("Все страницы просмотрены", {exact:true}).waitFor();
  await markForRevision(author, remark, {x:475, y:352});
  await summary(author);
  await button(author.getByRole("dialog"), "Подтверждаю отправку").click();
  await author.getByText(/Пакет принят/).waitFor();
  const designer = await enter(true);
  await designer.getByLabel("Показывать").selectOption("notes");
  assert.equal(await designer.locator(".ac-material").count(), 2);
  await openMaterial(designer, general);
  await button(designer, "Открыть замечания").click();
  await designer.locator(".ac-notes .ac-note-body").getByText(plain, { exact: true }).waitFor();
  await button(designer, "Загрузить исправленную версию").click();
  const versionForm = designer.getByRole("dialog");
  await versionForm.locator(".ac-note-body").getByText(plain).waitFor();
  assert.equal(await versionForm.getByRole("radio").count(), 0);
  assert.equal(await versionForm.getByLabel("Что изменено", {exact: true}).evaluate(e => e.required), true);
  await button(versionForm, "Закрыть").click();
  await button(designer, "Закрыть панель").click();
  await action(designer, "Очередь замечаний");
  const queued = designer.getByRole("dialog").getByRole("article").filter({ hasText: plain });
  await button(queued, "Открыть замечание").click();
  await designer.locator(".ac-notes .ac-note-body").getByText(plain).waitFor();
  await button(designer, "Закрыть панель").click();
  await designer.getByLabel("Показывать").selectOption("all");
  await openMaterial(designer, marked);
  await button(designer, "Открыть замечания").click();
  assert.equal(await designer.locator(".ac-notes .ac-note-body").count(), 1);
  await button(designer, "Показать на листе 2 · v1").click();
  await designer.locator(".ac-sheet .ac-pin.is-located").click();
  await designer.locator(".ac-notes .is-focused .ac-note-body").getByText(remark).waitFor();
  assert.equal(await designer.getByLabel("Помещение", {exact:true}).isVisible(), false);
  await shot(designer, "feedback-designer-desktop");
  await button(designer, "Загрузить исправленную версию").click();
  await versionForm.getByRole("heading", { name: marked.title, exact: true }).waitFor();
  const group = versionForm.getByRole("group", { name: "Отметка 1 · лист 2 · v1" });
  assert.equal(await versionForm.locator("input:checked").count(), 0);
  const newFile = { name: "План перегородок-v2.pdf", mimeType: "application/pdf",
    buffer: Buffer.from(await drawing(marked.title, 2, true), "base64") };
  await versionForm.getByLabel("Файл новой версии").setInputFiles(newFile);
  await button(versionForm, "Отправить новую версию").click();
  assert.equal(await versionForm.locator("form").evaluate(form => form.checkValidity()), false);
  await group.getByRole("radio", { name: "Исправлено", exact:true }).check();
  await group.getByLabel("Что исправлено", { exact:true }).fill("Проём перенесён. Размер указан на листе 2.");
  await shot(designer, "feedback-version-desktop");
  await button(versionForm, "Закрыть").click();

  const customer = await enter(false, true);
  await openMaterial(customer, general);
  await button(customer.locator(".ac-view-heading"), "Замечания · 1").click();
  await customer.locator(".ac-notes .ac-note-body").getByText(plain).waitFor();
  assert.equal(await button(customer, "Загрузить исправленную версию").count(), 0);
  await shot(customer, "feedback-client-mobile");
  const phone = await enter(true, true);
  await openMaterial(phone, marked);
  await button(phone, "Открыть замечания").click();
  await button(phone, "Показать на листе 2 · v1").click();
  await phone.locator(".ac-sheet .ac-pin.is-located").click();
  await phone.locator(".ac-notes .is-focused .ac-note-body").getByText(remark).waitFor();
  await button(phone, "Загрузить исправленную версию").click();
  const mobileForm = phone.getByRole("dialog");
  await mobileForm.getByLabel("Файл новой версии").setInputFiles(newFile);
  await mobileForm.getByRole("radio", { name: "Осталось исправить", exact:true }).check();
  const explanation = "Нужно согласовать размер с конструктором. Остальные размеры добавлены.";
  await mobileForm.getByLabel("Почему замечание остаётся открытым").fill(explanation);
  await shot(phone, "feedback-version-mobile");
  await phone.setViewportSize({ width:390, height:480 });
  const send = button(mobileForm, "Отправить новую версию");
  const bounds = await send.boundingBox();
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 480);
  assert.ok(await mobileForm.locator(".ac-version-fields").evaluate(e => e.scrollHeight > e.clientHeight));
  await send.click();
  await mobileForm.waitFor({state:"hidden"});
  await phone.getByText(/Версия 2 отправлена клиенту\./).waitFor();
  const latest = (await state()).materials.find(m => m.id === marked.id);
  assert.equal(latest.currentVersion.versionNumber, 2);
  assert.equal(latest.stageId, full.id);
  const changed = latest.versions.find(v => v.id === latest.currentVersion.id);
  const report = JSON.parse(changed.correction);
  assert.equal(report.description, explanation);
  assert.deepEqual(report.resolutions, [{noteId:latest.notes[0].id, fixed:false, explanation}]);
  assert.equal(latest.notes[0].status, "open");
  assert.equal(latest.notes[0].versionId, marked.currentVersion.id);

  // Publish ordinary return decisions, so each card and marker belongs to a real file.
  const comments = [
    "Проверьте свободный проход между кухонным столом и стеной. На плане сейчас сложно понять, можно ли отодвинуть стул, когда рядом проходит человек. Укажите расстояние от кромки стола до готовой стены.",
    "Уточните, в какую сторону открывается дверь спальни, и покажите на чертеже положение полотна. Важно, чтобы дверь не задевала выключатель и оставляла место для шкафа у входа.",
    "Покажите расстояние от дивана до открытого балконного блока. Хотелось бы увидеть на одном листе габариты мебели и доступную ширину прохода для уборки и ухода за растениями.",
    "Проверьте положение перегородки у санузла с учётом плитки и выравнивания стен. Укажите итоговый размер ниши, чтобы можно было сверить его с выбранной моделью стиральной машины.",
    "Добавьте расстояние между краем кухонной столешницы и ручкой высокого шкафа в открытом положении. По текущему виду трудно оценить, смогут ли два человека одновременно работать на кухне.",
    "Отметьте высоту розетки около прикроватной тумбы и её привязку к ближайшей стене. Нам нужен доступ к зарядке с обеих сторон кровати без удлинителя под проходом.",
    "Проверьте стык двух напольных покрытий у входной двери. Нужен размер от порога до линии перехода с учётом расстановки мебели, чтобы коврик полностью помещался в прихожей.",
    "Покажите на листе открытый ящик письменного стола в кабинете. Подпишите расстояние до кресла и стены, чтобы оценить, останется ли место для прохода за работающим человеком.",
    "Уточните, где заканчивается направляющая для штор рядом с угловым шкафом. Хотим заранее проверить расстояние от её края до фасада, чтобы при открывании ткань свободно проходила сбоку.",
    "Добавьте обозначение ревизионного люка и укажите размеры свободной зоны перед ним. На встрече обсуждали доступ к коммуникациям без снятия мебели, хотелось бы увидеть это решение на плане.",
  ];
  const locations = [
    [0.40, 0.40], [0.74, 0.51], [0.28, 0.31], [0.61, 0.38], [0.25, 0.73],
    [0.81, 0.34], [0.59, 0.78], [0.77, 0.67], [0.84, 0.25], [0.63, 0.48],
  ];
  const examples = [
    { count: 1, material: original.materials[2] },
    { count: 4, material: original.materials[0] },
    { count: 10, material: original.materials[1] },
  ];
  const draft = (await state()).draft;
  assert.equal(draft.entries.filter(e => e.decision).length, 0);
  const filled = await f.api(path + "/draft", {
    expectedRevision: draft.revision,
    entries: examples.map(({ count, material }) => ({
      materialId: material.id, versionId: material.currentVersion.id, expectedRevision: material.currentVersion.revision,
      decision: "changes_requested", comment: comments[0],
      markers: comments.slice(0, count).map((body, i) => ({ page: 1, x: locations[i][0], y: locations[i][1], body })),
    })),
    position: draft.position,
  }, client.cookie, "PUT");
  await f.api(path + "/submit", { expectedRevision: filled.revision, operationId: randomUUID(),
    confirm: true, decisionsOnly: true }, client.cookie);

  async function verifyPanel(page, { count, material }, image) {
    await openMaterial(page, material);
    await button(page, "Открыть замечания").click();
    const rail = page.locator(".ac-rail");
    const header = rail.locator(".ac-rail-top");
    const body = rail.locator(".ac-rail-body");
    const cards = body.locator(".ac-feedback-card");
    const upload = button(header, "Загрузить исправленную версию");
    await header.getByRole("heading", { name: "Замечания · " + count, exact: true }).waitFor();
    await header.getByText(material.title + " · v1", { exact: true }).waitFor();
    assert.equal(await cards.count(), count);
    assert.deepEqual(await cards.locator(".ac-note-body").allTextContents(), comments.slice(0, count));
    const initialButton = await upload.boundingBox();
    const initialHeader = await header.boundingBox();
    const initialBody = await body.boundingBox();
    assert.ok(initialHeader.y + initialHeader.height <= initialBody.y + 1, "the title and action must leave the notes unobscured");
    const overflow = await body.evaluate(n => n.scrollHeight - n.clientHeight);
    if (count > 1) {
      assert.ok(overflow > 0);
      const middle = cards.nth(Math.floor(count / 2)), sample = middle.locator(".ac-note-body");
      await middle.evaluate(n => n.scrollIntoView({ block:"start" }));
      assert.ok(await body.evaluate(n => n.scrollTop) > 0);
      assert.ok(await sample.evaluate(n => {
        const bounds = n.getBoundingClientRect(), area = n.closest(".ac-rail-body").getBoundingClientRect();
        const top = Math.max(bounds.top, area.top), bottom = Math.min(bounds.bottom, area.bottom);
        return bottom > top && n.contains(document.elementFromPoint(bounds.left + bounds.width / 2, (top + bottom) / 2));
      }), "the selected long comment must remain readable under the header");
    } else if (overflow > 0) {
      await body.evaluate(n => { n.scrollTop = n.scrollHeight; });
    }
    assert.ok(Math.abs((await upload.boundingBox()).y - initialButton.y) <= 1);
    assert.ok(await upload.evaluate(b => {
      const r = b.getBoundingClientRect();
      return b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }), "the upload action must remain visible and clickable after scrolling");
    if (count === 1) await body.evaluate(n => { n.scrollTop = 0; });
    await shot(page, image);
    await upload.click();
    await page.getByRole("dialog").getByRole("heading", { name: material.title, exact: true }).waitFor();
    assert.equal(await page.getByRole("dialog").getByRole("group", { name: /^Отметка \d+ · лист 1 · v1$/ }).count(), count);
    await button(page.getByRole("dialog"), "Закрыть").click();
    await button(page, "Закрыть панель").click();
  }
  await designer.setViewportSize({ width: 1568, height: 860 });
  await action(designer, "Обновить данные");
  for (const example of examples) await verifyPanel(designer, example, "admin-note-list-" + example.count);
  await phone.setViewportSize({ width: 390, height: 844 });
  await action(phone, "Обновить данные");
  await verifyPanel(phone, examples[2], "admin-note-list-10-mobile");
  assert.deepEqual(errors, []);
  console.log("PASS", browser.version(), "published text and pins, correction outcome, narrow mobile form, persistent accessible upload for 1/4/10 long notes and mobile scrolling");
} finally {
  await browser?.close();
  await f.close();
}

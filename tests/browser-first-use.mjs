import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { ownershipFixture } from "./ownership-fixture.mjs";
import { fixtures } from "./preview-fixtures.mjs";
import { confirmFixtureReview } from "./approval-fixture.mjs";
import { dismissWelcome, leaveApproval, openGlobal, openProject } from "./browser-navigation.mjs";

export async function checkFirstUse(browser) {
  const f = await ownershipFixture();
  const client = f.clients[0], project = f.projects[0], [previous, current] = project.stages;
  const errors = [], contexts = [];
  const projectTitle = "Дом для большой семьи у Финского залива с мастерской, гостевой террасой и зимним садом";
  const scope = `/api/approval-center/projects/${project.id}/stages/${current.id}`;
  const state = () => f.api(scope, null, client.cookie);
  const [, contentType, bytes] = fixtures.find(([, type]) => type === "image/jpeg");
  const upload = (name, extra = {}) => f.api(`/api/projects/${project.id}/files`, {
    name, data: bytes.toString("base64"), contentType, category: "result", stageId: current.id, ...extra,
  }, f.admin, "POST", 201);

  async function login(width, admin = false) {
    const context = await browser.newContext({
      viewport: { width, height: width < 760 ? 844 : 960 }, isMobile: width < 760, hasTouch: width < 760,
    });
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(f.base + "/cabinet");
    await page.locator("#login-email").fill(admin ? "admin@example.test" : client.email);
    await page.locator("#login-password").fill(f.password);
    await page.locator("#login-form .primary").click();
    await dismissWelcome(page);
    return page;
  }
  async function openCurrent(page, admin) {
    await openProject(page, project.id, { client: !admin });
    const selected = page.locator('#project-route .route-step[aria-pressed="true"]');
    assert.ok((await selected.innerText()).includes(current.title));
    const loaded = page.waitForResponse(response =>
      response.request().method() === "GET" && response.url() === f.base + scope);
    await page.locator("#tab-review").click();
    const response = await loaded;
    assert.equal(response.status(), 200);
    const snapshot = await response.json();
    // Reopening the same stage keeps its previous rows visible until the new response is rendered.
    await page.waitForFunction(id => {
      const center = document.querySelector("#approval-center");
      return center && !center.hidden && !center.hasAttribute("data-opening-stage") &&
        center.querySelector(".ac-work")?.inert === false && center.querySelector(".ac-stage select")?.value === String(id);
    }, current.id);
    return snapshot;
  }
  async function checkEmptyScopes(page, admin) {
    await openCurrent(page, admin);
    const message = page.getByText("В этом разделе ещё нет материалов для согласования.", { exact: true });
    await message.waitFor();
    await leaveApproval(page);
    await page.locator("#tab-files").click();
    assert.equal(await page.locator("#library-stage").inputValue(), "unassigned");
    const endpoint = `**/api/approval-center/projects/${project.id}/stages/0`;
    const release = Promise.withResolvers();
    await page.route(endpoint, async route => {
      await release.promise;
      await route.continue();
    }, { times: 1 });
    const started = page.waitForRequest(endpoint);
    const loaded = page.waitForResponse(endpoint);
    try {
      await page.locator("#tab-review").click();
      await started;
      assert.equal(await page.locator(".ac-stage-name").innerText(), "Без этапа");
      assert.equal(await message.isVisible(), false, "Hide the previous stage while loading the new scope");
    } finally {
      release.resolve();
    }
    assert.equal((await loaded).status(), 200);
    await message.waitFor();
    assert.equal(await page.locator(".ac-stage-name").innerText(), "Без этапа");
    assert.equal(await page.locator(".ac-stage select").inputValue(), "0");
    await leaveApproval(page);
    await page.locator("#tab-overview").click();
    await page.locator("#project-route .route-step").filter({ hasText: current.title }).click();
  }
  async function checkOrder(page, admin, ids, titles, files) {
    const fresh = await openCurrent(page, admin);
    assert.deepEqual(fresh.materials.map(material => material.currentVersion.file.id), files.map(file => file.id));
    assert.equal(fresh.materials.find(material => material.id === ids[2]).title, titles[2]);
    const rows = page.locator(".ac-material");
    await rows.nth(2).waitFor();
    assert.deepEqual(await rows.evaluateAll(items => items.map(item => Number(item.dataset.materialId))), ids);
    assert.deepEqual(await rows.locator(".ac-row-copy strong").allTextContents(),
      titles.map((title, index) => `${index + 1}. ${title}`));
    await leaveApproval(page);
    const route = page.locator("#project-route");
    assert.ok((await route.locator('.route-step[aria-pressed="true"]').innerText()).includes(current.title));
    await route.getByRole("button", { name: "Открыть: Альбом этапа", exact: true }).click();
    const thumbnails = page.locator(".album-thumbnail button");
    await thumbnails.nth(2).waitFor();
    assert.equal(await thumbnails.count(), ids.length);
    for (const [index, title] of titles.entries()) {
      await thumbnails.nth(index).click();
      assert.equal(await page.locator(".album-bottom h3").innerText(), title);
      assert.equal(await page.locator(".album-filename").innerText(), files[index].name);
    }
    await page.locator("#library-album-toggle").click();
    const cards = page.locator(".library-material");
    await cards.nth(2).waitFor();
    assert.deepEqual(await cards.locator("h3").allTextContents(), titles);
    assert.deepEqual(await cards.evaluateAll(items => items.map(item => Number(item.dataset.fileId))),
      files.map(file => file.id));
  }
  try {
    await f.api("/api/admin/projects/" + project.id, { title: projectTitle }, f.admin, "PATCH");
    await f.api("/api/projects", { title: "Проект мастерской", clientId: client.id, stageTemplates: ["measurements"] },
      f.admin, "POST", 201);
    const empty = await login(390);
    await empty.getByText("Сейчас от вас не требуется решений.", { exact: true }).waitFor();
    assert.equal(await empty.locator(".client-next-decision").count(), 0);

    // An older, published material deliberately belongs to a different stage.
    const previousFile = await upload("IMG_23891.jpg", { stageId: previous.id, review: true });
    await confirmFixtureReview((path, body) => f.api(path, body, client.cookie), previousFile.review.versionId);
    await f.api(`/api/material-versions/${previousFile.review.versionId}/decision`, {
      decision: "approved", confirm: true, expectedRevision: previousFile.review.revision,
    }, client.cookie);
    await f.api("/api/stages/" + current.id, { status: "in_progress" }, f.admin, "PATCH");
    const files = [];
    for (const name of ["План кухни.jpg", "План спальни.jpg", "План кухни.jpg"]) files.push(await upload(name));
    const customer = await login(1440), staff = await login(1440, true);
    await checkEmptyScopes(customer, false);
    await checkEmptyScopes(staff, true);
    await openCurrent(staff, true);
    await staff.getByRole("button", { name: "Направить материалы на согласование", exact: true }).click();
    const dialog = staff.getByRole("dialog");
    // Identical filenames are possible; distinguish those two checkboxes using the file list returned to the form.
    const available = (await f.api(`/api/projects/${project.id}/files?stageId=${current.id}&category=result`, null, f.admin)).files;
    for (const index of [2, 0, 1])
      await dialog.getByRole("checkbox").nth(available.findIndex(file => file.id === files[index].id)).check();
    await dialog.getByRole("button", { name: "Подтверждаю отправку выбранных", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    await staff.getByText("Пакет отправлен клиенту одним уведомлением.", { exact: true }).waitFor();
    const initial = await state();
    const materials = files.map(file => initial.materials.find(m => m.currentVersion.file.id === file.id));
    const ids = materials.map(material => material.id);
    const titles = ["План кухни", "План спальни", "Схема освещения кухни и столовой с указанием высоты каждой группы светильников"];
    // Represent an existing material with a studio-assigned title, as in the demo fixture.
    const db = new DatabaseSync(join(f.dataDir, "itd.sqlite"));
    try { db.prepare("UPDATE review_materials SET title=? WHERE id=?").run(titles[2], ids[2]); }
    finally { db.close(); }
    await checkOrder(customer, false, ids, titles, files);
    await checkOrder(staff, true, ids, titles, files);

    const remark = "Перенесите светильник ближе к столу.";
    const explanation = "Светильник перенесён на ось стола.";
    const draftEntry = material => ({
      materialId: material.id, versionId: material.currentVersion.id, expectedRevision: material.currentVersion.revision,
      decision: "changes_requested", comment: remark, markers: [],
    });
    const saveDraft = async (entry) => f.api(scope + "/draft", {
      expectedRevision: (await state()).draft.revision, position: {}, entries: [entry],
    }, client.cookie, "PUT");
    const sent = await saveDraft(draftEntry(materials[0]));
    await f.api(scope + "/submit", { expectedRevision: sent.revision, operationId: "first-use-rework", confirm: true }, client.cookie);
    await saveDraft(draftEntry(materials[1]));
    let mobile;
    for (const width of [360, 390]) {
      const page = await login(width), home = page.locator("#client-home-panel");
      const action = home.locator(".client-next-decision button");
      await action.waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => !document.querySelector("#status-message").textContent);
      assert.equal(await home.locator("h1").innerText(), projectTitle);
      assert.equal(await home.getByRole("button", { name: /Все мои проекты · 2/ }).count(), 1);
      assert.equal(await action.count(), 1);
      const bounds = await action.evaluate(button => {
        const rect = button.getBoundingClientRect(), nav = document.querySelector("#mobile-bottom-nav");
        return { top: rect.top, bottom: rect.bottom, footer: nav.getBoundingClientRect().top,
          font: parseFloat(getComputedStyle(nav.querySelector("small")).fontSize), overflow: document.documentElement.scrollWidth - innerWidth };
      });
      assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.footer, JSON.stringify(bounds));
      assert.ok(bounds.font >= 12 && bounds.font <= 13 && bounds.overflow === 0, JSON.stringify(bounds));
      const title = await home.locator(".client-next-decision h2").innerText();
      await action.click();
      await page.locator(".ac-view-heading").waitFor();
      assert.equal(await page.locator(".ac-view-heading h3").innerText(), title);
      if (width === 390) mobile = page;
    }
    const panel = mobile.locator("#client-review-panel");
    const choose = name => panel.getByRole("button", { name, exact: true }).click();
    const row = id => panel.locator(`.client-decision-card[data-version-id="${id}"]`);
    const versionA = materials[0].currentVersion.id, versionB = materials[1].currentVersion.id;
    await openGlobal(mobile, "client-review");
    await row(versionB).waitFor();
    assert.equal(await row(versionA).count(), 0);
    await choose("На доработке");
    await row(versionA).getByRole("button", { name: "Открыть замечания", exact: true }).click();
    await mobile.locator(".ac-rail .ac-note-body").getByText(remark, { exact: true }).waitFor();
    // Finish reading before the studio publishes a correction and another client session reviews it.
    await openGlobal(mobile, "client-home");
    const revised = await upload("Уточнение освещения.jpg", { materialId: ids[0], expectedVersionId: versionA,
      correctionReport: { description: explanation, resolutions: [] } });
    await checkOrder(customer, false, ids, titles, [revised, files[1], files[2]]);
    await checkOrder(staff, true, ids, titles, [revised, files[1], files[2]]);
    await openGlobal(mobile, "client-review");
    await choose("Ожидают решения");
    await row(revised.review.versionId).getByRole("button", { name: "Проверить исправления", exact: true }).waitFor();
    assert.equal(await row(revised.review.versionId).locator("h3").innerText(), titles[0]);
    assert.equal(await row(versionA).count(), 0);
    await choose("На доработке");
    await row(revised.review.versionId).getByRole("button", { name: "Исходное замечание · версия 1", exact: true }).waitFor();
    assert.equal(await row(versionB).count(), 0);
    await choose("История");
    assert.equal(await row(versionB).count(), 0);
    await row(versionA).getByRole("button", { name: "Исправленная версия 2", exact: true }).click();
    const report = mobile.locator(".ac-correction-report");
    await report.locator("summary").click();
    await report.getByText(explanation, { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log("First use: selected stage and unassigned for both roles, A/B/C order before and after renamed v2, mobile first action and historical remarks PASS");
  } finally {
    for (const context of contexts) await context.close();
    await f.close();
  }
}

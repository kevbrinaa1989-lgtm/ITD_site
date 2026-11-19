import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ownershipFixture } from "./ownership-fixture.mjs";
import { seedApprovalDemo } from "./approval-demo.mjs";
import { openProject } from "./browser-navigation.mjs";
import { button, queue, saved, summary } from "./approval-navigation.mjs";
const { chromium } = await import(
  process.env.ITD_PLAYWRIGHT_MODULE || "playwright"
);
const f = await ownershipFixture(),
  folder = process.env.ITD_SCREENSHOT_DIR || "test-results/approval-layout";
let browser;
try {
  const { project, full } = await seedApprovalDemo(f);
  const scope = `/api/approval-center/projects/${project.id}/stages/${full.id}`;
  const state = () => f.api(scope, null, f.clients[0].cookie);
  browser = await chromium.launch({
    executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const desktop = await browser.newContext({
    viewport: { width: 1568, height: 1000 },
  });
  const page = await desktop.newPage();
  async function enter(page, login = false) {
    if (login) {
      await page.goto(f.base + "/cabinet");
      await page.locator("#login-email").fill(f.clients[0].email);
      await page.locator("#login-password").fill(f.password);
      await page.locator("#login-form .primary").click();
    }
    await openProject(page, project.id, { client: true });
    await page.locator("#tab-review").click();
    await page.locator(".ac-sheet canvas").waitFor();
  }
  const heading = (page, name) =>
    page
      .locator(".ac-view-heading h3")
      .getByText(name, { exact: true })
      .waitFor();
  const snapshot = async (p, name) => {
    await mkdir(folder, { recursive: true });
    await p.screenshot({
      path: join(folder, name + ".png"),
      animations: "disabled",
    });
    const [sheet, view, footer] = await Promise.all(
      [".ac-sheet", ".ac-viewport", ".ac-footer"].map((sel) =>
        p.locator(sel).boundingBox(),
      ),
    );
    assert.ok(
      sheet.width > view.width * 0.72 && sheet.y + sheet.height <= footer.y + 1,
    );
    assert.ok(footer.y + footer.height <= p.viewportSize().height + 1);
    assert.equal(await p.locator(".ac-rail").isVisible(), false);
    assert.ok(
      await p.locator(".ac-approve").evaluate((b) => {
        const r = b.getBoundingClientRect();
        return b.contains(
          document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
        );
      }),
      "primary action must receive touches above the cabinet navigation",
    );
    console.log(
      name,
      "sheet",
      Math.round(sheet.width),
      "x",
      Math.round(sheet.height),
      "viewport",
      Math.round(view.width),
      "x",
      Math.round(view.height),
    );
  };
  await enter(page, true);
  await page.getByText("Все страницы просмотрены", { exact: true }).waitFor();
  assert.equal(
    (await state()).materials.filter((m) => m.versions[0].viewedPages > 0)
      .length,
    1,
  );
  await button(page, "Позже").click();
  await heading(page, "План помещений");
  const second = (await state()).materials[1];
  // Keep the failed decision on screen. The retry must succeed before advancing.
  const draft = "**/stages/*/draft";
  await page.route(draft, (r) =>
    r
      .request()
      .postDataJSON()
      .entries.some((e) => e.materialId === second.id && e.decision)
      ? r.fulfill({ status: 503, json: { error: "Тестовое прерывание связи" } })
      : r.continue(),
  );
  await button(page, "Согласовать и далее").click();
  await button(page, "Повторить сохранение").waitFor();
  await heading(page, "План помещений");
  assert.equal(
    (await state()).draft.entries.filter((e) => e.decision).length,
    0,
  );
  await page.unroute(draft);
  await button(page, "Повторить сохранение").click();
  await heading(page, "План мебели");
  for (const next of ["План оборудования", "План перегородок"]) {
    await button(page, "Согласовать и далее").click();
    await heading(page, next);
  }
  await page.getByText("Просмотрено 1 из 2", { exact: true }).waitFor();
  await button(page, "Следующая страница").click();
  await page.getByText("Все страницы просмотрены", { exact: true }).waitFor();
  await saved(page);
  assert.equal(
    (await state()).materials.filter(
      (m) => m.currentVersion.status !== "pending_approval",
    ).length,
    0,
  );
  await page.locator(".ac-material.is-selected .ac-thumbnail canvas").waitFor();
  await snapshot(page, "approval-desktop");
  await page.close();
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const mobile = await phone.newPage();
  mobile.on("dialog", (d) => d.accept());
  await enter(mobile, true);
  await heading(mobile, "План перегородок");
  await mobile.getByText("Страница 2 из 2", { exact: true }).waitFor();
  await mobile.getByText("Все страницы просмотрены", { exact: true }).waitFor();
  await saved(mobile);
  await snapshot(mobile, "approval-mobile");
  await mobile.setViewportSize({ width: 320, height: 640 });
  const narrow = await mobile.locator(".ac-approve").boundingBox();
  assert.ok(narrow.x + narrow.width <= 320 && narrow.y + narrow.height <= 640);
  await mobile.setViewportSize({ width: 390, height: 844 });
  await button(mobile, "На весь экран").click();
  await button(mobile, "Выйти из полноэкранного режима").click();
  await button(mobile, "Увеличить масштаб").click();
  assert.ok((await mobile.locator(".ac-sheet").boundingBox()).width > 390);
  await button(mobile, "125%").click();
  await queue(mobile);
  await mobile.getByRole("searchbox").fill("перегородок");
  assert.equal(await mobile.locator(".ac-material").count(), 4);
  await mobile.locator(".ac-material-open").first().click();
  await button(mobile, "Нужны правки").click();
  let dialog = mobile.getByRole("dialog");
  await mobile.setViewportSize({ width: 390, height: 475 });
  await dialog
    .getByLabel("Текст замечания")
    .fill("Уточнить ширину дверного проёма");
  assert.ok(
    (await button(dialog, "Подготовить и далее").boundingBox()).y < 475,
  );
  await mobile.setViewportSize({ width: 390, height: 844 });
  await button(dialog, "Поставить отметку на документе").click();
  const sheet = mobile.locator(".ac-sheet");
  await sheet.click({ position: { x: 100, y: 120 } });
  await dialog.getByLabel("Текст замечания").waitFor();
  await button(dialog, "Закрыть").click();
  await saved(mobile);
  await mobile.reload();
  await enter(mobile);
  await button(mobile, "Нужны правки").click();
  assert.equal(
    await dialog.getByLabel("Текст замечания").inputValue(),
    "Уточнить ширину дверного проёма",
  );
  await button(dialog, "Переместить отметку · стр. 2").waitFor();
  await button(dialog, "Закрыть").click();
  await summary(mobile);
  assert.equal(await dialog.locator("article").count(), 3);
  await button(dialog, "Изменить").first().click();
  await heading(mobile, "План помещений");
  await button(mobile, "Нужны правки").click();
  await dialog.getByLabel("Текст замечания").fill("Изменить высотную отметку");
  await button(dialog, "Подготовить и далее").click();
  // Materials 3 and 4 already have decisions, so editing 2 opens 5 again.
  await heading(mobile, "План перегородок");
  await summary(mobile);
  await dialog
    .getByText("Подготовлено: 2 согласований · 1 на доработку")
    .waitFor();
  await button(dialog, "Подтверждаю отправку").click();
  await mobile.getByText(/Пакет принят/).waitFor();
  const final = await state();
  assert.equal(final.packages.length, 1);
  assert.equal(final.materials[0].currentVersion.status, "pending_approval");
  assert.equal(final.draft.entries.length, 1);
  assert.equal(final.draft.entries[0].markers[0].page, 2);
  assert.equal(final.draft.entries[0].decision, null);
  console.log(
    "PASS",
    browser.version(),
    "40 real PDFs, saved-only navigation, retry, draft recovery across devices, editable summary and partial note retained",
  );
} finally {
  await browser?.close();
  await f.close();
}

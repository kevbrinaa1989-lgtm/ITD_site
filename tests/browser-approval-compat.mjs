import assert from "node:assert/strict";
import { ownershipFixture } from "./ownership-fixture.mjs";
import { fixtures } from "./preview-fixtures.mjs";
import { openProject, openGlobal } from "./browser-navigation.mjs";
const { chromium } = await import(
  process.env.ITD_PLAYWRIGHT_MODULE || "playwright"
);
const f = await ownershipFixture();
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  for (const width of [1440, 768, 430, 375]) {
    const p = f.projects[0],
      stage = p.stages[0],
      [name, contentType, bytes] = fixtures[0];
    const file = await f.api(
      `/api/projects/${p.id}/files`,
      {
        name: `${width}-${name}`,
        contentType,
        data: bytes.toString("base64"),
        category: "result",
        stageId: stage.id,
        review: true,
      },
      f.admin,
      "POST",
      201,
    );
    const errors = [],
      contexts = [];
    const login = async (email) => {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
      });
      contexts.push(context);
      const page = await context.newPage();
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("dialog", (d) => d.accept());
      await page.goto(f.base + "/cabinet");
      await page.locator("#login-email").fill(email);
      await page.locator("#login-password").fill(f.password);
      await page.locator("#login-form .primary").click();
      return page;
    };
    const panel = async (page, name) => {
      if (width < 768)
        await page
          .locator(".ac-mobile-tools")
          .getByRole("button", { name, exact: true })
          .click();
    };
    const open = async (page, client = false) => {
      await openProject(page, p.id, { client });
      await page.locator("#tab-review").click();
      await panel(page, "Материалы");
      await page
        .locator(
          `.ac-material[data-material-id="${file.review.materialId}"] .ac-material-open`,
        )
        .click();
      await page.getByText("Изображение загружено", { exact: true }).waitFor();
      await panel(page, "Замечания и решение");
    };
    const client = await login("client0@example.test");
    await open(client, true);
    const malicious = '<img src=x onerror="window.itdXss=true">';
    await client
      .getByLabel("Комментарий к версии", { exact: true })
      .fill(malicious);
    await client
      .getByRole("button", {
        name: "Отправить комментарий сейчас",
        exact: true,
      })
      .click();
    await client
      .getByText("Комментарий отправлен и сохранён в истории", { exact: true })
      .waitFor();
    await client
      .getByRole("button", { name: "Я проверил(а) все страницы", exact: true })
      .click();
    await client
      .getByText("Комментарии и история решений", { exact: true })
      .waitFor();
    await client
      .locator(".ac-decisions")
      .getByRole("button", { name: "Согласовать", exact: true })
      .click();
    await client
      .getByRole("button", { name: "Проверить и отправить", exact: true })
      .click();
    await client
      .getByRole("dialog")
      .getByRole("button", { name: "Подтверждаю отправку", exact: true })
      .click();
    await client.getByText(/Пакет принят. Ведомость/).waitFor();
    const admin = await login("admin@example.test");
    await openGlobal(admin, "notifications");
    await admin
      .locator(".notification-card")
      .first()
      .getByRole("button", { name: "Открыть версию", exact: true })
      .click();
    await admin
      .getByRole("dialog")
      .getByRole("link", { name: "Скачать ведомость в PDF", exact: true })
      .waitFor();
    await admin
      .getByRole("dialog")
      .getByRole("button", { name: "Закрыть", exact: true })
      .click();
    await panel(admin, "Замечания и решение");
    await admin
      .getByText("Комментарии и история решений", { exact: true })
      .click();
    await admin
      .locator(".ac-rail")
      .getByText(malicious, { exact: false })
      .waitFor();
    assert.equal(await admin.evaluate(() => window.itdXss), undefined);
    assert.equal(await admin.locator(".ac-rail img").count(), 0);
    await admin
      .getByRole("button", {
        name: "Отменить согласование версии",
        exact: true,
      })
      .click();
    await admin
      .getByRole("dialog")
      .getByLabel("Причина отмены", { exact: true })
      .fill("Нужно уточнить размер");
    await admin
      .getByRole("dialog")
      .getByRole("button", { name: "Подтверждаю отмену", exact: true })
      .click();
    await admin.getByRole("dialog").waitFor({ state: "hidden" });
    const state = await f.api(
      `/api/materials/${file.review.materialId}`,
      null,
      f.admin,
    );
    assert.equal(state.material.currentVersion.status, "pending_approval");
    assert.ok(state.events.some((e) => e.type === "approved"));
    assert.ok(
      state.events.some(
        (e) =>
          e.type === "approval_cancelled" && e.body === "Нужно уточнить размер",
      ),
    );
    await client.reload();
    await open(client, true);
    await client
      .getByText("Комментарии и история решений", { exact: true })
      .click();
    await client
      .locator(".ac-rail")
      .getByText(malicious, { exact: false })
      .waitFor();
    assert.equal(await client.evaluate(() => window.itdXss), undefined);
    await client.locator("#logout-button").click();
    assert.equal(
      (
        await client.request.get(f.base + `/api/files/${file.id}/preview`)
      ).status(),
      401,
    );
    assert.equal(
      (
        await f.request(
          `/api/files/${file.id}/preview`,
          null,
          f.clients[1].cookie,
        )
      ).status,
      403,
    );
    assert.deepEqual(errors, []);
    for (const context of contexts) await context.close();
    console.log(
      `Approval compatibility ${width}px: literal comments, package notification/deep link, cancellation with immutable history, reload, logout and foreign access PASS`,
    );
  }
} finally {
  await browser?.close();
  await f.close();
}

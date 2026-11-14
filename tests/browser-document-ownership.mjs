import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ownershipFixture } from "./ownership-fixture.mjs";
import { fixtures } from "./preview-fixtures.mjs";
import {
  openProject,
  dismissWelcome,
  closeUpload,
} from "./browser-navigation.mjs";
const { chromium } = await import(
  process.env.ITD_PLAYWRIGHT_MODULE || "playwright"
);
const pdf = fixtures.find((f) => f[1] === "application/pdf"),
  jpg = fixtures.find((f) => f[1] === "image/jpeg");
const browser = await chromium.launch({
  executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
try {
  for (const width of (process.env.ITD_TEST_WIDTHS || "360,390,768,1024,1440")
    .split(",")
    .map(Number)) {
    const f = await ownershipFixture(),
      context = await browser.newContext({ viewport: { width, height: 900 } }),
      page = await context.newPage(),
      errors = [];
    try {
      page.setDefaultTimeout(15000);
      page.on("pageerror", (e) => errors.push(e.message));
      await context.route("**/*", (route) =>
        /^https?:/.test(route.request().url()) &&
        !route
          .request()
          .url()
          .startsWith(f.base + "/")
          ? route.abort()
          : route.continue(),
      );
      const [a, b] = f.projects,
        [s1, s2] = a.stages;
      async function login(email) {
        await page.goto(f.base + "/cabinet");
        await page.locator("#login-email").fill(email);
        await page.locator("#login-password").fill(f.password);
        await page.locator("#login-form .primary").click();
        await dismissWelcome(page);
      }
      async function scope(index, category = "document") {
        await closeUpload(page);
        if (index === null) await page.locator("#tab-files").click();
        else {
          await page.locator("#tab-overview").click();
          await page.locator("#project-route .route-step").nth(index).click();
          await page
            .locator("#project-route .route-links > .panel")
            .nth(category === "document" ? 1 : 0)
            .getByRole("button")
            .click();
        }
        await page.locator(`[data-library-category="${category}"]`).click();
      }
      const row = (id) =>
        page.locator(`#library-content [data-file-id="${id}"]`);
      async function visible(ids) {
        await page.waitForFunction((ids) => {
          const actual = [
            ...document.querySelectorAll("#library-content [data-file-id]"),
          ]
            .map((x) => Number(x.dataset.fileId))
            .sort((a, b) => a - b);
          return (
            JSON.stringify(actual) ===
            JSON.stringify([...ids].sort((a, b) => a - b))
          );
        }, ids);
      }
      async function upload(name, stageId, type = pdf[1], bytes = pdf[2]) {
        await page.locator("#library-upload").click();
        assert.equal(await page.locator("#upload-stage").isDisabled(), true);
        assert.equal(
          await page.locator("#upload-stage").inputValue(),
          String(stageId ?? ""),
        );
        await page
          .locator("#upload-file")
          .setInputFiles({ name, mimeType: type, buffer: bytes });
        const response = page.waitForResponse(
          (r) => r.url().endsWith("/files") && r.request().method() === "POST",
        );
        await page.locator('#upload-file-form button[type="submit"]').click();
        const result = await (await response).json();
        await page
          .locator("#library-upload-dialog")
          .waitFor({ state: "hidden" });
        assert.equal(result.stageId, stageId);
        return result;
      }
      async function shot(name) {
        await page.evaluate(() => {
          if (!document.querySelector("dialog[open]")) scrollTo(0, 0);
        });
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
          name + " overflow",
        );
        if (process.env.ITD_SCREENSHOT_DIR) {
          await mkdir(process.env.ITD_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({
            path: join(
              process.env.ITD_SCREENSHOT_DIR,
              `ownership-${name}-${width}.png`,
            ),
          });
        }
      }
      await login("admin@example.test");
      await openProject(page, a.id);
      await scope(null);
      const general = await upload("Договор-Балтика.pdf", null);
      await visible([general.id]);
      await scope(0);
      const one = await upload("Документ-Обмеры.pdf", s1.id);
      await visible([one.id]);
      await scope(1);
      const two = await upload("Документ-Планировка.pdf", s2.id);
      await visible([two.id]);
      await shot("stage-documents");
      // Resetting search cannot widen the selected stage to all project files.
      await page.locator("#library-search").fill("несуществующий файл");
      await page.locator("#library-reset").click();
      await visible([two.id]);
      await openProject(page, b.id);
      await scope(null);
      await visible([]);
      const other = await upload("Договор-Нева.pdf", null);
      await visible([other.id]);
      await openProject(page, a.id);
      if (width === 1440) {
        // A late response from A must not replace B's library.
        let release, seen;
        const gate = new Promise((resolve) => (release = resolve)),
          started = new Promise((resolve) => (seen = resolve));
        const url = `**/api/projects/${a.id}/files?stageId=${s1.id}`;
        await context.route(url, async (route) => {
          const response = await route.fetch();
          seen();
          await gate;
          await route.fulfill({ response });
        });
        await scope(0);
        await started;
        await openProject(page, b.id);
        await scope(null);
        await visible([other.id]);
        const late = page.waitForResponse((r) =>
          r.url().endsWith(`/api/projects/${a.id}/files?stageId=${s1.id}`),
        );
        release();
        await late;
        await context.unroute(url);
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        await visible([other.id]);
        await openProject(page, a.id);
        // A prepared queue cannot silently inherit another stage.
        await scope(0);
        await page.locator("#library-upload").click();
        await page.locator("#upload-file").setInputFiles({
          name: "unsent.pdf",
          mimeType: pdf[1],
          buffer: pdf[2],
        });
        await closeUpload(page);
        await scope(1);
        page.once("dialog", (dialog) => dialog.accept());
        await page.locator("#library-upload").click();
        assert.equal(
          await page.locator("#upload-file").evaluate((el) => el.files.length),
          0,
        );
        assert.equal(
          await page.locator("#upload-stage").inputValue(),
          String(s2.id),
        );
        await closeUpload(page);
      }
      await scope(null);
      await visible([general.id]);
      async function move(id, to, title) {
        await row(id).locator(".library-document-open").click();
        await page.locator("#library-document-detail .library-edit").click();
        if (title)
          await page
            .locator('#library-edit-form input[name="title"]')
            .fill(title);
        await page
          .locator('#library-edit-form select[name="stageId"]')
          .selectOption(String(to ?? ""));
        await shot("move-document");
        await page.locator('#library-edit-form button[type="submit"]').click();
        await page.locator("#library-edit-dialog").waitFor({ state: "hidden" });
        assert.equal(
          f.rows("SELECT stageId FROM files WHERE id=?", id)[0].stageId,
          to,
        );
      }
      await move(general.id, s1.id, "Договор на дизайн-проект");
      await visible([]);
      await scope(0);
      await visible([general.id, one.id]);
      await move(general.id, s2.id);
      await visible([one.id]);
      await scope(1);
      await visible([general.id, two.id]);
      await move(general.id, null);
      await visible([two.id]);
      await scope(null);
      await visible([general.id]);
      assert.match(
        await row(general.id).textContent(),
        /Договор на дизайн-проект/,
      );
      // Real image upload belongs to its chosen stage and stays out of general files.
      await scope(0, "result");
      const image = await upload("Обмеры-фото.jpg", s1.id, jpg[1], jpg[2]);
      await visible([image.id]);
      await row(image.id).locator(".gallery-open").click();
      await page.locator(".file-viewer[open]").waitFor();
      await page.locator(".file-viewer .viewer-toolbar button").click();
      await scope(1, "result");
      await visible([]);
      await scope(null, "all");
      await visible([general.id]);
      await shot("project-files");
      await page.reload();
      await dismissWelcome(page);
      await openProject(page, a.id);
      await scope(null);
      await visible([general.id]);
      await page.locator("#logout-button").click();
      await login(f.clients[0].email);
      await openProject(page, a.id, { client: true });
      await scope(null);
      await visible([general.id]);
      assert.equal(await page.locator("#library-upload").isVisible(), false);
      await row(general.id).locator(".library-document-open").click();
      assert.equal(
        await page.locator("#library-document-detail .library-edit").count(),
        0,
      );
      await page.locator("#library-document-detail .file-preview").click();
      await page.locator(".viewer-content canvas").waitFor();
      await page.locator(".file-viewer .viewer-toolbar button").click();
      await page.locator("#library-document-close").click();
      await scope(0);
      await visible([one.id]);
      await scope(1);
      await visible([two.id]);
      await shot("client-stage");
      const forbidden = await context.request.get(
        f.base + `/api/projects/${b.id}/files`,
      );
      assert.equal(forbidden.status(), 403);
      assert.equal(
        (
          await context.request.get(f.base + `/api/files/${other.id}/download`)
        ).status(),
        403,
      );
      await page.locator("#logout-button").click();
      await login("admin@example.test");
      await openProject(page, a.id);
      await scope(1);
      await row(two.id).locator(".library-document-open").click();
      page.once("dialog", (dialog) => dialog.dismiss());
      await page.locator("#library-document-detail .file-delete").click();
      assert.equal(f.rows("SELECT id FROM files WHERE id=?", two.id).length, 1);
      page.once("dialog", (dialog) => dialog.accept());
      await page.locator("#library-document-detail .file-delete").click();
      await page
        .locator("#library-document-dialog")
        .waitFor({ state: "hidden" });
      await visible([]);
      const remaining = f.rows(
        "SELECT id,projectId,stageId FROM files ORDER BY id",
      );
      assert.deepEqual(remaining, [
        { id: general.id, projectId: a.id, stageId: null },
        { id: one.id, projectId: a.id, stageId: s1.id },
        { id: other.id, projectId: b.id, stageId: null },
        { id: image.id, projectId: a.id, stageId: s1.id },
      ]);
      if (width === 1440) {
        const reviewFile = await f.api(
          `/api/projects/${a.id}/files`,
          {
            name: "review-plan.pdf",
            contentType: pdf[1],
            data: pdf[2].toString("base64"),
            category: "result",
            stageId: s1.id,
            review: true,
          },
          f.admin,
          "POST",
          201,
        );
        await f.api(
          `/api/material-versions/${reviewFile.review.versionId}/comments`,
          { text: "История до переноса" },
          f.clients[0].cookie,
          "POST",
        );
        await page.reload();
        await dismissWelcome(page);
        await openProject(page, a.id);
        await scope(0, "result");
        await row(reviewFile.id).locator(".library-more summary").click();
        await row(reviewFile.id).locator(".library-edit").click();
        await page
          .locator('#library-edit-form select[name="stageId"]')
          .selectOption("");
        await page.locator('#library-edit-form button[type="submit"]').click();
        await page.locator("#library-edit-dialog").waitFor({ state: "hidden" });
        await scope(null, "result");
        await visible([reviewFile.id]);
        await row(reviewFile.id).locator(".library-history").click();
        await page
          .locator('.ac-view-heading select[aria-label="Версия"]')
          .waitFor();
        assert.equal(
          await page
            .locator('.ac-head-tools select[aria-label="Этап"]')
            .inputValue(),
          "0",
        );
        await page.waitForFunction(() =>
          document
            .querySelector(".ac-rail")
            ?.textContent.includes("История до переноса"),
        );
        await page
          .getByRole("button", {
            name: "Загрузить исправленную версию",
            exact: true,
          })
          .click();
        const versionForm = page.getByRole("dialog").locator("form");
        await versionForm
          .getByLabel("Что изменено", { exact: true })
          .fill("Новая версия после переноса в файлы проекта");
        await versionForm.locator("input[type=file]").setInputFiles({
          name: "review-new.jpg",
          mimeType: jpg[1],
          buffer: jpg[2],
        });
        const uploaded = page.waitForResponse(
          (r) =>
            r.url().endsWith(`/api/projects/${a.id}/files`) &&
            r.request().method() === "POST",
        );
        await versionForm
          .getByRole("button", { name: "Отправить новую версию", exact: true })
          .click();
        const response = await uploaded;
        assert.equal(response.status(), 201);
        const newVersion = await response.json();
        assert.equal(newVersion.stageId, null);
        assert.equal(
          newVersion.review.materialId,
          reviewFile.review.materialId,
        );
        assert.equal(newVersion.review.versionNumber, 2);
        assert.ok(
          f
            .rows(
              "SELECT f.stageId FROM files f JOIN review_versions v ON v.fileId=f.id WHERE v.materialId=?",
              reviewFile.review.materialId,
            )
            .every((row) => row.stageId === null),
        );
      }
      assert.deepEqual(errors, []);
      console.log(
        `Document ownership ${width}px: admin/client scopes, real upload, rename/moves, images/PDF, DB, authorization, reload/login, confirmed deletion PASS`,
      );
    } finally {
      await context.close();
      await f.close();
    }
  }
} finally {
  await browser.close();
}

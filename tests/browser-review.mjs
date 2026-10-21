import { openProject, openGlobal } from "./browser-navigation.mjs";
import { prepareFixtureUpload } from "./upload-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp } from "../server.mjs";
import { fixtures } from "./preview-fixtures.mjs";
const { chromium } = await import(
  process.env.ITD_PLAYWRIGHT_MODULE || "playwright"
);
const root = await mkdtemp(join(tmpdir(), "itd-browser-review-")),
  password = randomBytes(24).toString("hex");
let app, browser;
const shots = process.env.ITD_SCREENSHOT_DIR;
if (shots) await mkdir(shots, { recursive: true });
try {
  app = createApp({
    dataDir: join(root, "data"),
    adminEmail: "admin@example.test",
    adminPassword: password,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  async function api(
    path,
    { body, cookie, method = body ? "POST" : "GET", status = 200 } = {},
  ) {
    body = await prepareFixtureUpload(base, path, body, cookie, method);

    const r = await fetch(base + path, {
      method,
      headers: {
        Origin: base,
        "X-ITD-Request": "1",
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(r.status, status, path);
    return r.json();
  }
  const auth = await fetch(base + "/api/login", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@example.test", password }),
  });
  assert.equal(auth.status, 200);
  const adminCookie = auth.headers.get("set-cookie").split(";")[0];
  await auth.json();
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 768, height: 1024 },
    { width: 430, height: 932 },
    { width: 375, height: 812 },
  ]) {
    const email = `owner${viewport.width}@example.test`,
      foreignEmail = `foreign${viewport.width}@example.test`;
    let owner, foreign;
    for (const candidate of [email, foreignEmail]) {
      const { user } = await api("/api/register", {
        body: {
          name:
            candidate === email
              ? "Анна · демонстрация"
              : "Борис · демонстрация",
          email: candidate,
          password,
        },
        status: 201,
      });
      if (candidate === email) owner = user;
      else foreign = user;
    }
    const title = `Квартира · согласование ${viewport.width}`,
      project = await api("/api/projects", {
        cookie: adminCookie,
        body: { title, clientId: owner.id },
        status: 201,
      }),
      stage = await api(`/api/projects/${project.id}/stages`, {
        cookie: adminCookie,
        body: {
          title: "Планировочное решение",
          status: "in_progress",
          description: "Материалы",
        },
        status: 201,
      });
    const [, jpgType, jpg] = fixtures.find((f) => f[0].endsWith(".jpg")),
      [, pdfType, pdf] = fixtures.find((f) => f[1] === "application/pdf");
    async function upload(name, type, bytes, extra = {}) {
      return api(`/api/projects/${project.id}/files`, {
        cookie: adminCookie,
        body: {
          name,
          contentType: type,
          data: bytes.toString("base64"),
          category: "result",
          stageId: stage.id,
          ...extra,
        },
        status: 201,
      });
    }
    const original = await upload("Планировка-v1.jpg", jpgType, jpg, {
        review: true,
      }),
      broken = await upload(
        "Повреждённый.jpg",
        jpgType,
        Buffer.from("not a valid image"),
        { review: true },
      ),
      text = await upload(
        "Комментарии.txt",
        "text/plain",
        Buffer.from("Download-only file"),
        { review: true },
      );
    const mid = original.review.materialId,
      v1 = original.review.versionId;
    const contexts = [],
      errors = [],
      external = [],
      viewRequests = [];
    async function pageFor() {
      const c = await browser.newContext({ viewport, acceptDownloads: true });
      contexts.push(c);
      await c.route("**/*", (route) => {
        const url = route.request().url();
        if (/^https?:/.test(url) && !url.startsWith(base + "/")) {
          external.push(url);
          return route.abort();
        }
        return route.continue();
      });
      const p = await c.newPage();
      p.setDefaultTimeout(12000);
      p.on("pageerror", (e) => errors.push(e.message));
      p.on("request", (r) => {
        if (
          r.method() === "POST" &&
          /\/api\/material-versions\/\d+\/view$/.test(r.url())
        )
          viewRequests.push({ url: r.url(), page: p });
      });
      await p.goto(base + "/cabinet");
      return p;
    }
    async function signIn(p, email) {
      await p.locator("#login-email").fill(email);
      await p.locator("#login-password").fill(password);
      await p.locator("#login-form button[type=submit]").click();
      await p.locator("#app-view").waitFor({ state: "visible" });
    }
    async function refresh(p) {
      await p.locator("#refresh-button").click();
      await p.waitForFunction(
        () => !document.getElementById("app-view").dataset.busy,
      );
    }
    async function open(p, id = mid) {
      await p.locator("#tab-review").click();
      const card = p.locator(
        `#review-material-list .review-card[data-material-id="${id}"]`,
      );
      await card
        .getByRole("button", {
          name: "Открыть согласование и комментарии",
          exact: true,
        })
        .click();
      await p.locator("#review-version-select").waitFor({ state: "visible" });
    }
    async function state(id = mid) {
      return api(`/api/materials/${id}`, { cookie: adminCookie });
    }
    async function shot(p, name) {
      assert.ok(
        await p.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `${name}/${viewport.width}: no horizontal page overflow`,
      );
      if (shots)
        await p.screenshot({
          path: join(shots, `review-${name}-${viewport.width}.png`),
          fullPage: true,
        });
    }
    async function closeViewer(p) {
      await p.getByRole("button", { name: "Закрыть", exact: true }).click();
      await p.locator("dialog[open]").waitFor({ state: "hidden" });
    }
    async function preview(p, versionId, kind = "image", expectView = true) {
      const response = expectView
        ? p.waitForResponse(
            (r) =>
              r.url().endsWith(`/api/material-versions/${versionId}/view`) &&
              r.request().method() === "POST",
          )
        : null;
      await p.locator("#review-material-detail .file-preview").click();
      if (kind === "pdf")
        await p.waitForFunction(
          () =>
            document.querySelector(".viewer-content canvas")?.width > 0 &&
            document
              .querySelector(".viewer-status")
              .textContent.startsWith("Страница"),
        );
      else
        await p.waitForFunction(
          () => document.querySelector(".viewer-content img")?.naturalWidth > 0,
        );
      if (response) assert.equal((await response).status(), 200);
    }
    const admin = await pageFor();
    await signIn(admin, "admin@example.test");
    await openProject(admin, title);
    await open(admin);
    assert.ok(
      (
        await admin
          .locator("#review-material-detail .review-view-status")
          .innerText()
      ).includes("Не просмотрено"),
    );
    await preview(admin, v1, "image", false);
    await closeViewer(admin);
    assert.equal(viewRequests.filter((r) => r.page === admin).length, 0);
    assert.equal((await state()).material.currentVersion.view.viewed, false);
    const client = await pageFor();
    await signIn(client, email);
    await openProject(client, title, { client: true });
    assert.equal(
      (await client.locator("#overview-next-stage").textContent()).includes(
        "Все этапы завершены",
      ),
      false,
    );
    await client.locator("#tab-stages").click();
    await client.locator("#tab-results").click();
    for (const card of await client.locator(".gallery-card").all()) {
      await card.scrollIntoViewIfNeeded();
    }
    await open(client);
    assert.equal((await state()).material.currentVersion.view.viewed, false);
    assert.equal(viewRequests.filter((r) => r.page === client).length, 0);
    const download = client.waitForEvent("download");
    await client
      .locator("#review-material-detail")
      .getByRole("link", { name: "Скачать", exact: true })
      .click();
    assert.deepEqual(await readFile(await (await download).path()), jpg);
    assert.equal((await state()).material.currentVersion.view.viewed, false);
    await preview(client, v1);
    const first = (await state()).material.currentVersion.view;
    assert.equal(first.viewCount, 1);
    const notificationsBefore = (
      await api("/api/notifications", { cookie: adminCookie })
    ).notifications.length;
    await client
      .getByRole("button", { name: "Увеличить", exact: true })
      .click();
    await client.getByRole("button", { name: /Сбросить масштаб/ }).click();
    assert.equal(viewRequests.filter((r) => r.page === client).length, 1);
    await closeViewer(client);
    await preview(client, v1);
    await closeViewer(client);
    const repeated = (await state()).material.currentVersion.view;
    assert.equal(repeated.firstViewedAt, first.firstViewedAt);
    assert.ok(
      Date.parse(repeated.lastViewedAt) >= Date.parse(first.lastViewedAt),
    );
    assert.equal(repeated.viewCount, 2);
    assert.equal(
      (await api("/api/notifications", { cookie: adminCookie })).notifications
        .length,
      notificationsBefore,
    );
    await refresh(admin);
    await open(admin);
    assert.ok(
      (
        await admin
          .locator("#review-material-detail .review-view-status")
          .innerText()
      ).includes("Просмотрено"),
    );
    await shot(admin, "viewed-admin");
    await admin.locator("#review-filter").selectOption("unviewed");
    assert.equal(
      await admin
        .locator(`#review-material-list [data-material-id="${mid}"]`)
        .count(),
      0,
    );
    await admin.locator("#review-filter").selectOption("viewed");
    await admin
      .locator(`#review-material-list [data-material-id="${mid}"]`)
      .waitFor();
    await admin.locator("#review-filter").selectOption("");
    await client
      .getByRole("button", { name: "Нужны изменения", exact: true })
      .click();
    await client.locator("#review-changes-form button[type=submit]").click();
    assert.equal(
      (await state()).material.currentVersion.status,
      "pending_approval",
    );
    const malicious =
      "<script>window.__reviewInjected=true</script> Просим увеличить проход";
    await client.locator("#review-changes-form textarea").fill(malicious);
    await client.locator("#review-changes-form button[type=submit]").click();
    await client.waitForFunction(
      () =>
        document.querySelector("#review-material-detail .review-status")
          ?.textContent === "Нужны изменения",
    );
    assert.equal(
      await client.evaluate(() => window.__reviewInjected),
      undefined,
    );
    assert.equal(
      await client.locator("#review-material-detail script").count(),
      0,
    );
    await shot(client, "changes-client");
    await refresh(admin);
    await open(admin);
    await admin
      .locator("#review-comment-form textarea")
      .fill("Уточните, пожалуйста, желаемую ширину прохода.");
    await admin.locator("#review-comment-form button[type=submit]").click();
    await admin
      .locator(".review-comments .review-comment-body")
      .getByText("Уточните, пожалуйста, желаемую ширину прохода.", {
        exact: true,
      })
      .waitFor();
    await admin
      .locator("#review-material-detail summary")
      .filter({ hasText: "Загрузить новую версию" })
      .click();
    await admin
      .locator("#review-version-upload input[type=file]")
      .setInputFiles({
        name: "Планировка-v2.pdf",
        mimeType: pdfType,
        buffer: pdf,
      });
    const uploaded = admin.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/projects/${project.id}/files`) &&
        r.request().method() === "POST",
    );
    await admin.locator("#review-version-upload button[type=submit]").click();
    assert.equal((await uploaded).status(), 201);
    await admin.waitForFunction(() =>
      document
        .querySelector("#review-version-select")
        ?.selectedOptions[0].textContent.includes("Версия 2"),
    );
    let current = (await state()).material.currentVersion;
    const v2 = current.id;
    assert.equal(current.status, "pending_approval");
    assert.equal(current.view.viewed, false);
    assert.equal(
      (await state()).versions.find((v) => v.id === v1).view.viewCount,
      2,
    );
    await refresh(client);
    await open(client);
    let release, intercepted;
    const interceptedPromise = new Promise(
        (resolve) => (intercepted = resolve),
      ),
      gate = new Promise((resolve) => (release = resolve));
    const route = `**/api/files/${current.file.id}/preview`;
    await client.route(route, async (r) => {
      intercepted();
      await gate;
      try {
        await r.continue();
      } catch {}
    });
    await client.locator("#review-material-detail .file-preview").click();
    await interceptedPromise;
    await closeViewer(client);
    release();
    await client.unroute(route);
    assert.equal((await state()).material.currentVersion.view.viewed, false);
    await preview(client, v2, "pdf");
    await closeViewer(client);
    assert.equal((await state()).material.currentVersion.view.viewCount, 1);
    client.once("dialog", (d) => d.dismiss());
    await client
      .getByRole("button", { name: "Согласовать", exact: true })
      .click();
    assert.equal(
      (await state()).material.currentVersion.status,
      "pending_approval",
    );
    client.once("dialog", (d) => d.accept());
    await client
      .getByRole("button", { name: "Согласовать", exact: true })
      .click();
    await client.waitForFunction(
      () =>
        document.querySelector("#review-material-detail .review-status")
          ?.textContent === "Согласован",
    );
    assert.equal(
      await client
        .getByRole("button", { name: "Согласовать", exact: true })
        .count(),
      0,
    );
    await shot(client, "approved-client");
    await client.locator("#review-version-select").selectOption(String(v1));
    await client.locator("#review-material-detail .review-warning").waitFor();
    assert.equal(
      await client
        .getByRole("button", { name: "Согласовать", exact: true })
        .count(),
      0,
    );
    await client
      .locator("#review-material-detail summary")
      .filter({ hasText: "История всех версий" })
      .click();
    assert.ok(
      (await client.locator(".review-history").innerText()).includes(
        "Клиент согласовал версию",
      ),
    );
    assert.ok(
      (await client.locator(".review-history").innerText()).includes(
        "Материал впервые просмотрен клиентом",
      ),
    );
    await shot(client, "version-history");
    await refresh(admin);
    await open(admin);
    await admin
      .locator("#review-material-detail summary")
      .filter({ hasText: "Отменить согласование" })
      .click();
    await admin.locator("#review-cancel-form button[type=submit]").click();
    assert.equal((await state()).material.currentVersion.status, "approved");
    await admin
      .locator("#review-cancel-form textarea")
      .fill("Клиент уточнил требования");
    admin.once("dialog", (d) => d.dismiss());
    await admin.locator("#review-cancel-form button[type=submit]").click();
    assert.equal((await state()).material.currentVersion.status, "approved");
    admin.once("dialog", (d) => d.accept());
    await admin.locator("#review-cancel-form button[type=submit]").click();
    await admin.waitForFunction(
      () =>
        document.querySelector("#review-material-detail .review-status")
          ?.textContent === "Ожидает согласования",
    );
    await refresh(client);
    await open(client);
    client.once("dialog", (d) => d.accept());
    await client
      .getByRole("button", { name: "Согласовать", exact: true })
      .click();
    await client.waitForFunction(
      () =>
        document.querySelector("#review-material-detail .review-status")
          ?.textContent === "Согласован",
    );
    await refresh(admin);
    await open(admin);
    await admin
      .locator("#review-material-detail summary")
      .filter({ hasText: "Загрузить новую версию" })
      .click();
    await admin
      .locator("#review-version-upload input[type=file]")
      .setInputFiles({
        name: "Планировка-v3.jpg",
        mimeType: jpgType,
        buffer: jpg,
      });
    await admin.locator("#review-version-upload button[type=submit]").click();
    await admin.waitForFunction(() =>
      document
        .querySelector("#review-version-select")
        ?.selectedOptions[0].textContent.includes("Версия 3"),
    );
    current = (await state()).material.currentVersion;
    assert.equal(current.status, "pending_approval");
    assert.equal(current.view.viewed, false);
    assert.equal(
      (await state()).versions.find((v) => v.id === v2).status,
      "approved",
    );
    await shot(admin, "new-version-unviewed");
    await open(client, broken.review.materialId);
    const viewCountBefore = viewRequests.filter(
      (r) => r.page === client,
    ).length;
    await client.locator("#review-material-detail .file-preview").click();
    await client.waitForFunction(() =>
      document
        .querySelector(".viewer-status")
        .textContent.includes("Не удалось"),
    );
    await closeViewer(client);
    assert.equal(
      viewRequests.filter((r) => r.page === client).length,
      viewCountBefore,
    );
    assert.equal(
      (await state(broken.review.materialId)).material.currentVersion.view
        .viewed,
      false,
    );
    await open(client, text.review.materialId);
    assert.equal(
      await client.locator("#review-material-detail .file-preview").count(),
      0,
    );
    assert.equal(
      (await state(text.review.materialId)).material.currentVersion.view.viewed,
      false,
    );
    await openGlobal(client, "notifications");
    await client.locator("#notifications-refresh").click();
    const notice = client
      .locator("#notification-list .notification-card")
      .filter({ hasText: title })
      .filter({
        has: client.getByRole("button", {
          name: "Отметить прочитанным",
          exact: true,
        }),
      })
      .first();
    await notice.waitFor();
    const beforeUnread = Number(
      await client.locator("#notification-count").textContent(),
    );
    await notice
      .getByRole("button", { name: "Отметить прочитанным", exact: true })
      .click();
    await client.waitForFunction(
      (expected) =>
        Number(document.querySelector("#notification-count").textContent) ===
        expected,
      beforeUnread - 1,
    );
    await shot(client, "notifications");
    const foreignPage = await pageFor();
    await signIn(foreignPage, foreignEmail);
    assert.equal(
      (
        await foreignPage.context().request.get(base + `/api/materials/${mid}`)
      ).status(),
      403,
    );
    assert.equal(
      (
        await foreignPage
          .context()
          .request.post(base + `/api/material-versions/${v1}/view`, {
            headers: { Origin: base, "X-ITD-Request": "1" },
            data: {},
          })
      ).status(),
      403,
    );
    await api(`/api/admin/projects/${project.id}/assign`, {
      cookie: adminCookie,
      body: { clientId: foreign.id, expectedClientId: owner.id, confirm: true },
    });
    assert.equal(
      (
        await client.context().request.get(base + `/api/materials/${mid}`)
      ).status(),
      403,
    );
    await refresh(client);
    assert.equal(
      await client.locator("#review-material-detail").textContent(),
      "",
    );
    await admin.locator("#logout-button").click();
    await admin.locator("#login-form").waitFor({ state: "visible" });
    assert.equal(
      await admin.locator("#review-material-detail").textContent(),
      "",
    );
    assert.equal(await admin.locator("#notification-list").textContent(), "");
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    for (const context of contexts) await context.close();
    console.log(
      `Review browser ${viewport.width}px: image/PDF success-only views, no list/thumb/download/admin marks, first/repeat dates, versions/changes/approval/cancel/history, notifications, ownership and layout PASS`,
    );
  }
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

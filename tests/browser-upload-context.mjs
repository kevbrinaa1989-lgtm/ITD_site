import { openProject, openUpload } from "./browser-navigation.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp } from "../server.mjs";
import { fixtures } from "./preview-fixtures.mjs";
import { prepareFixtureUpload } from "./upload-fixture.mjs";
const { chromium } = await import(
  process.env.ITD_PLAYWRIGHT_MODULE || "playwright"
);
const root = await mkdtemp(join(tmpdir(), "itd-upload-browser-")),
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
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
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
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        "X-ITD-Request": "1",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(response.status, status, path);
    return response.json();
  }
  async function loginCookie(email) {
    const response = await fetch(base + "/api/login", {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    await response.json();
    return cookie;
  }
  const adminCookie = await loginCookie("admin@example.test");
  const [, jpgType, jpg] = fixtures.find((f) => f[0].endsWith(".jpg")),
    [, pdfType, pdf] = fixtures.find((f) => f[1] === "application/pdf");
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 768, height: 1024 },
    { width: 430, height: 932 },
    { width: 375, height: 812 },
  ]) {
    const clients = [];
    for (const [letter, name] of [
      ["a", "Анна · демонстрация"],
      ["b", "Борис · демонстрация"],
    ]) {
      const email = `${letter}${viewport.width}@example.test`;
      const { user } = await api("/api/register", {
        body: { name, email, password },
        status: 201,
      });
      clients.push({ ...user, cookie: await loginCookie(email) });
    }
    const [a, b] = clients;
    const pa = await api("/api/projects", {
        cookie: adminCookie,
        body: { title: `Квартира Анны ${viewport.width}`, clientId: a.id },
        status: 201,
      }),
      pb = await api("/api/projects", {
        cookie: adminCookie,
        body: { title: `Дом Бориса ${viewport.width}`, clientId: b.id },
        status: 201,
      });
    pa.title = `Квартира Анны ${viewport.width}`;
    pb.title = `Дом Бориса ${viewport.width}`;
    const sa = await api(`/api/projects/${pa.id}/stages`, {
        cookie: adminCookie,
        body: {
          title: "Планировка Анны",
          status: "in_progress",
          description: "",
        },
        status: 201,
      }),
      sb = await api(`/api/projects/${pb.id}/stages`, {
        cookie: adminCookie,
        body: {
          title: "Планировка Бориса",
          status: "in_progress",
          description: "",
        },
        status: 201,
      });
    const seed = await api(`/api/projects/${pa.id}/files`, {
      cookie: adminCookie,
      body: {
        name: "Материал-Анны-v1.jpg",
        contentType: jpgType,
        data: jpg.toString("base64"),
        category: "result",
        stageId: sa.id,
        review: true,
      },
      status: 201,
    });
    const context = await browser.newContext({
      viewport,
      acceptDownloads: true,
    });
    const page = await context.newPage(),
      errors = [],
      external = [],
      posts = [];
    page.setDefaultTimeout(12000);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (
        r.method() === "POST" &&
        /\/api\/projects\/\d+\/files$/.test(new URL(r.url()).pathname)
      )
        posts.push({ url: r.url(), body: r.postDataJSON() });
    });
    await context.route("**/*", (r) => {
      if (
        /^https?:/.test(r.request().url()) &&
        !r
          .request()
          .url()
          .startsWith(base + "/")
      ) {
        external.push(r.request().url());
        return r.abort();
      }
      return r.continue();
    });
    await page.goto(base + "/cabinet");
    await page.locator("#login-email").fill("admin@example.test");
    await page.locator("#login-password").fill(password);
    await page.locator("#login-form button[type=submit]").click();
    await page.locator("#app-view").waitFor({ state: "visible" });
    const form = page.locator("#upload-file-form");
    async function select(project) {
      await openProject(page, project.id);
      await openUpload(page);
      const details = form.locator("..");
      if (await details.evaluate((el) => el.tagName === "DETAILS" && !el.open))
        await details.locator("summary").click();
      await form.waitFor({ state: "visible" });
    }
    async function choose(file, project = pa, target = form) {
      const prepared = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/api/projects/${project.id}/upload-intents`) &&
          r.request().method() === "POST",
      );
      await target.locator("input[type=file]").setInputFiles(file);
      assert.equal((await prepared).status(), 201);
    }
    async function send(project = pa, target = form) {
      const response = page.waitForResponse(
        (r) =>
          r.url().endsWith(`/api/projects/${project.id}/files`) &&
          r.request().method() === "POST",
      );
      await target.locator("button[type=submit]").click();
      const r = await response;
      assert.equal(r.status(), 201);
      const result = await r.json();
      await page.waitForFunction(
        () => !document.querySelector("#upload-file-form").dataset.busy,
      );
      return result;
    }
    async function waitCleared(target = form) {
      await target.locator("input[type=file]").evaluate(
        (el) =>
          el.files.length === 0 ||
          new Promise((resolve) => {
            const timer = setInterval(() => {
              if (el.files.length === 0) {
                clearInterval(timer);
                resolve(true);
              }
            }, 10);
          }),
      );
    }
    async function shot(name) {
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `${name}: no page overflow`,
      );
      if (shots)
        await page.screenshot({
          path: join(shots, `upload-${name}-${viewport.width}.png`),
        });
    }
    async function fileBytes(file, owner, expectedStatus = 200) {
      const response = await fetch(base + `/api/files/${file.id}/download`, {
        headers: { Cookie: owner.cookie },
      });
      assert.equal(response.status, expectedStatus);
      return Buffer.from(await response.arrayBuffer());
    }
    await select(pa);
    let releaseIntent, intentSeen;
    const intentGate = new Promise((resolve) => (releaseIntent = resolve)),
      intentIntercepted = new Promise((resolve) => (intentSeen = resolve));
    const intentRoute = `**/api/projects/${pa.id}/upload-intents`;
    await page.route(intentRoute, async (route) => {
      intentSeen();
      await intentGate;
      try {
        await route.continue();
      } catch {}
    });
    await form.locator("input[type=file]").setInputFiles({
      name: "Смета-Анны.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Synthetic draft for Anna"),
    });
    await intentIntercepted;
    await openProject(page, pb.id, { wait: false });
    await page.locator("#upload-switch-dialog[open]").waitFor();
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "upload-stay",
    );
    assert.equal(posts.length, 0);
    await shot("stay-dialog");
    await page.locator("#upload-stay").click();
    assert.equal(await page.locator("#project-title").textContent(), pa.title);
    assert.equal(
      await form.locator("input[type=file]").evaluate((el) => el.files[0].name),
      "Смета-Анны.txt",
    );
    await openProject(page, pb.id, { wait: false });
    await page.locator("#upload-switch-dialog[open]").waitFor();
    await page.locator("#upload-discard").click();
    releaseIntent();
    await page.unroute(intentRoute);
    await openUpload(page);
    await waitCleared();
    assert.equal(await page.locator("#project-title").textContent(), pb.title);
    assert.equal(
      posts.length,
      0,
      "Switching never sends a selected file automatically",
    );
    assert.equal(
      (await api("/api/projects", { cookie: b.cookie })).projects[0].files
        .length,
      0,
    );
    assert.ok(
      (await page.locator("#upload-project-name").textContent()).includes(
        pb.title,
      ),
    );
    assert.ok(
      (await page.locator("#upload-client-name").textContent()).includes(
        b.email,
      ),
    );
    const bBytes = Buffer.from(
      "Synthetic document reselected explicitly for Boris",
    );
    await choose(
      { name: "Документ-Бориса.txt", mimeType: "text/plain", buffer: bBytes },
      pb,
    );
    await form.locator("select[name=category]").selectOption("document");
    const bDocument = await send(pb);
    await waitCleared();
    assert.deepEqual(await fileBytes(bDocument, b), bBytes);
    await fileBytes(bDocument, a, 403);
    assert.ok(posts[0].url.endsWith(`/projects/${pb.id}/files`));
    await select(pa);
    await choose({
      name: "Изображение-Анны.jpg",
      mimeType: jpgType,
      buffer: jpg,
    });
    await form.locator("select[name=category]").selectOption("result");
    await form.locator("select[name=stageId]").selectOption(String(sa.id));
    await form.locator("#upload-for-review").check();
    await shot("receiver-image");
    const aImage = await send();
    await waitCleared();
    assert.ok(aImage.review);
    assert.deepEqual(await fileBytes(aImage, a), jpg);
    await fileBytes(aImage, b, 403);
    await choose({ name: "Договор-Анны.pdf", mimeType: pdfType, buffer: pdf });
    await form.locator("select[name=category]").selectOption("document");
    const aPdf = await send();
    await waitCleared();
    assert.deepEqual(await fileBytes(aPdf, a), pdf);
    await fileBytes(aPdf, b, 403);
    // During the request, navigation is blocked; it cannot retarget an already captured body.
    await choose({
      name: "В-процессе-Анна.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("In flight for Anna"),
    });
    await form.locator("select[name=category]").selectOption("document");
    let releaseFile, fileSeen;
    const fileGate = new Promise((resolve) => (releaseFile = resolve)),
      fileIntercepted = new Promise((resolve) => (fileSeen = resolve)),
      fileRoute = `**/api/projects/${pa.id}/files`;
    await page.route(fileRoute, async (route) => {
      fileSeen();
      await fileGate;
      try {
        await route.continue();
      } catch {}
    });
    const inflightResponse = page.waitForResponse((r) =>
      r.url().endsWith(`/api/projects/${pa.id}/files`),
    );
    await form.locator("button[type=submit]").click();
    await fileIntercepted;
    await openProject(page, pb.id, { wait: false });
    assert.equal(await page.locator("#project-title").textContent(), pa.title);
    assert.equal(await page.locator("#upload-switch-dialog[open]").count(), 0);
    assert.ok(
      (await page.locator("#status-message").textContent()).includes(
        "Дождитесь",
      ),
    );
    await shot("in-flight-blocked");
    releaseFile();
    assert.equal((await inflightResponse).status(), 201);
    await page.unroute(fileRoute);
    await waitCleared();
    // The server saves the first request, but the browser loses its response. Retry must reuse the receipt.
    await openProject(page, pa.id);
    await openUpload(page);
    const retryName = "Повтор-Анна.txt";
    await choose({
      name: retryName,
      mimeType: "text/plain",
      buffer: Buffer.from("Identical receipt retry"),
    });
    await form.locator("select[name=category]").selectOption("document");
    let savedReceipt;
    await page.route(fileRoute, async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 201);
      savedReceipt = await response.json();
      await route.abort("failed");
    });
    const beforeRetryPosts = posts.length;
    await form.locator("button[type=submit]").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#status-message")
        .textContent.includes("Нет связи с сервером"),
    );
    assert.equal(
      await form.locator("input[type=file]").evaluate((el) => el.files[0].name),
      retryName,
    );
    await page.unroute(fileRoute);
    await openProject(page, pb.id, { wait: false });
    await page.locator("#upload-stay").click();
    assert.equal(await page.locator("#project-title").textContent(), pa.title);
    await openProject(page, pa.id);
    await openUpload(page);
    const retry = await send();
    await waitCleared();
    assert.equal(retry.id, savedReceipt.id);
    assert.equal(
      posts[beforeRetryPosts].body.uploadIntent,
      posts[beforeRetryPosts + 1].body.uploadIntent,
    );
    const aProjects = (await api("/api/projects", { cookie: a.cookie }))
      .projects;
    assert.equal(
      aProjects
        .find((p) => p.id === pa.id)
        .files.filter((f) => f.name === retryName).length,
      1,
    );
    await fileBytes(retry, b, 403);
    async function versionForm() {
      await page.locator("#tab-review").click();
      await page
        .locator(
          `#review-material-list [data-material-id="${seed.review.materialId}"]`,
        )
        .getByRole("button", {
          name: "Открыть согласование и комментарии",
          exact: true,
        })
        .click();
      await page.locator("#review-version-select").waitFor();
      const box = page.locator("#review-version-upload").locator("..");
      await box.locator("summary").click();
      return page.locator("#review-version-upload");
    }
    let version = await versionForm();
    await choose(
      { name: "Планировка-Анны-v2.pdf", mimeType: pdfType, buffer: pdf },
      pa,
      version,
    );
    assert.ok(
      (await version.locator(".upload-recipient").textContent()).includes(
        pa.title,
      ),
    );
    assert.ok(
      (await version.locator(".upload-recipient").textContent()).includes(
        a.email,
      ),
    );
    await openProject(page, pb.id, { wait: false });
    await page.locator("#upload-switch-dialog[open]").waitFor();
    await page.locator("#upload-stay").click();
    assert.equal(
      await version
        .locator("input[type=file]")
        .evaluate((el) => el.files.length),
      1,
    );
    await openProject(page, pb.id, { wait: false });
    await page.locator("#upload-discard").click();
    assert.equal(
      (
        await api(`/api/materials/${seed.review.materialId}`, {
          cookie: adminCookie,
        })
      ).versions.length,
      1,
    );
    await select(pa);
    version = await versionForm();
    await choose(
      { name: "Планировка-Анны-v2.pdf", mimeType: pdfType, buffer: pdf },
      pa,
      version,
    );
    await shot("version-receiver");
    const versionResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/projects/${pa.id}/files`) &&
        r.request().method() === "POST",
    );
    await version.locator("button[type=submit]").click();
    const uploadedVersion = await (await versionResponse).json();
    assert.equal(uploadedVersion.review.materialId, seed.review.materialId);
    const detail = await api(`/api/materials/${seed.review.materialId}`, {
      cookie: adminCookie,
    });
    assert.equal(detail.versions.length, 2);
    assert.equal(detail.material.currentVersion.file.id, uploadedVersion.id);
    assert.deepEqual(await fileBytes(uploadedVersion, a), pdf);
    await fileBytes(uploadedVersion, b, 403);
    await page.waitForFunction(() =>
      document
        .querySelector("#review-message")
        .textContent.includes("Новая версия отправлена"),
    );
    // A project can be reassigned in another administrator tab. Both prepared
    // forms must be cleared and show the actual recipient after refreshing.
    version = await versionForm();
    await choose(
      { name: "После-переназначения.pdf", mimeType: pdfType, buffer: pdf },
      pa,
      version,
    );
    await select(pa);
    await choose({
      name: "Не-отправленный-документ.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("temporary upload context test"),
    });
    const beforeAssignment = posts.length;
    await api(`/api/admin/projects/${pa.id}/assign`, {
      cookie: adminCookie,
      body: { clientId: b.id, expectedClientId: a.id, confirm: true },
    });
    await page.locator("#refresh-button").click();
    await page.waitForFunction(
      (email) =>
        document
          .querySelector("#upload-client-name")
          .textContent.includes(email),
      b.email,
    );
    assert.equal(
      await form.locator("input[type=file]").evaluate((el) => el.files.length),
      0,
    );
    assert.equal(
      await version
        .locator("input[type=file]")
        .evaluate((el) => el.files.length),
      0,
    );
    assert.ok(
      (await version.locator(".upload-recipient").textContent()).includes(
        b.email,
      ),
    );
    assert.equal(posts.length, beforeAssignment);
    await page.locator("#tab-review").click();
    await choose(
      { name: "После-переназначения.pdf", mimeType: pdfType, buffer: pdf },
      pa,
      version,
    );
    const reassignedResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/api/projects/${pa.id}/files`) &&
        r.request().method() === "POST",
    );
    await version.locator("button[type=submit]").click();
    const reassigned = await (await reassignedResponse).json();
    assert.deepEqual(await fileBytes(reassigned, b), pdf);
    await fileBytes(reassigned, a, 403);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    await context.close();
    console.log(
      `Upload context ${viewport.width}px: delayed preparation, stay/discard, explicit reselection, image/PDF/document recipients, in-flight block, lost-response idempotent retry, version isolation and reassigned recipient refresh PASS`,
    );
  }
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

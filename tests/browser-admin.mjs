import { prepareFixtureUpload } from "./upload-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp } from "../server.mjs";
import { fixtures } from "./preview-fixtures.mjs";
const { chromium } = await import(
  process.env.ITD_PLAYWRIGHT_MODULE || "playwright"
);
const root = await mkdtemp(join(tmpdir(), "itd-browser-admin-")),
  password = randomBytes(24).toString("hex");
let app, browser;
const screenshots = process.env.ITD_SCREENSHOT_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
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
  const login = await fetch(base + "/api/login", {
    method: "POST",
    headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ email: "admin@example.test", password }),
  });
  assert.equal(login.status, 200);
  const adminCookie = login.headers.get("set-cookie").split(";")[0];
  await login.json();
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 768, height: 1024 },
    { width: 430, height: 932 },
    { width: 375, height: 812 },
  ]) {
    const email = `anna${viewport.width}@example.test`,
      nextEmail = `boris${viewport.width}@example.test`,
      emptyEmail = `empty${viewport.width}@example.test`;
    const users = [];
    for (const [name, candidate] of [
      ["Анна · демонстрация", email],
      ["Борис · демонстрация", nextEmail],
      ["Клиент без проектов", emptyEmail],
    ]) {
      const { user } = await api("/api/register", {
        body: { name, email: candidate, password },
        status: 201,
      });
      users.push(user);
    }
    const [owner, next] = users;
    const title = `Квартира в Садовых кварталах · ${viewport.width}`;
    const project = await api("/api/projects", {
      cookie: adminCookie,
      body: { title, clientId: owner.id, status: "В работе" },
      status: 201,
    });
    const stage = await api(`/api/projects/${project.id}/stages`, {
      cookie: adminCookie,
      body: {
        title: "Планировочное решение",
        status: "completed",
        description: "Согласовано",
      },
      status: 201,
    });
    const [, contentType, bytes] = fixtures.find(
      (row) => row[1] === "image/png",
    );
    const file = await api(`/api/projects/${project.id}/files`, {
      cookie: adminCookie,
      body: {
        name: "Планировка.png",
        contentType,
        category: "result",
        stageId: stage.id,
        data: bytes.toString("base64"),
      },
      status: 201,
    });
    const contexts = [],
      errors = [],
      external = [];
    async function pageFor() {
      const c = await browser.newContext({ viewport });
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
      p.setDefaultTimeout(10000);
      p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(base + "/cabinet");
      return p;
    }
    async function signIn(p, email) {
      await p.locator("#login-email").fill(email);
      await p.locator("#login-password").fill(password);
      await p.locator("#login-form button[type=submit]").click();
      await p.locator("#app-view").waitFor({ state: "visible" });
    }
    async function screenshot(p, name) {
      assert.ok(
        await p.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `${name} at ${viewport.width}: no page overflow`,
      );
      if (screenshots)
        await p.screenshot({
          path: join(screenshots, `admin-${name}-${viewport.width}.png`),
          fullPage: true,
        });
    }
    async function searchClients(p, value) {
      await p.locator("#admin-client-query").fill(value);
      await p.locator("#admin-client-search button[type=submit]").click();
    }
    async function searchProjects(p, value) {
      await p.locator("#admin-project-query").fill(value);
      const response = p.waitForResponse((r) =>
        r.url().includes("/api/admin/projects?"),
      );
      await p.locator("#admin-project-search button[type=submit]").click();
      await response;
    }
    async function clientDetail(p, email) {
      await searchClients(p, email);
      await p
        .locator("#admin-client-list button.admin-record")
        .filter({ hasText: email })
        .click();
      await p.locator("#admin-client-detail h3").waitFor();
    }
    async function projectDetail(p, title) {
      await searchProjects(p, title);
      await p
        .locator("#admin-project-list button.admin-record")
        .filter({ hasText: title })
        .click();
      await p.locator("#admin-project-detail h3").waitFor();
    }
    const oldOwner = await pageFor();
    await signIn(oldOwner, email);
    assert.equal(await oldOwner.locator("#tab-clients").isVisible(), false);
    assert.equal(await oldOwner.locator("#tab-projects").isVisible(), false);
    const admin = await pageFor();
    await signIn(admin, "admin@example.test");
    await admin.locator("#tab-clients").click();
    await clientDetail(admin, emptyEmail);
    await admin
      .getByText("У клиента пока нет проектов.", { exact: true })
      .waitFor();
    await screenshot(admin, "empty-client");
    await searchClients(admin, "no-such-client");
    assert.equal(await admin.locator("#admin-client-list button").count(), 0);
    await admin.getByText("Клиенты не найдены.", { exact: true }).waitFor();
    await clientDetail(admin, email);
    assert.equal(
      await admin
        .locator(
          "#admin-client-detail input[type=email],#admin-client-detail input[name=email]",
        )
        .count(),
      0,
    );
    await admin
      .locator("#admin-client-detail summary")
      .filter({ hasText: "Изменить имя" })
      .click();
    const renamed = "Анна <script>демонстрация</script>";
    await admin.locator("#admin-client-detail input[name=name]").fill(renamed);
    await admin
      .getByRole("button", { name: "Сохранить имя", exact: true })
      .click();
    await admin.waitForFunction(
      (expected) =>
        document.querySelector("#admin-client-detail h3")?.textContent ===
        expected,
      renamed,
    );
    assert.equal(await admin.locator("#admin-client-detail script").count(), 0);
    assert.ok(
      (await admin.locator("#admin-client-detail").innerText()).includes(email),
    );
    admin.once("dialog", (d) => d.dismiss());
    await admin
      .getByRole("button", { name: "Отключить доступ", exact: true })
      .click();
    assert.equal(
      (await api(`/api/admin/clients/${owner.id}`, { cookie: adminCookie }))
        .client.isActive,
      true,
    );
    assert.equal(
      (await oldOwner.context().request.get(base + "/api/me")).status(),
      200,
    );
    admin.once("dialog", (d) => d.accept());
    await admin
      .getByRole("button", { name: "Отключить доступ", exact: true })
      .click();
    await admin
      .getByRole("button", { name: "Восстановить доступ", exact: true })
      .waitFor();
    assert.equal(
      (await oldOwner.context().request.get(base + "/api/me")).status(),
      401,
    );
    await screenshot(admin, "disabled-client");
    admin.once("dialog", (d) => d.accept());
    await admin
      .getByRole("button", { name: "Восстановить доступ", exact: true })
      .click();
    await admin
      .getByRole("button", { name: "Отключить доступ", exact: true })
      .waitFor();
    await oldOwner.reload();
    await signIn(oldOwner, email);
    await admin.locator("#tab-projects").click();
    await searchProjects(admin, "missing-project");
    await admin.getByText("Проекты не найдены.", { exact: true }).waitFor();
    await projectDetail(admin, title);
    await screenshot(admin, "project-detail");
    await admin
      .locator("#admin-project-detail summary")
      .filter({ hasText: "Изменить название и статус" })
      .click();
    const edited = `Интерьер <script>безопасно</script> · ${viewport.width}`;
    await admin.locator("#admin-project-detail input[name=title]").fill(edited);
    await admin
      .locator("#admin-project-detail select[name=status]")
      .selectOption("На паузе");
    await admin
      .getByRole("button", { name: "Сохранить изменения", exact: true })
      .click();
    await admin.waitForFunction(
      (expected) =>
        document.querySelector("#admin-project-detail h3")?.textContent ===
        expected,
      edited,
    );
    assert.equal(
      await admin.locator("#admin-project-detail script").count(),
      0,
    );
    await admin.locator("#admin-project-query").fill(email);
    await admin.locator("#admin-project-search button[type=submit]").click();
    await admin
      .locator("#admin-project-list button.admin-record")
      .filter({ hasText: edited })
      .waitFor();
    await admin.locator("#admin-project-filter").selectOption("Завершён");
    await admin.getByText("Проекты не найдены.", { exact: true }).waitFor();
    await admin.locator("#admin-project-filter").selectOption("active");
    await projectDetail(admin, edited);
    const assignDetails = admin
      .locator("#admin-project-detail details")
      .filter({
        has: admin
          .locator("summary")
          .filter({ hasText: "Назначить другого клиента" }),
      });
    await assignDetails.locator("summary").click();
    await assignDetails
      .locator("select[name=clientId]")
      .selectOption(String(next.id));
    await assignDetails
      .getByRole("button", { name: "Переназначить проект", exact: true })
      .click();
    assert.equal(
      (await api(`/api/admin/projects/${project.id}`, { cookie: adminCookie }))
        .project.clientId,
      owner.id,
    );
    await assignDetails.locator("input[type=checkbox]").check();
    admin.once("dialog", (d) => d.dismiss());
    await assignDetails
      .getByRole("button", { name: "Переназначить проект", exact: true })
      .click();
    assert.equal(
      (await api(`/api/admin/projects/${project.id}`, { cookie: adminCookie }))
        .project.clientId,
      owner.id,
    );
    admin.once("dialog", (d) => d.accept());
    await assignDetails
      .getByRole("button", { name: "Переназначить проект", exact: true })
      .click();
    await admin.waitForFunction(
      (expected) =>
        document
          .querySelector("#admin-project-detail")
          ?.textContent.includes(expected),
      nextEmail,
    );
    assert.equal(
      (
        await oldOwner
          .context()
          .request.get(base + `/api/files/${file.id}/download`)
      ).status(),
      403,
    );
    assert.equal(
      (
        await oldOwner
          .context()
          .request.get(base + `/api/files/${file.id}/preview`)
      ).status(),
      403,
    );
    const nextClient = await pageFor();
    await signIn(nextClient, nextEmail);
    for (const action of ["download", "preview"]) {
      const response = await nextClient
        .context()
        .request.get(base + `/api/files/${file.id}/${action}`);
      assert.equal(response.status(), 200);
      assert.deepEqual(await response.body(), bytes);
    }
    admin.once("dialog", (d) => d.dismiss());
    await admin
      .getByRole("button", { name: "Переместить в архив", exact: true })
      .click();
    assert.equal(
      (await api(`/api/admin/projects/${project.id}`, { cookie: adminCookie }))
        .project.status,
      "На паузе",
    );
    admin.once("dialog", (d) => d.accept());
    await admin
      .getByRole("button", { name: "Переместить в архив", exact: true })
      .click();
    await admin
      .getByRole("button", { name: "Восстановить из архива", exact: true })
      .waitFor();
    await screenshot(admin, "archived-project");
    await nextClient.locator("#refresh-button").click();
    await nextClient.waitForFunction(
      () => !document.getElementById("app-view").dataset.busy,
    );
    assert.equal(
      await nextClient
        .locator("#project-list button")
        .filter({ hasText: edited })
        .count(),
      0,
    );
    await nextClient.locator("#sidebar-show-archive").check();
    await nextClient
      .locator("#project-list button")
      .filter({ hasText: edited })
      .waitFor();
    await screenshot(nextClient, "client-archive");
    await admin.locator("#admin-project-filter").selectOption("Архив");
    await admin.locator("#admin-project-query").fill(nextEmail);
    await admin.locator("#admin-project-search button[type=submit]").click();
    await admin
      .locator("#admin-project-list button.admin-record")
      .filter({ hasText: edited })
      .waitFor();
    admin.once("dialog", (d) => d.accept());
    await admin
      .getByRole("button", { name: "Восстановить из архива", exact: true })
      .click();
    await admin
      .getByRole("button", { name: "Переместить в архив", exact: true })
      .waitFor();
    assert.equal(
      (await api(`/api/admin/projects/${project.id}`, { cookie: adminCookie }))
        .project.status,
      "На паузе",
    );
    await admin
      .locator("#admin-project-detail summary")
      .filter({ hasText: "История действий" })
      .click();
    assert.ok(
      (
        await admin
          .locator("#admin-project-detail .recovery-history")
          .innerText()
      ).includes("Клиент проекта изменён"),
    );
    await screenshot(admin, "restored-project");
    await admin.locator("#tab-management").click();
    await admin.locator("#create-title").fill(`Новый проект ${viewport.width}`);
    await admin.locator("#create-client").selectOption(String(owner.id));
    await admin.locator("#create-status").selectOption("Новый");
    await admin.locator("#create-project-form button[type=submit]").click();
    await admin.waitForFunction(
      (expected) =>
        document.querySelector("#project-title")?.textContent === expected,
      `Новый проект ${viewport.width}`,
    );
    await admin.locator("#logout-button").click();
    await admin.locator("#login-form").waitFor({ state: "visible" });
    assert.equal(await admin.locator("#admin-client-detail").textContent(), "");
    assert.equal(
      await admin.locator("#admin-project-detail").textContent(),
      "",
    );
    assert.equal(
      (
        await admin.context().request.get(base + "/api/admin/projects")
      ).status(),
      401,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    for (const context of contexts) await context.close();
    console.log(
      `Admin browser ${viewport.width}px: search, empty details, name/status edits, confirmations/cancel, disable/reactivate, reassignment+file access, archive/restore/filter, create project, logout, no overflow or external requests PASS`,
    );
  }
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

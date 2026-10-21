import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp } from "../server.mjs";
import { openProject, openGlobal } from "./browser-navigation.mjs";
const { chromium } = await import(
  process.env.ITD_PLAYWRIGHT_MODULE || "playwright"
);
const root = await mkdtemp(join(tmpdir(), "itd-approved-interface-"));
const password = randomBytes(24).toString("hex"),
  screenshots = process.env.ITD_SCREENSHOT_DIR;
let app, browser;
try {
  if (screenshots) await mkdir(screenshots, { recursive: true });
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
  const errors = [],
    external = [];
  async function api(path, body, cookie) {
    const response = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Origin: base,
        "X-ITD-Request": "1",
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.ok(response.ok, `${path}: ${response.status}`);
    return {
      data: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  const adminAuth = await api("/api/login", {
    email: "admin@example.test",
    password,
  });
  for (const width of [1440, 768, 430, 375]) {
    const email = `interface${width}@example.test`,
      title = `Квартира · проверка ${width}`;
    const {
      data: { user },
      cookie: clientCookie,
    } = await api("/api/register", {
      name: "Анна · демонстрация",
      email,
      password,
    });
    const { data: project } = await api(
      "/api/projects",
      { title, clientId: user.id },
      adminAuth.cookie,
    );
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
    });
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (/^https?:/.test(url) && !url.startsWith(base + "/")) {
        external.push(url);
        return route.abort();
      }
      return route.continue();
    });
    const extraContexts = [];
    async function login(email, isolated = false) {
      const sessionContext = isolated
        ? await browser.newContext({ viewport: { width, height: 1000 } })
        : context;
      if (isolated) {
        extraContexts.push(sessionContext);
        await sessionContext.route("**/*", (route) => {
          const url = route.request().url();
          if (/^https?:/.test(url) && !url.startsWith(base + "/")) {
            external.push(url);
            return route.abort();
          }
          return route.continue();
        });
      }
      const page = await sessionContext.newPage();
      page.setDefaultTimeout(12000);
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(base + "/cabinet");
      await page.locator("#login-email").fill(email);
      await page.locator("#login-password").fill(password);
      await page.locator("#login-form button[type=submit]").click();
      await page.locator("#app-view").waitFor({ state: "visible" });
      return page;
    }
    async function noOverflow(page) {
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `horizontal overflow at ${width}`,
      );
    }
    const admin = await login("admin@example.test");
    assert.equal(
      await admin.locator("#project-heading").isVisible(),
      false,
      "Admin starts in global context",
    );
    await admin.locator("#workspace-new-project").click();
    await admin.locator("#create-project-form").waitFor({ state: "visible" });
    assert.equal(
      await admin
        .locator("#create-project-stages input[type=checkbox]")
        .count(),
      7,
    );
    assert.equal(
      await admin.locator("#create-project-stages input:checked").count(),
      0,
    );
    const unassignedTitle = `Без клиента · ${width}`;
    await admin.locator("#create-title").fill(unassignedTitle);
    await admin
      .locator("#create-description")
      .fill("Описание будущего проекта");
    await admin
      .locator("#create-project-stages input[type=checkbox]")
      .nth(0)
      .check();
    await admin
      .locator("#create-project-stages input[type=checkbox]")
      .nth(3)
      .check();
    const created = admin.waitForResponse(
      (r) =>
        r.url().endsWith("/api/projects") && r.request().method() === "POST",
    );
    await admin.locator("#create-project-form button[type=submit]").click();
    assert.equal((await created).status(), 201);
    const {
      data: { projects: adminProjects },
    } = await api("/api/projects", null, adminAuth.cookie);
    const unassigned = adminProjects.find((p) => p.title === unassignedTitle);
    assert.ok(unassigned);
    assert.equal(unassigned.clientId, null);
    assert.deepEqual(
      unassigned.stages.map((s) => s.title),
      ["Обмеры", "Визуализации"],
    );
    assert.ok(unassigned.stages.every((s) => s.status === "planned"));
    const {
      data: { projects: clientProjects },
    } = await api("/api/projects", null, clientCookie);
    assert.equal(
      clientProjects.some((p) => p.id === unassigned.id),
      false,
      "Unassigned project is not exposed to client",
    );
    await openProject(admin, unassigned.id);
    await admin
      .locator("#project-actions")
      .getByRole("button", { name: "Назначить клиента", exact: true })
      .click();
    assert.equal(
      await admin.locator("#tab-settings").getAttribute("aria-selected"),
      "true",
    );
    const assignmentDetails = admin
      .locator("#admin-project-detail details")
      .filter({
        has: admin.locator("summary").filter({ hasText: "Назначить клиента" }),
      });
    if (!(await assignmentDetails.evaluate((el) => el.open)))
      await assignmentDetails.locator("summary").click();
    await admin
      .locator("#admin-project-detail select[name=clientId]")
      .waitFor({ state: "visible" });
    await admin.locator("#tab-stages").click();
    const firstStage = admin.locator(
      `#stage-list .stage-card[data-stage-id="${unassigned.stages[0].id}"]`,
    );
    await firstStage
      .getByRole("button", { name: "Открыть этап", exact: true })
      .click();
    await firstStage
      .getByRole("button", { name: "Загрузить материал в этап", exact: true })
      .click();
    await admin.locator("#upload-file-form").waitFor({ state: "visible" });
    assert.equal(
      await admin.locator("#upload-stage").inputValue(),
      String(unassigned.stages[0].id),
    );
    assert.ok(
      (await admin.locator("#upload-client-name").textContent()).includes(
        "Без клиента",
      ),
    );
    await admin
      .locator("#project-actions")
      .getByRole("button", { name: "Создать задачу", exact: true })
      .click();
    await admin.locator("#task-edit-form").waitFor({ state: "visible" });
    assert.equal(
      await admin
        .locator("#task-edit-form select[name=projectId]")
        .inputValue(),
      String(unassigned.id),
    );
    await openProject(admin, project.id);
    await admin.locator("#project-client button").click();
    await admin
      .locator("#admin-client-detail h3")
      .waitFor({ state: "visible" });
    await admin
      .locator("#admin-client-detail .admin-linked-projects button")
      .filter({ hasText: title })
      .click();
    await admin.locator("#project-heading").waitFor({ state: "visible" });
    await admin.locator("#shell-back").click();
    await admin
      .locator("#admin-client-detail h3")
      .waitFor({ state: "visible" });
    await admin.waitForFunction(
      (email) =>
        document.querySelector("#admin-client-detail input[name=email]")
          ?.value === email,
      email,
    );
    await openProject(admin, project.id);
    await admin.locator("#tab-stages").click();
    assert.equal(
      await admin.locator("#stage-list .stage-card").count(),
      0,
      "No fabricated template stages",
    );
    await noOverflow(admin);
    const client = await login(email, true);
    assert.equal(
      await client.locator("#project-heading").isVisible(),
      false,
      "Client starts in global context",
    );
    for (const selector of [
      "#tab-workspace",
      "#tab-tasks",
      "#tab-clients",
      "#tab-recovery",
    ])
      assert.equal(await client.locator(selector).isVisible(), false, selector);
    await openGlobal(client, "profile");
    assert.equal(await client.locator("#profile-email").inputValue(), email);
    assert.equal(
      await client.locator("#profile-email").getAttribute("readonly"),
      "",
    );
    const profileSaved = client.waitForResponse(
      (r) =>
        r.url().endsWith("/api/me/profile") && r.request().method() === "PATCH",
    );
    await client.locator("#profile-name").fill(`Анна ${width}`);
    await client.locator("#profile-phone").fill("+7 (999) 123-45-67");
    await client.locator("#profile-form button[type=submit]").click();
    assert.equal((await profileSaved).status(), 200);
    await client.reload();
    await openGlobal(client, "profile");
    assert.equal(
      await client.locator("#profile-name").inputValue(),
      `Анна ${width}`,
    );
    assert.equal(
      await client.locator("#profile-phone").inputValue(),
      "+7 (999) 123-45-67",
    );
    await openProject(client, project.id, { client: true });
    await client.locator("#tab-overview").click();
    await noOverflow(client);
    await client.evaluate(() => window.scrollTo(0, 0));
    if (screenshots)
      await client.screenshot({
        path: join(screenshots, `client-overview-${width}.png`),
        fullPage: true,
      });
    for (const extra of extraContexts) await extra.close();
    await context.close();
    assert.ok(clientCookie);
  }
  assert.deepEqual(errors, [], "Browser errors");
  assert.deepEqual(external, [], "External network");
  console.log("Approved interface: 1440/768/430/375 PASS");
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

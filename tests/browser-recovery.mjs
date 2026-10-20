import { prepareFixtureUpload } from "./upload-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp } from "../server.mjs";
const { chromium } = await import(
  process.env.ITD_PLAYWRIGHT_MODULE || "playwright"
);
const root = await mkdtemp(join(tmpdir(), "itd-browser-recovery-")),
  password = randomBytes(24).toString("hex");
let app,
  browser,
  now = Date.now();
const PUBLIC = "/api/password-recovery/requests",
  ADMIN = "/api/admin/password-recovery/requests";
const generic =
  "Если такой аккаунт существует, запрос отправлен администратору.";
const screenshots = process.env.ITD_SCREENSHOT_DIR;
if (screenshots) await mkdir(screenshots, { recursive: true });
try {
  app = createApp({
    dataDir: join(root, "data"),
    adminEmail: "admin@example.test",
    adminPassword: password,
    recoveryNow: () => now,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  async function api(path, body, cookie, status = 200) {
    body = await prepareFixtureUpload(
      base,
      path,
      body,
      cookie,
      body ? "POST" : "GET",
    );

    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        "X-ITD-Request": "1",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(r.status, status, path);
    return r;
  }
  const loginResponse = await api("/api/login", {
    email: "admin@example.test",
    password,
  });
  const adminCookie = loginResponse.headers.get("set-cookie").split(";")[0];
  await loginResponse.json();
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 375, height: 812 },
    { width: 430, height: 932 },
  ]) {
    now += 15 * 60 * 1000 + 1;
    const email = `client${viewport.width}@example.test`,
      unknown = `unknown${viewport.width}@example.test`,
      otherEmail = `other${viewport.width}@example.test`;
    for (const candidate of [email, otherEmail])
      await (
        await api(
          "/api/register",
          { name: "Клиент · демонстрация", email: candidate, password },
          undefined,
          201,
        )
      ).json();
    const contexts = [],
      errors = [],
      external = [],
      requestedURLs = [];
    async function pageFor() {
      const c = await browser.newContext({ viewport });
      contexts.push(c);
      await c.route("**/*", (route) => {
        const url = route.request().url();
        requestedURLs.push(url);
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
    async function login(p, who, pass = password) {
      await p.locator("#login-email").fill(who);
      await p.locator("#login-password").fill(pass);
      await p.locator("#login-form button[type=submit]").click();
      await p.locator("#app-view").waitFor({ state: "visible" });
    }
    async function screenshot(p, name) {
      assert.ok(
        await p.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `${name}: no horizontal overflow`,
      );
      if (screenshots)
        await p.screenshot({
          path: join(screenshots, `recovery-${name}-${viewport.width}.png`),
          fullPage: true,
        });
    }
    const publicPage = await pageFor();
    await publicPage.locator("#show-recovery").click();
    await publicPage.locator("#recovery-email").fill(unknown);
    await publicPage
      .locator("#recovery-request-form button[type=submit]")
      .click();
    await publicPage.waitForFunction(
      (text) =>
        document.querySelector("#recovery-request-message").textContent ===
        text,
      generic,
    );
    await publicPage.locator("#recovery-email").fill(email);
    await publicPage
      .locator("#recovery-request-form button[type=submit]")
      .click();
    await publicPage.waitForFunction(
      (text) =>
        document.querySelector("#recovery-request-message").textContent ===
        text,
      generic,
    );
    await screenshot(publicPage, "request");
    const oldOwner = await pageFor();
    await login(oldOwner, email);
    assert.equal(await oldOwner.locator("#tab-recovery").isVisible(), false);
    const admin = await pageFor();
    await login(admin, "admin@example.test");
    await admin.locator("#tab-recovery").click();
    await admin
      .locator("#recovery-list button")
      .filter({ hasText: email })
      .click();
    const approve = () =>
      admin.getByRole("button", {
        name: "Одобрить и создать ссылку",
        exact: true,
      });
    assert.equal(await approve().isDisabled(), true);
    await admin.locator("#recovery-detail input[type=checkbox]").check();
    assert.equal(await approve().isEnabled(), true);
    const approvedResponse = admin.waitForResponse(
      (r) => r.url().endsWith("/approve") && r.request().method() === "POST",
    );
    await approve().click();
    const approved = await (await approvedResponse).json();
    const firstToken = approved.resetPath.split("#")[1];
    assert.match(approved.resetPath, /^\/reset-password\/#[a-f0-9]{64}$/);
    await admin
      .getByRole("button", { name: "Скопировать ссылку", exact: true })
      .waitFor();
    await screenshot(admin, "approved");
    // Browsers that deny clipboard access must offer explicit manual copying.
    await admin.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error("Clipboard denied for test");
          },
        },
      }),
    );
    await admin
      .getByRole("button", { name: "Скопировать ссылку", exact: true })
      .click();
    const manual = admin.getByRole("textbox", {
      name: "Одноразовая ссылка для клиента",
    });
    await manual.waitFor();
    assert.equal(await manual.inputValue(), base + approved.resetPath);
    assert.equal(await manual.getAttribute("readonly"), "");
    await admin
      .getByRole("button", { name: "Я скопировал(а) ссылку", exact: true })
      .click();
    await admin.waitForFunction(() =>
      document
        .querySelector("#recovery-admin-message")
        .textContent.includes("Копирование подтверждено"),
    );
    for (const p of [publicPage, admin]) {
      const storage = await p.evaluate(() =>
        JSON.stringify({
          local: { ...localStorage },
          session: { ...sessionStorage },
        }),
      );
      assert.equal(storage.includes(firstToken), false);
    }
    await admin.reload();
    await admin.locator("#tab-recovery").click();
    await admin
      .locator("#recovery-list button")
      .filter({ hasText: email })
      .click();
    assert.equal(
      await admin
        .getByRole("button", { name: "Скопировать ссылку", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await admin
        .getByRole("textbox", { name: "Одноразовая ссылка для клиента" })
        .count(),
      0,
    );
    await admin.locator("#recovery-detail input[type=checkbox]").check();
    admin.once("dialog", (d) => d.accept());
    const rotatedResponse = admin.waitForResponse(
      (r) => r.url().endsWith("/approve") && r.request().method() === "POST",
    );
    await admin
      .getByRole("button", { name: "Создать новую ссылку", exact: true })
      .click();
    const rotated = await (await rotatedResponse).json();
    assert.notEqual(rotated.resetPath, approved.resetPath);
    await admin
      .getByRole("button", { name: "Скопировать ссылку", exact: true })
      .waitFor();
    await admin.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__testClipboard = text;
          },
        },
      }),
    );
    await admin
      .getByRole("button", { name: "Скопировать ссылку", exact: true })
      .click();
    await admin.waitForFunction(() =>
      document
        .querySelector("#recovery-admin-message")
        .textContent.includes("Копирование подтверждено"),
    );
    assert.equal(
      await admin.evaluate(() => window.__testClipboard),
      base + rotated.resetPath,
    );
    const reset = await pageFor();
    await reset.goto(base + rotated.resetPath);
    await reset.locator("#reset-password-form").waitFor({ state: "visible" });
    assert.equal(new URL(reset.url()).hash, "");
    assert.equal(await reset.locator("input[name=email]").count(), 0);
    const newPassword = randomBytes(24).toString("hex");
    await reset.locator("#reset-password").fill(newPassword);
    await reset.locator("#reset-password-confirm").fill(newPassword + "x");
    await reset.locator("#reset-password-form button").click();
    await reset.waitForFunction(() =>
      document
        .querySelector("#reset-message")
        .textContent.includes("не совпадают"),
    );
    await screenshot(reset, "mismatch");
    await reset.locator("#reset-password-confirm").fill(newPassword);
    await reset.locator("#reset-password-form button").click();
    await reset.locator("#reset-login").waitFor({ state: "visible" });
    await screenshot(reset, "success");
    assert.equal(
      (await reset.context().request.get(base + "/api/me")).status(),
      401,
    );
    assert.equal(
      (await oldOwner.context().request.get(base + "/api/me")).status(),
      401,
    );
    await reset.locator("#reset-login").click();
    await login(reset, email, newPassword);
    assert.equal(await reset.locator("#tab-recovery").isVisible(), false);
    const reused = await pageFor();
    await reused.goto(base + rotated.resetPath);
    await reused.locator("#reset-password").fill(newPassword);
    await reused.locator("#reset-password-confirm").fill(newPassword);
    await reused.locator("#reset-password-form button").click();
    await reused.locator("#reset-help").waitFor({ state: "visible" });
    await reused.locator("#reset-message[role=alert]").waitFor();
    await screenshot(reused, "used-link");
    await admin.locator("#recovery-refresh").click();
    await admin
      .locator("#recovery-list button")
      .filter({ hasText: email })
      .click();
    await admin.waitForFunction(() =>
      document
        .querySelector("#recovery-detail")
        .textContent.includes("Использован"),
    );
    assert.ok(
      (await admin.locator(".recovery-history").innerText()).includes("Пароль"),
    );
    await admin
      .locator("#recovery-list button")
      .filter({ hasText: unknown })
      .click();
    assert.equal(await approve().count(), 0);
    admin.once("dialog", (d) => d.accept());
    await admin
      .getByRole("button", { name: "Отклонить запрос", exact: true })
      .click();
    await admin.waitForFunction(() =>
      document
        .querySelector("#recovery-detail")
        .textContent.includes("Отклонён"),
    );
    await (await api(PUBLIC, { email: otherEmail }, undefined, 202)).json();
    const list = await (await api(ADMIN, undefined, adminCookie)).json();
    const pending = list.requests.find((r) => r.email === otherEmail);
    const expiring = await (
      await api(`${ADMIN}/${pending.id}/approve`, {}, adminCookie)
    ).json();
    now += 20 * 60 * 1000;
    const expired = await pageFor();
    await expired.goto(base + expiring.resetPath);
    await expired.locator("#reset-password").fill(newPassword);
    await expired.locator("#reset-password-confirm").fill(newPassword);
    await expired.locator("#reset-password-form button").click();
    await expired.locator("#reset-help").waitFor({ state: "visible" });
    await expired.locator("#reset-message[role=alert]").waitFor();
    await screenshot(expired, "expired-link");
    const missing = await pageFor();
    await missing.goto(base + "/reset-password/");
    await missing.locator("#reset-help").waitFor({ state: "visible" });
    assert.equal(
      await missing.locator("#reset-password-form").isVisible(),
      false,
    );
    for (const token of [
      firstToken,
      rotated.resetPath.split("#")[1],
      expiring.resetPath.split("#")[1],
    ])
      assert.equal(
        requestedURLs.some((url) => url.includes(token)),
        false,
        "Recovery credential must not appear in request URLs",
      );
    await admin.locator("#logout-button").click();
    await admin.locator("#login-form").waitFor({ state: "visible" });
    assert.equal(await admin.locator(".recovery-link-box input").count(), 0);
    assert.equal(
      (await admin.context().request.get(base + ADMIN)).status(),
      401,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    for (const context of contexts) await context.close();
    console.log(
      `Recovery browser ${viewport.width}px: generic requests, administrator-only approval, manual/copy/rotation, fragment cleanup, mismatch/success/used/expired, revoked sessions, no external requests and mobile layout PASS`,
    );
  }
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

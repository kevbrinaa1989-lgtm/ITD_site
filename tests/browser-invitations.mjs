import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp } from "../server.mjs";
import { openGlobal } from "./browser-navigation.mjs";
const { chromium } = await import(
  process.env.ITD_PLAYWRIGHT_MODULE || "playwright"
);
const root = await mkdtemp(join(tmpdir(), "itd-invite-browser-")),
  password = randomBytes(20).toString("hex");
let app, browser;
try {
  app = createApp({
    dataDir: join(root, "data"),
    adminEmail: "admin@example.test",
    adminPassword: password,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  const errors = [],
    external = [];
  for (const width of [1440, 768, 430, 375]) {
    const contexts = [];
    async function page() {
      const c = await browser.newContext({ viewport: { width, height: 1000 } });
      contexts.push(c);
      await c.route("**/*", (r) => {
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
      await c.addInitScript(() =>
        Object.defineProperty(navigator, "clipboard", {
          value: {
            writeText: async () => {
              throw Error("Denied for manual copy test");
            },
          },
        }),
      );
      const p = await c.newPage();
      p.setDefaultTimeout(12000);
      p.on("pageerror", (e) => errors.push(e.message));
      return p;
    }
    const admin = await page();
    await admin.goto(base + "/cabinet");
    await admin.locator("#login-email").fill("admin@example.test");
    await admin.locator("#login-password").fill(password);
    await admin.locator("#login-form button[type=submit]").click();
    await openGlobal(admin, "clients");
    await admin.locator(".invitations-panel summary").click();
    const email = `invite${width}@example.test`;
    await admin.locator("#invitation-email").fill(email);
    await admin.locator("#invitation-form button[type=submit]").click();
    assert.equal(
      await admin.locator("#invitation-link button").count(),
      0,
      "Identity verification checkbox is mandatory",
    );
    await admin.locator("#invitation-verified").check();
    await admin.locator("#invitation-form button[type=submit]").click();
    await admin.locator("#invitation-link button").click();
    const link = await admin
      .locator("#invitation-link input[readonly]")
      .inputValue();
    assert.match(link, /\/accept-invitation\/#([a-f0-9]{64})$/);
    const recipient = await page();
    await recipient.goto(link);
    assert.equal(new URL(recipient.url()).hash, "");
    assert.equal(
      await recipient
        .locator("#invitation-accept-form input[type=email]")
        .count(),
      0,
    );
    await recipient.locator("#invitation-name").fill("Клиент · демонстрация");
    await recipient.locator("#invitation-password").fill(password);
    await recipient
      .locator("#invitation-password-confirm")
      .fill(password + "x");
    await recipient.locator("#invitation-accept-form button").click();
    await recipient
      .getByText("Пароли не совпадают. Повторите пароль ещё раз.", {
        exact: true,
      })
      .waitFor();
    await recipient.locator("#invitation-password-confirm").fill(password);
    await recipient.locator("#invitation-accept-form button").click();
    await recipient.locator("#invitation-login").waitFor({ state: "visible" });
    assert.equal(
      (await recipient.request.get(base + "/api/me")).status(),
      401,
      "Invitation does not auto login",
    );
    await recipient.locator("#invitation-login").click();
    await recipient.locator("#login-email").fill(email);
    await recipient.locator("#login-password").fill(password);
    await recipient.locator("#login-form button[type=submit]").click();
    await openGlobal(recipient, "client-projects");
    assert.equal(
      await recipient
        .locator("#client-projects-panel [data-project-id]")
        .count(),
      0,
      "Invitation grants no project",
    );
    const reused = await page();
    await reused.goto(link);
    await reused.locator("#invitation-name").fill("Повтор");
    await reused.locator("#invitation-password").fill(password);
    await reused.locator("#invitation-password-confirm").fill(password);
    const rejected = reused.waitForResponse((r) =>
      r.url().endsWith("/api/invitations/accept"),
    );
    await reused.locator("#invitation-accept-form button").click();
    assert.equal((await rejected).status(), 400);
    await admin.locator("#invitation-refresh").click();
    await admin
      .locator("#invitation-list .invitation-card")
      .filter({ hasText: email })
      .getByText(/Использовано/)
      .waitFor();
    assert.equal(
      await recipient.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.equal(
      await admin.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    for (const c of contexts) await c.close();
    console.log(`Invitation browser ${width}px PASS`);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
} finally {
  await browser?.close();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}

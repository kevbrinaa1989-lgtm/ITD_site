import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp } from "../server.mjs";
import { fixtures } from "./preview-fixtures.mjs";
const { chromium } = await import(
  process.env.ITD_PLAYWRIGHT_MODULE || "playwright"
);
const dataDir = await mkdtemp(join(tmpdir(), "itd-browser-preview-"));
const password = randomBytes(24).toString("hex");
let app, browser;
function pdfTwoPages() {
  const commands = [
    "1 0 0 rg 20 20 160 160 re f",
    "0 0 1 rg 20 20 160 160 re f",
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
  ];
  for (let i = 0; i < 2; i++)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 240] /Contents ${4 + i * 2} 0 R >>`,
      `<< /Length ${commands[i].length} >>\nstream\n${commands[i]}\nendstream`,
    );
  let text = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => {
    offsets.push(Buffer.byteLength(text));
    text += `${i + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const n of offsets.slice(1))
    text += `${String(n).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(
    text +
      `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  );
}
try {
  app = createApp({
    dataDir,
    adminEmail: "admin@example.test",
    adminPassword: password,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, body, cookie) {
    const r = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: {
        Origin: base,
        "X-ITD-Request": "1",
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.ok(r.ok, `${path}: ${r.status}`);
    return r;
  }
  const adminResponse = await request("/api/login", {
    email: "admin@example.test",
    password,
  });
  const adminCookie = adminResponse.headers.get("set-cookie").split(";")[0];
  await adminResponse.json();
  const { user: owner } = await (
    await request("/api/register", {
      name: "Тестовый клиент",
      email: "owner@example.test",
      password,
    })
  ).json();
  await (
    await request("/api/register", {
      name: "Другой клиент",
      email: "other@example.test",
      password,
    })
  ).json();
  const project = await (
    await request(
      "/api/projects",
      { title: "Квартира · тест просмотра", clientId: owner.id },
      adminCookie,
    )
  ).json();
  const stage = await (
    await request(
      `/api/projects/${project.id}/stages`,
      {
        title: "Визуализации",
        status: "in_progress",
        description: "Материалы для проверки",
      },
      adminCookie,
    )
  ).json();
  const files = [];
  for (const [name, contentType, bytes] of [
    ...fixtures.filter((f) => f[1] !== "application/pdf"),
    ["План.pdf", "application/pdf", pdfTwoPages()],
    ["Смета.txt", "text/plain", Buffer.from("download only")],
  ]) {
    const file = await (
      await request(
        `/api/projects/${project.id}/files`,
        {
          name,
          contentType,
          category: contentType.startsWith("image/") ? "result" : "document",
          stageId: stage.id,
          data: bytes.toString("base64"),
        },
        adminCookie,
      )
    ).json();
    files.push({ ...file, bytes });
  }
  browser = await chromium.launch({
    executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 },
    { width: 320, height: 700 },
  ]) {
    const context = await browser.newContext({
      viewport,
      hasTouch: viewport.width < 500,
      acceptDownloads: true,
    });
    const page = await context.newPage(),
      errors = [],
      external = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (/^https?:/.test(r.url()) && !r.url().startsWith(base + "/"))
        external.push(r.url());
    });
    await page.goto(base + "/cabinet");
    await page
      .locator("#login-email")
      .fill(
        viewport.width === 1440 ? "admin@example.test" : "owner@example.test",
      );
    await page.locator("#login-password").fill(password);
    await page.locator("#login-form button[type=submit]").click();
    await page.locator("#tab-results").click();
    for (const card of await page.locator(".gallery-card").all()) {
      await card.scrollIntoViewIfNeeded();
      await card.locator("img").evaluate((img) =>
        img.complete && img.naturalWidth
          ? true
          : new Promise((resolve, reject) => {
              img.addEventListener("load", resolve, { once: true });
              img.addEventListener(
                "error",
                () => reject(Error("Thumbnail did not decode")),
                { once: true },
              );
            }),
      );
    }
    assert.equal(await page.locator(".gallery-card").count(), 4);
    for (const file of files.filter((f) =>
      f.contentType.startsWith("image/"),
    )) {
      const card = page.locator(".gallery-open").filter({ hasText: file.name });
      await card.click();
      await page.waitForFunction(
        () => document.querySelector(".viewer-content img")?.naturalWidth > 0,
      );
      await page
        .locator(".viewer-controls button")
        .filter({ hasText: "Увеличить" })
        .click();
      assert.match(await page.locator(".viewer-controls").innerText(), /125%/);
      const downloadPromise = page.waitForEvent("download");
      await page.locator(".viewer-download").click();
      const download = await downloadPromise;
      assert.deepEqual(await readFile(await download.path()), file.bytes);
      await page.getByRole("button", { name: "Закрыть", exact: true }).click();
      assert.equal(await page.locator("dialog[open]").count(), 0);
    }
    await page.locator(".gallery-open").first().click();
    await page.waitForFunction(() =>
      document
        .querySelector(".viewer-status")
        .textContent.includes("Изображение 1"),
    );
    await page
      .getByRole("button", { name: "Следующий →", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector(".viewer-status")
        .textContent.includes("Изображение 2"),
    );
    await page
      .getByRole("button", { name: "← Предыдущий", exact: true })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector(".viewer-status")
        .textContent.includes("Изображение 1"),
    );
    await page.evaluate(() => {
      document.querySelector(".viewer-toolbar button").click();
      document.querySelector(".gallery-open").click();
    });
    await page.waitForFunction(
      () => document.querySelector(".viewer-content img")?.naturalWidth > 0,
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("dialog[open]").count(), 0);
    await page.locator("#tab-documents").click();
    assert.equal(await page.locator("#document-list .file-preview").count(), 1);
    await page.locator("#document-list .file-preview").click();
    await page.waitForFunction(
      () =>
        document.querySelector(".viewer-status").textContent ===
        "Страница 1 из 2",
      {},
      { timeout: 15000 },
    );
    const pixel = () =>
      page
        .locator(".viewer-content canvas")
        .evaluate((c) =>
          Array.from(
            c.getContext("2d").getImageData(c.width / 2, c.height / 2, 1, 1)
              .data,
          ),
        );
    assert.deepEqual(await pixel(), [255, 0, 0, 255]);
    await page
      .getByRole("button", { name: "Следующий →", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".viewer-status").textContent ===
        "Страница 2 из 2",
    );
    assert.deepEqual(await pixel(), [0, 0, 255, 255]);
    await page.getByRole("button", { name: "Увеличить", exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector(".viewer-controls").textContent.includes("125%"),
    );
    const pdfFile = files.find((f) => f.contentType === "application/pdf");
    const downloadPromise = page.waitForEvent("download");
    await page.locator(".viewer-download").click();
    const download = await downloadPromise;
    assert.deepEqual(await readFile(await download.path()), pdfFile.bytes);
    assert.ok(
      await page
        .locator("dialog")
        .evaluate((d) => d.getBoundingClientRect().right <= innerWidth + 1),
    );
    const screenshot = process.env.ITD_SCREENSHOT_DIR;
    if (screenshot)
      await page.screenshot({
        path: join(screenshot, `pdf-${viewport.width}.png`),
      });
    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await page.locator("#logout-button").click();
    await page.locator("#login-form").waitFor({ state: "visible" });
    assert.equal(
      await page.locator(".viewer-content img,.viewer-content canvas").count(),
      0,
    );
    assert.equal(
      (
        await context.request.get(base + `/api/files/${pdfFile.id}/preview`)
      ).status(),
      401,
    );
    await page.locator("#login-email").fill("other@example.test");
    await page.locator("#login-password").fill(password);
    await page.locator("#login-form button[type=submit]").click();
    await page.locator("#empty-state").waitFor({ state: "visible" });
    assert.equal(
      (
        await context.request.get(base + `/api/files/${pdfFile.id}/preview`)
      ).status(),
      403,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(
      `Browser ${viewport.width}px: gallery, image formats, navigation, zoom, PDF pixels/pages, original downloads, logout/foreign access and no external requests PASS`,
    );
    await context.close();
  }
} finally {
  await browser?.close();
  await app?.close();
  await rm(dataDir, { recursive: true, force: true });
}

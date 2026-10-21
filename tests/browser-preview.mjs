import { openProject, openGlobal } from "./browser-navigation.mjs";
import { prepareFixtureUpload } from "./upload-fixture.mjs";
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
  browser = await chromium.launch({
    executablePath: process.env.ITD_CHROMIUM || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  const fixturePage = await browser.newPage();
  const generatedImages = await fixturePage.evaluate(() => {
    const definitions = [
      ["short.jpg", "image/jpeg", 1200, 800],
      [
        "Планировка квартиры с подробными комментариями и согласованными размерами "
          .repeat(2)
          .slice(0, 165) + ".png",
        "image/png",
        800,
        2400,
      ],
      [
        "ВизуализацияГостинойБезПробелов".repeat(5).slice(0, 165) + ".webp",
        "image/webp",
        3000,
        600,
      ],
      ["large.jpg", "image/jpeg", 4000, 3000],
    ];
    return definitions.map(([name, type, width, height]) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ba9973";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#34473f";
      ctx.fillRect(width / 4, height / 4, width / 2, height / 2);
      return [name, type, canvas.toDataURL(type, 0.85).split(",")[1]];
    });
  });
  await fixturePage.close();
  const extraFixtures = generatedImages.map(([name, type, data]) => [
    name,
    type,
    Buffer.from(data, "base64"),
  ]);
  app = createApp({
    dataDir,
    adminEmail: "admin@example.test",
    adminPassword: password,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, body, cookie) {
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
    ...extraFixtures,
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

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
    { width: 375, height: 812 },
    { width: 430, height: 932 },
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
    await openProject(page, "Квартира · тест просмотра", {
      client: viewport.width !== 1440,
    });
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
    assert.equal(await page.locator(".gallery-card").count(), 8);
    const cardGeometry = await page
      .locator(".gallery-card")
      .evaluateAll((cards) =>
        cards.map((card) => {
          const caption = card.querySelector(".gallery-caption"),
            style = caption && getComputedStyle(caption);
          return {
            height: card.getBoundingClientRect().height,
            name: card.querySelector("img").alt,
            caption: caption?.textContent,
            title: caption?.title,
            nowrap: style?.whiteSpace,
            overflow: style?.overflow,
            ellipsis: style?.textOverflow,
            clipped: caption
              ? caption.scrollWidth > caption.clientWidth
              : false,
          };
        }),
      );
    assert.ok(
      Math.max(...cardGeometry.map((c) => c.height)) -
        Math.min(...cardGeometry.map((c) => c.height)) <=
        1,
      "All gallery cards have equal heights",
    );
    for (const card of cardGeometry) {
      assert.equal(card.caption, card.name);
      assert.equal(card.title, card.name);
      assert.equal(card.nowrap, "nowrap");
      assert.equal(card.overflow, "hidden");
      assert.equal(card.ellipsis, "ellipsis");
    }
    for (const [name] of extraFixtures.filter(([name]) => name.length > 50))
      assert.ok(
        cardGeometry.find((c) => c.name === name).clipped,
        "Long captions are visually truncated",
      );
    const documentToken = await page.evaluate(
      () => (window.__galleryTestToken = crypto.randomUUID()),
    );
    let documentNavigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) documentNavigations++;
    });
    async function readyImage() {
      await page.waitForFunction(
        () =>
          document.querySelector(".viewer-content img")?.naturalWidth > 0 &&
          document
            .querySelector(".viewer-status")
            ?.textContent.startsWith("Изображение"),
      );
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      assert.equal(await page.locator("dialog[open]").count(), 1);
    }
    async function controlsOnscreen() {
      const invalid = await page
        .locator(
          ".viewer-toolbar button,.viewer-controls button,.viewer-controls a",
        )
        .evaluateAll((elements) =>
          elements
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return (
                r.width > 0 &&
                (r.left < -1 ||
                  r.top < -1 ||
                  r.right > innerWidth + 1 ||
                  r.bottom > innerHeight + 1)
              );
            })
            .map((el) => el.textContent),
        );
      assert.deepEqual(invalid, [], "Viewer controls remain onscreen");
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        "Viewer does not overflow the page horizontally",
      );
    }
    async function initialFit() {
      await readyImage();
      const fit = await page.locator(".viewer-content img").evaluate((img) => {
        const viewport = document.querySelector(".viewer-viewport"),
          box = viewport.getBoundingClientRect(),
          r = img.getBoundingClientRect(),
          style = getComputedStyle(viewport);
        const padding = {
          left: parseFloat(style.paddingLeft),
          right: parseFloat(style.paddingRight),
          top: parseFloat(style.paddingTop),
          bottom: parseFloat(style.paddingBottom),
        };
        return {
          width: r.width,
          height: r.height,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          availableWidth: viewport.clientWidth - padding.left - padding.right,
          availableHeight: viewport.clientHeight - padding.top - padding.bottom,
          inside:
            r.left >= box.left + padding.left - 2 &&
            r.right <= box.right - padding.right + 2 &&
            r.top >= box.top + padding.top - 2 &&
            r.bottom <= box.bottom - padding.bottom + 2,
        };
      });
      assert.ok(
        fit.inside,
        `Initial fit stays within padded viewport ${JSON.stringify(fit)}`,
      );
      const scale = Math.min(
        fit.availableWidth / fit.naturalWidth,
        fit.availableHeight / fit.naturalHeight,
        1,
      );
      assert.ok(
        Math.abs(fit.width - fit.naturalWidth * scale) <= 3,
        `Fit width uses both dimensions ${JSON.stringify(fit)}`,
      );
      assert.ok(
        Math.abs(fit.height - fit.naturalHeight * scale) <= 3,
        `Fit height uses both dimensions ${JSON.stringify(fit)}`,
      );
      assert.ok(
        Math.abs(
          fit.width / fit.height - fit.naturalWidth / fit.naturalHeight,
        ) <= 0.02,
        "Fit preserves aspect ratio",
      );
      await controlsOnscreen();
    }
    for (const file of files.filter((f) =>
      f.contentType.startsWith("image/"),
    )) {
      const card = page.locator(".gallery-open").filter({ hasText: file.name });
      await card.click();
      await initialFit();
      if (
        process.env.ITD_SCREENSHOT_DIR &&
        [375, 430].includes(viewport.width) &&
        file.name === extraFixtures[1][0]
      )
        await page.screenshot({
          path: join(
            process.env.ITD_SCREENSHOT_DIR,
            `portrait-${viewport.width}.png`,
          ),
        });
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
    // Each image retains its own zoom while navigating; a new modal session resets it.
    const firstLarge = page
      .locator(".gallery-open")
      .filter({ hasText: "short.jpg" });
    await firstLarge.scrollIntoViewIfNeeded();
    const galleryScroll = await page.evaluate(() => ({
      x: scrollX,
      y: scrollY,
    }));
    await firstLarge.click();
    await initialFit();
    const increase = page.getByRole("button", {
        name: "Увеличить",
        exact: true,
      }),
      decrease = page.getByRole("button", { name: "Уменьшить", exact: true });
    const imageSize = () =>
      page.locator(".viewer-content img").evaluate((img) => {
        const r = img.getBoundingClientRect();
        return { width: r.width, height: r.height };
      });
    const sameSize = (actual, expected) =>
      assert.ok(
        Math.abs(actual.width - expected.width) <= 1 &&
          Math.abs(actual.height - expected.height) <= 1,
        "Restored image zoom matches actual pixel geometry",
      );
    await increase.click();
    await increase.click();
    const first150 = await imageSize();
    assert.match(await page.locator(".viewer-controls").innerText(), /150%/);
    await page
      .getByRole("button", { name: "Следующий →", exact: true })
      .click();
    await readyImage();
    assert.match(await page.locator(".viewer-controls").innerText(), /100%/);
    await decrease.click();
    assert.match(await page.locator(".viewer-controls").innerText(), /75%/);
    const second75 = await imageSize();
    await page
      .getByRole("button", { name: "← Предыдущий", exact: true })
      .click();
    await readyImage();
    assert.match(await page.locator(".viewer-controls").innerText(), /150%/);
    sameSize(await imageSize(), first150);
    await page
      .getByRole("button", { name: "Следующий →", exact: true })
      .click();
    await readyImage();
    assert.match(await page.locator(".viewer-controls").innerText(), /75%/);
    sameSize(await imageSize(), second75);
    await controlsOnscreen();
    assert.equal(
      await page.evaluate(() => window.__galleryTestToken),
      documentToken,
    );
    assert.equal(
      documentNavigations,
      0,
      "Zoom/navigation do not reload the page",
    );
    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
    const restoredScroll = await page.evaluate(() => ({
      x: scrollX,
      y: scrollY,
    }));
    assert.ok(
      Math.abs(restoredScroll.y - galleryScroll.y) <= 1 &&
        Math.abs(restoredScroll.x - galleryScroll.x) <= 1,
      "Closing preserves gallery page scroll",
    );
    await firstLarge.click();
    await initialFit();
    assert.match(await page.locator(".viewer-controls").innerText(), /100%/);
    await page
      .getByRole("button", { name: "Следующий →", exact: true })
      .click();
    await initialFit();
    assert.match(await page.locator(".viewer-controls").innerText(), /100%/);
    if ([375, 430].includes(viewport.width)) {
      async function reachableEdges() {
        const edges = await page.locator(".viewer-viewport").evaluate((v) => {
          v.scrollLeft = 0;
          v.scrollTop = 0;
          const first = v.querySelector("img").getBoundingClientRect(),
            box = v.getBoundingClientRect();
          const start = first.left >= box.left - 2 && first.top >= box.top - 2;
          v.scrollLeft = v.scrollWidth;
          v.scrollTop = v.scrollHeight;
          const last = v.querySelector("img").getBoundingClientRect();
          return {
            start,
            end: last.right <= box.right + 2 && last.bottom <= box.bottom + 2,
          };
        });
        assert.ok(
          edges.start && edges.end,
          "Every enlarged image edge is reachable by scrolling",
        );
      }
      for (const target of [extraFixtures[1][0], extraFixtures[2][0]]) {
        if (
          !(await page.locator(".viewer-toolbar h2").innerText()).includes(
            target,
          )
        ) {
          await page
            .getByRole("button", { name: "Следующий →", exact: true })
            .click();
          await initialFit();
        }
        await increase.click();
        await increase.click();
        assert.match(
          await page.locator(".viewer-controls").innerText(),
          /150%/,
        );
        await reachableEdges();
        await page.setViewportSize({
          width: viewport.width === 375 ? 430 : 375,
          height: viewport.height,
        });
        await page.waitForTimeout(250);
        assert.match(
          await page.locator(".viewer-controls").innerText(),
          /150%/,
        );
        await controlsOnscreen();
        await reachableEdges();
        await page.getByRole("button", { name: /Сбросить масштаб/ }).click();
        await initialFit();
        await page.setViewportSize(viewport);
        await page.waitForTimeout(250);
        await initialFit();
      }
    }
    await page.getByRole("button", { name: "Закрыть", exact: true }).click();
    const imageScreenshot = process.env.ITD_SCREENSHOT_DIR;
    if (imageScreenshot)
      await page.screenshot({
        path: join(imageScreenshot, `gallery-${viewport.width}.png`),
      });
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
    // ResizeObserver may replace the canvas between two separate browser calls.
    // Check the page label and rendered pixels together in a single browser turn.
    const waitForPdfColor = async (pageNumber, expected) => {
      const result = await page.waitForFunction(
        ({ pageNumber, expected }) => {
          const canvas = document.querySelector(".viewer-content canvas");
          if (
            !canvas ||
            document.querySelector(".viewer-status").textContent !==
              `Страница ${pageNumber} из 2`
          )
            return false;
          const pixel = Array.from(
            canvas
              .getContext("2d")
              .getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data,
          );
          return expected.every((channel, index) => channel === pixel[index])
            ? pixel
            : false;
        },
        { pageNumber, expected },
        { timeout: 15000 },
      );
      assert.deepEqual(await result.jsonValue(), expected);
      await result.dispose();
    };
    await waitForPdfColor(1, [255, 0, 0, 255]);
    await page
      .getByRole("button", { name: "Следующий →", exact: true })
      .click();
    await waitForPdfColor(2, [0, 0, 255, 255]);
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
        .locator("dialog.file-viewer")
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
    await openGlobal(page, "client-projects");
    assert.equal(
      await page
        .locator("#client-projects-panel button[data-project-id]")
        .count(),
      0,
    );
    assert.equal(
      (
        await context.request.get(base + `/api/files/${pdfFile.id}/preview`)
      ).status(),
      403,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(
      `Browser ${viewport.width}px: equal gallery cards/captions, image fit, independent zoom/reset/scroll, image formats, navigation, PDF pixels/pages, original downloads, logout/foreign access and no external requests PASS`,
    );
    await context.close();
  }
} finally {
  await browser?.close();
  await app?.close();
  await rm(dataDir, { recursive: true, force: true });
}

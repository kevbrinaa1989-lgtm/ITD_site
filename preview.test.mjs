import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createApp } from "./server.mjs";

import { fixtures, jpeg } from "./tests/preview-fixtures.mjs";

test("file previews preserve authorization, security headers and original downloadable data", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "itd-preview-test-")),
    password = randomBytes(24).toString("hex");
  let app, base;
  const options = {
    dataDir,
    adminEmail: "admin@example.test",
    adminPassword: password,
  };
  async function start() {
    app = createApp(options);
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function request(path, { cookie, method = "GET", body } = {}) {
    return fetch(base + path, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method === "GET"
          ? {}
          : {
              Origin: base,
              "Content-Type": "application/json",
              "X-ITD-Request": "1",
            }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function json(path, config, status = 200) {
    const response = await request(path, config),
      data = await response.json();
    assert.equal(response.status, status, `${path}: ${JSON.stringify(data)}`);
    return data;
  }
  async function login(email) {
    const response = await request("/api/login", {
      method: "POST",
      body: { email, password },
    });
    assert.equal(response.status, 200);
    await response.json();
    return response.headers.get("set-cookie").split(";")[0];
  }
  async function upload(name, contentType, bytes, category = "result") {
    return json(
      `/api/projects/${project.id}/files`,
      {
        cookie: admin,
        method: "POST",
        body: { name, contentType, data: bytes.toString("base64"), category },
      },
      201,
    );
  }
  let project, admin;
  const uploaded = [];
  try {
    await start();
    admin = await login("admin@example.test");
    const users = [];
    for (const email of ["owner@example.test", "other@example.test"]) {
      const { user } = await json(
        "/api/register",
        { method: "POST", body: { email, password, name: email } },
        201,
      );
      users.push({ ...user, cookie: await login(email) });
    }
    const [owner, other] = users;
    project = await json(
      "/api/projects",
      {
        cookie: admin,
        method: "POST",
        body: { title: "Private preview project", clientId: owner.id },
      },
      201,
    );
    for (const [name, type, bytes] of fixtures)
      uploaded.push({
        ...(await upload(
          name,
          type,
          bytes,
          name.endsWith(".pdf") ? "document" : "result",
        )),
        bytes,
      });
    const databaseBefore = await readFile(join(dataDir, "itd.sqlite"));
    const filesBefore = await readdir(join(dataDir, "files"));
    await t.test(
      "administrator and project owner preview valid PNG JPEG WebP and PDF bytes",
      async () => {
        for (const file of uploaded)
          for (const cookie of [admin, owner.cookie]) {
            const response = await request(`/api/files/${file.id}/preview`, {
              cookie,
            });
            assert.equal(response.status, 200, file.name);
            assert.equal(
              response.headers.get("content-type"),
              file.contentType,
            );
            assert.match(
              response.headers.get("content-disposition"),
              /^inline(?:;|$)/i,
            );
            assert.equal(
              response.headers.get("x-content-type-options"),
              "nosniff",
            );
            assert.equal(response.headers.get("cache-control"), "no-store");
            assert.equal(
              response.headers.get("cross-origin-resource-policy"),
              "same-origin",
            );
            const csp = response.headers.get("content-security-policy");
            assert.match(csp, /default-src\s+'none'/);
            assert.match(csp, /(?:^|;)\s*sandbox(?:;|$)/);
            assert.deepEqual(
              Buffer.from(await response.arrayBuffer()),
              file.bytes,
            );
          }
      },
    );
    assert.deepEqual(
      await readFile(join(dataDir, "itd.sqlite")),
      databaseBefore,
    );
    assert.deepEqual(await readdir(join(dataDir, "files")), filesBefore);
    await t.test(
      "direct preview URLs reject anonymous users and clients from a different project",
      async () => {
        for (const file of uploaded) {
          await json(`/api/files/${file.id}/preview`, {}, 401);
          await json(
            `/api/files/${file.id}/preview`,
            { cookie: other.cookie },
            403,
          );
        }
      },
    );
    const unsupported = await upload(
      "notes.txt",
      "text/plain",
      Buffer.from("Plain text remains a download"),
    );
    const corrupt = [];
    for (const [name, type] of fixtures) {
      const bytes = Buffer.from("<html><script>alert(1)</script></html>");
      corrupt.push({
        ...(await upload(`invalid-${name}`, type, bytes)),
        bytes,
      });
    }
    const mismatch = await upload("mismatched.png", "image/png", jpeg);
    corrupt.push({ ...mismatch, bytes: jpeg });
    await t.test(
      "unsupported formats and corrupt or mismatched signatures return415 without damaging downloads",
      async () => {
        for (const file of [unsupported, ...corrupt]) {
          for (const cookie of [admin, owner.cookie])
            await json(`/api/files/${file.id}/preview`, { cookie }, 415);
          await json(
            `/api/files/${file.id}/preview`,
            { cookie: other.cookie },
            403,
          );
          await json(`/api/files/${file.id}/preview`, {}, 401);
          const response = await request(`/api/files/${file.id}/download`, {
            cookie: owner.cookie,
          });
          assert.equal(response.status, 200);
          assert.match(
            response.headers.get("content-disposition"),
            /^attachment;/,
          );
          assert.deepEqual(
            Buffer.from(await response.arrayBuffer()),
            file.bytes || Buffer.from("Plain text remains a download"),
          );
        }
      },
    );
    await t.test(
      "preview access leaves original downloads byte-for-byte unchanged across restart",
      async () => {
        await app.close();
        app = null;
        await start();
        const cookie = await login(owner.email);
        const { projects } = await json("/api/projects", { cookie });
        assert.equal(
          projects[0].files.length,
          uploaded.length + corrupt.length + 1,
        );
        for (const file of uploaded) {
          for (const suffix of ["preview", "download"]) {
            const response = await request(`/api/files/${file.id}/${suffix}`, {
              cookie,
            });
            assert.equal(response.status, 200);
            assert.deepEqual(
              Buffer.from(await response.arrayBuffer()),
              file.bytes,
            );
          }
        }
      },
    );
    await t.test(
      "local PDF.js files match pinned hashes and only allowlisted assets are served",
      async () => {
        const manifest = JSON.parse(
          await readFile(
            new URL("./vendor/pdfjs/assets.json", import.meta.url),
            "utf8",
          ),
        );
        assert.ok(Object.keys(manifest).length > 2);
        for (const [name, hash] of Object.entries(manifest)) {
          const data = await readFile(
            new URL(`./vendor/pdfjs/${name}`, import.meta.url),
          );
          assert.equal(
            createHash("sha256").update(data).digest("hex"),
            hash,
            name,
          );
        }
        for (const name of ["pdf.mjs", "pdf.worker.mjs"]) {
          const response = await request(`/vendor/pdfjs/${name}`);
          assert.equal(response.status, 200);
          assert.match(
            response.headers.get("content-type"),
            /(?:application|text)\/javascript/,
          );
          const bytes = Buffer.from(await response.arrayBuffer());
          assert.equal(
            createHash("sha256").update(bytes).digest("hex"),
            manifest[name],
          );
        }
        for (const name of [
          "pdf.mjs.map",
          "pdf.worker.mjs.map",
          "README.md",
          "assets.json",
          "package.json",
        ]) {
          const response = await request(`/vendor/pdfjs/${name}`);
          assert.ok([403, 404].includes(response.status), name);
          await response.arrayBuffer();
        }
      },
    );
    await t.test(
      "storage paths and application source files remain inaccessible over HTTP",
      async () => {
        const [stored] = await readdir(join(dataDir, "files"));
        for (const path of [
          `/files/${stored}`,
          `/.itd-data/files/${stored}`,
          "/preview.test.mjs",
          "/server.mjs",
          "/itd.sqlite",
          "/vendor/pdfjs/../server.mjs",
          "/vendor/pdfjs/package.json",
        ]) {
          const response = await request(path, { cookie: admin });
          assert.ok(
            [403, 404].includes(response.status),
            `${path}: ${response.status}`,
          );
          await response.arrayBuffer();
        }
      },
    );
  } finally {
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

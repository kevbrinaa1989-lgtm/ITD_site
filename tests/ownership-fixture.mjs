import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server.mjs";
import { prepareFixtureUpload } from "./upload-fixture.mjs";
export async function ownershipFixture() {
  const root = await mkdtemp(join(tmpdir(), "itd-ownership-")),
    dataDir = join(root, "data"),
    password = randomBytes(24).toString("hex");
  let app, base;
  async function start() {
    app = createApp({
      dataDir,
      adminEmail: "admin@example.test",
      adminPassword: password,
    });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  await start();
  async function request(path, body, cookie, method = body ? "POST" : "GET") {
    body = await prepareFixtureUpload(base, path, body, cookie, method);
    return fetch(base + path, {
      method,
      headers: {
        Origin: base,
        "X-ITD-Request": "1",
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async function api(path, body, cookie, method, status = 200) {
    const r = await request(path, body, cookie, method),
      data = await r.json();
    assert.equal(
      r.status,
      status,
      `${method || "GET"} ${path}: ${JSON.stringify(data)}`,
    );
    return data;
  }
  async function login(email) {
    const r = await request("/api/login", { email, password });
    assert.equal(r.status, 200);
    return r.headers.get("set-cookie").split(";")[0];
  }
  try {
    const admin = await login("admin@example.test"),
      clients = [];
    for (const [i, name] of ["Анна", "Борис"].entries()) {
      const email = `client${i}@example.test`;
      const { user } = await api(
        "/api/register",
        { name, email, password },
        null,
        "POST",
        201,
      );
      clients.push({ ...user, cookie: await login(email) });
    }
    const projects = [];
    for (const [i, title] of ["Балтика", "Нева"].entries()) {
      const created = await api(
        "/api/projects",
        {
          title,
          clientId: clients[i].id,
          stageTemplates: [
            "measurements",
            "planning",
            "concept",
            "visualizations",
            "technical_description",
            "specification",
            "supervision",
          ],
        },
        admin,
        "POST",
        201,
      );
      projects.push(
        (await api(`/api/admin/projects/${created.id}`, null, admin)).project,
      );
    }

    function rows(sql, ...args) {
      const db = new DatabaseSync(join(dataDir, "itd.sqlite"), {
        readOnly: true,
      });
      try {
        return db
          .prepare(sql)
          .all(...args)
          .map((r) => ({ ...r }));
      } finally {
        db.close();
      }
    }
    return {
      root,
      dataDir,
      password,
      admin,
      clients,
      projects,
      api,
      request,
      login,
      rows,
      get base() {
        return base;
      },
      async restart() {
        await app.close();
        await start();
      },
      async close() {
        await app.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await app.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

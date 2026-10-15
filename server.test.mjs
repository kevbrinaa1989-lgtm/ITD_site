import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp } from "./server.mjs";

test("client and administrator workflows preserve authorization and data", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "itd-test-"));
  const password = randomBytes(24).toString("hex");
  const options = {
    dataDir,
    adminEmail: "admin@example.test",
    adminPassword: password,
  };
  let app, base;
  async function start() {
    app = await createApp(options);
    await new Promise((resolve, reject) => {
      app.server.once("error", reject);
      app.server.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function request(
    path,
    { method = "GET", cookie, body, csrf = true, origin = base } = {},
  ) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (method !== "GET") {
      headers["Content-Type"] = "application/json";
      if (csrf) headers["X-ITD-Request"] = "1";
      if (origin) headers.Origin = origin;
    }
    return fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
  }
  async function json(path, config, status = 200) {
    const res = await request(path, config);
    const result = await res.json();
    assert.equal(
      res.status,
      status,
      `${config?.method || "GET"} ${path}: ${JSON.stringify(result)}`,
    );
    return result;
  }
  async function login(email) {
    const res = await request("/api/login", {
      method: "POST",
      body: { email, password },
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    return cookie.split(";")[0];
  }
  try {
    await start();
    await t.test("anonymous users and CSRF requests are rejected", async () => {
      await json("/api/projects", {}, 401);
      await json("/api/me", {}, 401);
      await json(
        "/api/register",
        { method: "POST", csrf: false, body: {} },
        403,
      );
      await json(
        "/api/register",
        { method: "POST", origin: "https://evil.example", body: {} },
        403,
      );
      await json("/api/login", { method: "POST", origin: null, body: {} }, 403);
      await json("/api/login", { method: "POST", body: {} }, 400);
    });
    const clients = [];
    await t.test(
      "registration cannot grant administrator privileges",
      async () => {
        for (let i = 1; i <= 2; i++) {
          const email = `client${i}@example.test`;
          await json(
            "/api/register",
            {
              method: "POST",
              body: { name: `Client ${i}`, email, password, role: "admin" },
            },
            201,
          );
          const cookie = await login(email);
          const { user } = await json("/api/me", { cookie });
          assert.equal(user.role, "client");
          assert.equal(user.password, undefined);
          clients.push({ ...user, cookie });
        }
        await json(
          "/api/register",
          {
            method: "POST",
            body: { name: "Invalid", email: "invalid", password },
          },
          400,
        );
        await json(
          "/api/register",
          {
            method: "POST",
            body: {
              name: "Invalid",
              email: "short@example.test",
              password: "123",
            },
          },
          400,
        );
      },
    );
    const admin = await login(options.adminEmail);
    let project1, project2, stage, file;
    await t.test(
      "administrator creates projects, stages and files",
      async () => {
        const { clients: listed } = await json("/api/clients", {
          cookie: admin,
        });
        assert.ok(listed.some((u) => u.id === clients[0].id));
        assert.ok(listed.every((u) => !("password" in u)));
        project1 = (
          await json(
            "/api/projects",
            {
              method: "POST",
              cookie: admin,
              body: { title: "First project", clientId: clients[0].id },
            },
            201,
          )
        ).id;
        project2 = (
          await json(
            "/api/projects",
            {
              method: "POST",
              cookie: admin,
              body: { title: "Second project", clientId: clients[1].id },
            },
            201,
          )
        ).id;
        assert.ok(project1 && project2);
        stage = await json(
          `/api/projects/${project1}/stages`,
          {
            method: "POST",
            cookie: admin,
            body: {
              title: "Design",
              status: "in_progress",
              description: "First draft",
            },
          },
          201,
        );
        await json(`/api/stages/${stage.id}`, {
          method: "PATCH",
          cookie: admin,
          body: { status: "completed" },
        });
        file = await json(
          `/api/projects/${project1}/files`,
          {
            method: "POST",
            cookie: admin,
            body: {
              name: "result.txt",
              contentType: "text/plain",
              data: Buffer.from("private result").toString("base64"),
              category: "result",
              stageId: stage.id,
            },
          },
          201,
        );
      },
    );
    await t.test(
      "clients see their own project and cannot mutate administrator data",
      async () => {
        const own = await json("/api/projects", { cookie: clients[0].cookie });
        assert.deepEqual(
          own.projects.map((p) => p.id),
          [project1],
        );
        assert.equal(own.projects[0].stages[0].status, "completed");
        const other = await json("/api/projects", {
          cookie: clients[1].cookie,
        });
        assert.deepEqual(
          other.projects.map((p) => p.id),
          [project2],
        );
        await json("/api/clients", { cookie: clients[0].cookie }, 403);
        await json(
          "/api/projects",
          {
            method: "POST",
            cookie: clients[0].cookie,
            body: { title: "Escalation", clientId: clients[0].id },
          },
          403,
        );
        await json(
          `/api/stages/${stage.id}`,
          {
            method: "PATCH",
            cookie: clients[0].cookie,
            body: { status: "changed" },
          },
          403,
        );
        await json(
          `/api/projects/${project2}/stages`,
          {
            method: "POST",
            cookie: clients[0].cookie,
            body: { title: "Attack", status: "new" },
          },
          403,
        );
        await json(
          `/api/files/${file.id}`,
          { method: "DELETE", cookie: clients[0].cookie, body: {} },
          403,
        );
        const download = await request(`/api/files/${file.id}/download`, {
          cookie: clients[0].cookie,
        });
        assert.equal(download.status, 200);
        assert.equal(await download.text(), "private result");
        await json(
          `/api/files/${file.id}/download`,
          { cookie: clients[1].cookie },
          403,
        );
        await json(`/api/files/${file.id}/download`, {}, 401);
      },
    );
    await t.test("invalid references and CSRF do not change data", async () => {
      await json(
        "/api/projects",
        {
          method: "POST",
          cookie: admin,
          body: { title: "", clientId: clients[0].id },
        },
        400,
      );
      await json(
        "/api/projects",
        {
          method: "POST",
          cookie: admin,
          body: { title: "Unknown", clientId: 999999 },
        },
        400,
      );
      await json(
        `/api/projects/${project2}/files`,
        {
          method: "POST",
          cookie: admin,
          body: {
            name: "x.txt",
            data: "eA==",
            contentType: "text/plain",
            category: "result",
            stageId: stage.id,
          },
        },
        400,
      );
      await json(
        `/api/projects/${project1}/files`,
        {
          method: "POST",
          cookie: admin,
          body: {
            name: "x.txt",
            data: "eA==",
            contentType: "text/plain",
            category: "unknown",
          },
        },
        400,
      );
      await json(
        "/api/projects",
        {
          method: "POST",
          cookie: admin,
          csrf: false,
          body: { title: "CSRF", clientId: clients[0].id },
        },
        403,
      );
    });
    await t.test(
      "file size limit accepts 10 MB and rejects larger payloads",
      async () => {
        const payload = {
          name: "limit.txt",
          contentType: "text/plain",
          category: "document",
          data: Buffer.alloc(10 * 1024 * 1024, 120).toString("base64"),
        };
        const uploaded = await json(
          `/api/projects/${project1}/files`,
          { method: "POST", cookie: admin, body: payload },
          201,
        );
        assert.equal(uploaded.size, 10 * 1024 * 1024);
        await json(`/api/files/${uploaded.id}`, {
          method: "DELETE",
          cookie: admin,
          body: {},
        });
        payload.data = Buffer.alloc(10 * 1024 * 1024 + 1, 120).toString(
          "base64",
        );
        await json(
          `/api/projects/${project1}/files`,
          { method: "POST", cookie: admin, body: payload },
          413,
        );
      },
    );
    await t.test(
      "static server never exposes repository and storage secrets",
      async () => {
        for (const path of [
          "/.git/config",
          "/server.mjs",
          "/package.json",
          "/.env",
          "/itd.sqlite",
        ]) {
          const res = await request(path);
          assert.ok(
            [403, 404].includes(res.status),
            `${path} returned ${res.status}`,
          );
        }
      },
    );
    await t.test(
      "projects and file contents survive restart; logout revokes session",
      async () => {
        await app.close();
        app = null;
        await start();
        const cookie = await login(clients[0].email);
        const { projects } = await json("/api/projects", { cookie });
        assert.equal(projects[0].id, project1);
        assert.equal(
          await (
            await request(`/api/files/${file.id}/download`, { cookie })
          ).text(),
          "private result",
        );
        await json("/api/logout", { method: "POST", cookie, body: {} });
        await json("/api/me", { cookie }, 401);
        const freshAdmin = await login(options.adminEmail);
        await json(`/api/files/${file.id}`, {
          method: "DELETE",
          cookie: freshAdmin,
          body: {},
        });
        await json(
          `/api/files/${file.id}/download`,
          { cookie: freshAdmin },
          404,
        );
      },
    );
  } finally {
    if (app) await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("production option issues a Secure session cookie", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "itd-secure-test-"));
  const password = randomBytes(24).toString("hex");
  const app = createApp({
    dataDir,
    adminEmail: "secure@example.test",
    adminPassword: password,
    secureCookies: true,
  });
  try {
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const res = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "secure@example.test", password }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("set-cookie"), /;\s*Secure(?:;|$)/i);
    await res.json();
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("successful logins do not exhaust the failed-password rate limit", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "itd-ratelimit-test-"));
  const password = randomBytes(24).toString("hex");
  const email = "ratelimit@example.test";
  const app = createApp({
    dataDir,
    adminEmail: email,
    adminPassword: password,
  });
  try {
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    async function login(attemptPassword) {
      const res = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: {
          Origin: base,
          "X-ITD-Request": "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, password: attemptPassword }),
      });
      await res.json();
      return res.status;
    }
    for (let i = 0; i < 17; i++)
      assert.equal(await login(password), 200, `successful login ${i + 1}`);
    for (let i = 0; i < 15; i++)
      assert.equal(
        await login("incorrect-password"),
        401,
        `failed login ${i + 1}`,
      );
    assert.equal(await login("incorrect-password"), 429);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

import test from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "./server.mjs";
const origin = "https://cabinet.example.test",
  password = "Legacy-safe-password-123";
async function setup(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "itd-internet-auth-"));
  let app, base;
  async function start(internetMode = false) {
    app = createApp({
      dataDir,
      adminEmail: "admin@example.test",
      adminPassword: password,
      internetMode,
      publicOrigin: origin,
      secureCookies: false,
    });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    base = "http://127.0.0.1:" + app.server.address().port;
  }
  async function stop() {
    await app.close();
  }
  async function call(
    path,
    body,
    {
      internet = true,
      ip = "198.51.100.8",
      headers = {},
      cookie,
      method = body === undefined ? "GET" : "POST",
    } = {},
  ) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        base + path,
        {
          method,
          headers: {
            ...(internet
              ? {
                  Host: "cabinet.example.test",
                  Origin: origin,
                  "X-Real-IP": ip,
                  "X-Forwarded-Proto": "https",
                }
              : { Origin: base }),
            "Content-Type": "application/json",
            "X-ITD-Request": "1",
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
          },
        },
        (response) => {
          let text = "";
          response.on("data", (chunk) => (text += chunk));
          response.on("end", () => {
            try {
              resolve({
                status: response.statusCode,
                value: JSON.parse(text),
                cookie: response.headers["set-cookie"]?.join(","),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  await start(false);
  const registered = await call(
    "/api/register",
    { name: "Legacy Client", email: "client@example.test", password },
    { internet: false },
  );
  assert.equal(registered.status, 201);
  const user = registered.value.user;
  await stop();
  await start(true);
  t.after(async () => {
    await stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { call, user, dataDir, stop, start };
}
test("internet mode disables open registration, retains existing login and always issues Secure cookies", async (t) => {
  const f = await setup(t);
  const runtime = await f.call("/api/runtime");
  assert.deepEqual(runtime.value, {
    internetMode: true,
    registrationAllowed: false,
  });
  assert.equal(runtime.status, 200);
  assert.equal(
    (
      await f.call("/api/register", {
        name: "No",
        email: "new@example.test",
        password,
      })
    ).status,
    403,
  );
  const login = await f.call("/api/login", {
    email: "client@example.test",
    password,
  });
  assert.equal(login.status, 200);
  assert.match(login.cookie, /;\s*Secure/);
  assert.match(login.cookie, /HttpOnly/);
  assert.equal(login.value.user.id, f.user.id);
  const admin = await f.call("/api/login", {
    email: "admin@example.test",
    password,
  });
  assert.equal(admin.status, 200);
  assert.match(admin.cookie, /;\s*Secure/);
});
test("all routes reject wrong Host scheme and Origin, including unauthenticated runtime", async (t) => {
  const f = await setup(t);
  for (const headers of [
    { Host: "evil.example" },
    { Origin: "https://evil.example" },
    { "X-Forwarded-Proto": "http" },
    { "X-Real-IP": "not-an-ip" },
  ])
    assert.equal(
      (await f.call("/api/runtime", undefined, { headers })).status,
      403,
    );
  assert.equal(
    (
      await f.call(
        "/api/login",
        { email: "admin@example.test", password },
        { headers: { Origin: "http://cabinet.example.test" } },
      )
    ).status,
    403,
  );
});
test("login and recovery limits use verified real client IP and ignore forged X-Forwarded-For", async (t) => {
  const f = await setup(t);
  for (let n = 0; n < 15; n++)
    assert.equal(
      (
        await f.call(
          "/api/login",
          { email: "client@example.test", password: "bad" },
          { headers: { "X-Forwarded-For": "203.0.113." + n } },
        )
      ).status,
      401,
    );
  assert.equal(
    (
      await f.call(
        "/api/login",
        { email: "client@example.test", password: "bad" },
        { headers: { "X-Forwarded-For": "1.1.1.1" } },
      )
    ).status,
    429,
  );
  assert.equal(
    (
      await f.call(
        "/api/login",
        { email: "client@example.test", password: "bad" },
        { ip: "198.51.100.9" },
      )
    ).status,
    401,
  );
  for (let n = 0; n < 5; n++)
    assert.equal(
      (
        await f.call(
          "/api/password-recovery/requests",
          { email: "client@example.test" },
          { headers: { "X-Forwarded-For": "203.0.113." + n } },
        )
      ).status,
      202,
    );
  assert.equal(
    (
      await f.call("/api/password-recovery/requests", {
        email: "client@example.test",
      })
    ).status,
    429,
  );
  assert.equal(
    (
      await f.call(
        "/api/password-recovery/requests",
        { email: "client@example.test" },
        { ip: "198.51.100.10" },
      )
    ).status,
    202,
  );
});
test("disabling an account while its password verification is pending cannot create a session", async (t) => {
  const f = await setup(t);
  const jobs = [];
  const initial = new DatabaseSync(join(f.dataDir, "itd.sqlite"));
  initial.prepare("DELETE FROM sessions WHERE userId=?").run(f.user.id);
  initial.close();
  // Fill the asynchronous work queue using independent identities. The actual account is disabled before its queued check can finish.
  for (let n = 0; n < 10; n++)
    jobs.push(
      f.call("/api/login", { email: `missing${n}@example.test`, password }),
    );
  const attempt = f.call("/api/login", {
    email: "client@example.test",
    password,
  });
  await new Promise((r) => setTimeout(r, 5));
  const db = new DatabaseSync(join(f.dataDir, "itd.sqlite"));
  db.prepare("UPDATE users SET isActive=0 WHERE id=?").run(f.user.id);
  db.close();
  assert.equal((await attempt).status, 401);
  await Promise.all(jobs);
  const check = new DatabaseSync(join(f.dataDir, "itd.sqlite"));
  assert.equal(
    check
      .prepare("SELECT count(*) AS n FROM sessions WHERE userId=?")
      .get(f.user.id).n,
    0,
  );
  check.close();
});

test("asynchronous reset consumes a token once and revokes the original sessions", async (t) => {
  const f = await setup(t);
  const old = await f.call("/api/login", {
    email: "client@example.test",
    password,
  });
  const admin = await f.call("/api/login", {
    email: "admin@example.test",
    password,
  });
  const cookie = admin.cookie.split(";")[0];
  assert.equal(
    (
      await f.call("/api/password-recovery/requests", {
        email: "client@example.test",
      })
    ).status,
    202,
  );
  const list = await f.call(
    "/api/admin/password-recovery/requests",
    undefined,
    { cookie },
  );
  const issued = await f.call(
    `/api/admin/password-recovery/requests/${list.value.requests[0].id}/approve`,
    {},
    { cookie },
  );
  const token = issued.value.resetPath.split("#")[1],
    next = "Changed-password-for-single-use-456";
  const results = await Promise.all([
    f.call("/api/password-recovery/reset", {
      token,
      password: next,
      passwordConfirm: next,
    }),
    f.call("/api/password-recovery/reset", {
      token,
      password: next,
      passwordConfirm: next,
    }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
  assert.equal(
    (await f.call("/api/me", undefined, { cookie: old.cookie.split(";")[0] }))
      .status,
    401,
  );
  assert.equal(
    (
      await f.call("/api/login", {
        email: "client@example.test",
        password: next,
      })
    ).status,
    200,
  );
});

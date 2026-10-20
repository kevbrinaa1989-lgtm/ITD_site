import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createUploadIntents } from "./upload-intents.mjs";
import { createApp } from "./server.mjs";
const context = {
  sessionHash: "session-a",
  adminId: 1,
  projectId: 10,
  clientId: 20,
};
const payload = {
  name: "example.txt",
  contentType: "text/plain",
  category: "document",
  data: Buffer.from("hello").toString("base64"),
};
const throwsStatus = (fn, status) =>
  assert.throws(fn, (error) => error.status === status);
test("upload receipts bind session destination content and expiration within a bounded cache", () => {
  let clock = 1000000;
  const cache = createUploadIntents({ now: () => clock, maxEntries: 1 });
  const issued = cache.issue(context),
    request = { ...context, uploadIntent: issued.uploadIntent, payload };
  assert.match(issued.uploadIntent, /^[a-f0-9]{64}$/);
  assert.equal(Date.parse(issued.expiresAt) - clock, 30 * 60 * 1000);
  throwsStatus(() => cache.issue(context), 429);
  throwsStatus(
    () => cache.validate({ ...request, uploadIntent: "tampered" }),
    409,
  );
  throwsStatus(
    () => cache.validate({ ...request, sessionHash: "another-session" }),
    403,
  );
  throwsStatus(() => cache.validate({ ...request, projectId: 11 }), 409);
  throwsStatus(() => cache.validate({ ...request, clientId: 21 }), 409);
  const prepared = cache.validate(request);
  cache.complete(prepared, { id: 99 });
  assert.deepEqual(
    cache.validate({
      ...request,
      payload: {
        data: payload.data,
        category: payload.category,
        contentType: payload.contentType,
        name: payload.name,
      },
    }).result,
    { id: 99 },
  );
  throwsStatus(
    () =>
      cache.validate({
        ...request,
        payload: { ...payload, name: "different.txt" },
      }),
    409,
  );
  clock += 30 * 60 * 1000;
  throwsStatus(() => cache.validate(request), 409);
  assert.ok(cache.issue(context));
});
test("version intent binds the current version and its decision revision", () => {
  const cache = createUploadIntents(),
    issued = cache.issue({
      ...context,
      materialId: 4,
      expectedVersionId: 5,
      revision: 2,
    });
  const request = {
    ...context,
    uploadIntent: issued.uploadIntent,
    payload: { ...payload, materialId: 4, expectedVersionId: 5 },
    currentVersionId: 5,
    currentRevision: 2,
  };
  throwsStatus(() => cache.validate({ ...request, currentVersionId: 6 }), 409);
  throwsStatus(() => cache.validate({ ...request, currentRevision: 3 }), 409);
  const prepared = cache.validate(request);
  cache.complete(prepared, { id: 100 });
  assert.equal(
    cache.validate({ ...request, currentVersionId: 6, currentRevision: 4 })
      .result.id,
    100,
  );
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "itd-upload-intents-"));
  let clock = Date.now();
  const password = "Temporary-test-password-123";
  const app = createApp({
    dataDir: root,
    adminEmail: "admin@example.test",
    adminPassword: password,
    uploadIntentNow: () => clock,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  async function request(path, body, cookie, method = "POST") {
    const response = await fetch(base + path, {
      method,
      headers: {
        Origin: base,
        "Content-Type": "application/json",
        "X-ITD-Request": "1",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  async function json(path, body, cookie, status = 200, method = "POST") {
    const result = await request(path, body, cookie, method);
    assert.equal(
      result.status,
      status,
      `${method} ${path}: ${JSON.stringify(result.body)}`,
    );
    return result.body;
  }
  const login = () =>
    request("/api/login", { email: "admin@example.test", password });
  const admin = (await login()).cookie;
  const client = await request("/api/register", {
    email: "client@example.test",
    name: "First",
    password,
  });
  const other = await request("/api/register", {
    email: "other@example.test",
    name: "Second",
    password,
  });
  const project = await json(
    "/api/projects",
    { title: "Original", clientId: client.body.user.id },
    admin,
    201,
  );
  const project2 = await json(
    "/api/projects",
    { title: "Other", clientId: client.body.user.id },
    admin,
    201,
  );
  const stage = await json(
    `/api/projects/${project.id}/stages`,
    { title: "Plan", status: "planned" },
    admin,
    201,
  );
  const prepare = (id = project.id, options = {}) =>
    json(`/api/projects/${id}/upload-intents`, options, admin, 201);
  const upload = (body, status = 201, cookie = admin, id = project.id) =>
    json(`/api/projects/${id}/files`, body, cookie, status);
  const count = (table) => {
    const db = new DatabaseSync(join(root, "itd.sqlite"));
    try {
      return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    } finally {
      db.close();
    }
  };
  return {
    base,
    root,
    request,
    json,
    admin,
    client,
    other,
    project,
    project2,
    stage,
    prepare,
    upload,
    login,
    count,
    expire: () => {
      clock += 30 * 60 * 1000;
    },
  };
}
test("preparation and uploads require administrator access and explicit valid context", async (t) => {
  const f = await fixture(t),
    path = `/api/projects/${f.project.id}/upload-intents`;
  await f.json(path, {}, undefined, 401);
  await f.json(path, {}, f.client.cookie, 403);
  await f.json(path, { clientId: f.other.body.user.id }, f.admin, 400);
  await f.json(path, { materialId: 1 }, f.admin, 400);
  await f.json("/api/projects/999999/upload-intents", {}, f.admin, 404);
  await f.upload(payload, 409);
  await f.upload({ ...payload, uploadIntent: "0".repeat(64) }, 409);
  const intent = await f.prepare();
  assert.equal(intent.clientId, f.client.body.user.id);
  await f.upload(
    { ...payload, uploadIntent: intent.uploadIntent },
    409,
    f.admin,
    f.project2.id,
  );
  assert.equal(f.count("files"), 0);
});
test("expired and another-session tickets are rejected without duplicate files", async (t) => {
  const f = await fixture(t),
    intent = await f.prepare(),
    secondSession = (await f.login()).cookie;
  await f.upload(
    { ...payload, uploadIntent: intent.uploadIntent },
    403,
    secondSession,
  );
  f.expire();
  await f.upload({ ...payload, uploadIntent: intent.uploadIntent }, 409);
  assert.equal(f.count("files"), 0);
});
test("project reassignment after preparation invalidates the destination snapshot", async (t) => {
  const f = await fixture(t),
    intent = await f.prepare();
  await f.json(
    `/api/admin/projects/${f.project.id}/assign`,
    {
      clientId: f.other.body.user.id,
      expectedClientId: f.client.body.user.id,
      confirm: true,
    },
    f.admin,
  );
  await f.upload({ ...payload, uploadIntent: intent.uploadIntent }, 409);
  assert.equal(f.count("files"), 0);
});
test("identical ordinary and review upload retries return original receipts and never duplicate rows", async (t) => {
  const f = await fixture(t);
  for (const review of [false, true]) {
    const intent = await f.prepare(),
      body = {
        ...payload,
        category: review ? "result" : "document",
        ...(review ? { review: true, stageId: f.stage.id } : {}),
        uploadIntent: intent.uploadIntent,
      };
    const first = await f.upload(body),
      counts = [
        "files",
        "review_versions",
        "review_events",
        "review_notifications",
      ].map(f.count);
    assert.deepEqual(await f.upload(body), first);
    assert.deepEqual(
      ["files", "review_versions", "review_events", "review_notifications"].map(
        f.count,
      ),
      counts,
    );
    await f.upload({ ...body, name: "modified.txt" }, 409);
    if (review) {
      await f.json(
        `/api/material-versions/${first.review.versionId}/decision`,
        { decision: "approved", confirm: true, expectedRevision: 0 },
        f.client.cookie,
      );
      assert.deepEqual(await f.upload(body), first);
    }
  }
});
test("new-version tickets bind material current-version revision and cannot enroll another group", async (t) => {
  const f = await fixture(t),
    initial = await f.prepare(),
    first = await f.upload({
      ...payload,
      category: "result",
      stageId: f.stage.id,
      review: true,
      uploadIntent: initial.uploadIntent,
    });
  const intent = await f.prepare(f.project.id, {
    materialId: first.review.materialId,
    expectedVersionId: first.review.versionId,
  });
  await f.json(
    `/api/projects/${f.project2.id}/upload-intents`,
    {
      materialId: first.review.materialId,
      expectedVersionId: first.review.versionId,
    },
    f.admin,
    409,
  );
  await f.json(
    `/api/material-versions/${first.review.versionId}/decision`,
    { decision: "changes_requested", comment: "Update", expectedRevision: 0 },
    f.client.cookie,
  );
  const body = {
    ...payload,
    category: "result",
    stageId: f.stage.id,
    materialId: first.review.materialId,
    expectedVersionId: first.review.versionId,
    uploadIntent: intent.uploadIntent,
  };
  await f.upload(body, 409);
  assert.equal(f.count("files"), 1);
  const fresh = await f.prepare(f.project.id, {
    materialId: first.review.materialId,
    expectedVersionId: first.review.versionId,
  });
  const second = await f.upload({ ...body, uploadIntent: fresh.uploadIntent });
  assert.equal(second.review.versionNumber, 2);
});
test("ownership changes while the JSON body is being uploaded are checked after the body finishes", async (t) => {
  const f = await fixture(t),
    intent = await f.prepare(),
    body = JSON.stringify({ ...payload, uploadIntent: intent.uploadIntent });
  let finish;
  const response = new Promise((resolve, reject) => {
    const req = http.request(
      f.base + `/api/projects/${f.project.id}/files`,
      {
        method: "POST",
        headers: {
          Origin: f.base,
          "Content-Type": "application/json",
          "X-ITD-Request": "1",
          Cookie: f.admin,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: JSON.parse(text) }),
        );
      },
    );
    req.on("error", reject);
    req.write(body.slice(0, 20));
    finish = () => req.end(body.slice(20));
  });
  await f.json(
    `/api/admin/projects/${f.project.id}/assign`,
    {
      clientId: f.other.body.user.id,
      expectedClientId: f.client.body.user.id,
      confirm: true,
    },
    f.admin,
  );
  finish();
  assert.equal((await response).status, 409);
  assert.equal(f.count("files"), 0);
});

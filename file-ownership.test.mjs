import { confirmFixtureReview } from "./tests/approval-fixture.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ownershipFixture } from "./tests/ownership-fixture.mjs";
import { fixtures } from "./tests/preview-fixtures.mjs";
const pdf = fixtures.find((f) => f[1] === "application/pdf"),
  jpg = fixtures.find((f) => f[1] === "image/jpeg");
test("project/stage ownership persists through upload, rename, atomic moves, download, deletion, restart and authorization", async (t) => {
  const f = await ownershipFixture();
  t.after(() => f.close());
  const [a, b] = f.projects,
    [a1, a2] = a.stages;
  const upload = (p, stageId, name = "document.pdf", extra = {}) =>
    f.api(
      `/api/projects/${p.id}/files`,
      {
        name,
        contentType: pdf[1],
        data: pdf[2].toString("base64"),
        category: "document",
        stageId,
        ...extra,
      },
      f.admin,
      "POST",
      201,
    );
  const general = await upload(a, null, "contract.pdf", {
      document: {
        title: "Договор",
        kind: "Договор",
        number: "Б-1",
        date: "2026-11-13",
      },
    }),
    one = await upload(a, a1.id),
    two = await upload(a, a2.id),
    other = await upload(b, b.stages[0].id);
  async function ids(p, scope, cookie = f.clients[0].cookie) {
    return (
      await f.api(
        `/api/projects/${p.id}/files?stageId=${scope ?? "none"}`,
        null,
        cookie,
      )
    ).files.map((x) => x.id);
  }
  assert.deepEqual(await ids(a, null), [general.id]);
  assert.deepEqual(await ids(a, a1.id), [one.id]);
  assert.deepEqual(await ids(a, a2.id), [two.id]);
  assert.deepEqual(await ids(b, b.stages[0].id, f.clients[1].cookie), [
    other.id,
  ]);
  await f.api(
    `/api/projects/${a.id}/files?stageId=${b.stages[0].id}`,
    null,
    f.admin,
    "GET",
    400,
  );
  await f.api(
    `/api/projects/${b.id}/files`,
    null,
    f.clients[0].cookie,
    "GET",
    403,
  );
  for (const suffix of ["download", "preview"])
    assert.equal(
      (
        await f.request(
          `/api/files/${other.id}/${suffix}`,
          null,
          f.clients[0].cookie,
        )
      ).status,
      403,
    );
  await f.api(
    `/api/projects/${a.id}/files/${general.id}`,
    { stageId: a1.id, expectedStageId: null },
    f.clients[0].cookie,
    "PATCH",
    403,
  );
  await f.api(
    `/api/projects/${b.id}/files/${general.id}`,
    { stageId: null, expectedStageId: null },
    f.admin,
    "PATCH",
    404,
  );
  await f.api(
    `/api/projects/${a.id}/files/${general.id}`,
    { stageId: b.stages[0].id, expectedStageId: null },
    f.admin,
    "PATCH",
    400,
  );
  await f.api(
    `/api/projects/${a.id}/files/${general.id}`,
    {
      stageId: a1.id,
      expectedStageId: null,
      title: "Договор Балтика",
      expectedTitle: "Договор",
    },
    f.admin,
    "PATCH",
  );
  assert.deepEqual(await ids(a, null), []);
  assert.deepEqual(await ids(a, a1.id), [general.id, one.id]);
  await f.api(
    `/api/projects/${a.id}/files/${general.id}`,
    { stageId: null, expectedStageId: null },
    f.admin,
    "PATCH",
    409,
  );
  for (const [from, to] of [
    [a1.id, a2.id],
    [a2.id, null],
  ])
    await f.api(
      `/api/projects/${a.id}/files/${general.id}`,
      { stageId: to, expectedStageId: from },
      f.admin,
      "PATCH",
    );
  assert.deepEqual(await ids(a, null), [general.id]);
  const row = f.rows("SELECT * FROM files WHERE id=?", general.id)[0];
  assert.equal(row.projectId, a.id);
  assert.equal(row.stageId, null);
  assert.equal(row.name, "contract.pdf");
  assert.deepEqual(await readFile(join(f.dataDir, "files", row.path)), pdf[2]);
  assert.equal(f.rows("SELECT count(*) AS n FROM files")[0].n, 4);
  assert.equal(
    f.rows("SELECT title FROM document_cards WHERE fileId=?", general.id)[0]
      .title,
    "Договор Балтика",
  );
  const db = new DatabaseSync(join(f.dataDir, "itd.sqlite"));
  try {
    assert.throws(() =>
      db
        .prepare("UPDATE files SET stageId=? WHERE id=?")
        .run(b.stages[0].id, general.id),
    );
    assert.throws(() =>
      db
        .prepare("UPDATE files SET projectId=? WHERE id=?")
        .run(b.id, general.id),
    );
  } finally {
    db.close();
  }
  await f.restart();
  const cookie = await f.login(f.clients[0].email);
  assert.deepEqual(await ids(a, null, cookie), [general.id]);
  const download = await f.request(
    `/api/files/${general.id}/download`,
    null,
    cookie,
  );
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), pdf[2]);
  const admin = await f.login("admin@example.test");
  await f.api(
    `/api/projects/${a.id}/files/${two.id}`,
    { expectedStageId: a1.id },
    admin,
    "DELETE",
    409,
  );
  await f.api(
    `/api/projects/${a.id}/files/${two.id}`,
    { expectedStageId: a2.id },
    admin,
    "DELETE",
  );
  assert.deepEqual(await ids(a, a2.id, cookie), []);
  assert.equal(f.rows("SELECT id FROM files WHERE id=?", other.id).length, 1);
});
test("a review material moves as one group with unchanged decisions/comments/history and can receive versions at project level", async (t) => {
  const f = await ownershipFixture();
  t.after(() => f.close());
  const p = f.projects[0],
    s = p.stages[0];
  const upload = (extra = {}) =>
    f.api(
      `/api/projects/${p.id}/files`,
      {
        name: "plan.jpg",
        contentType: jpg[1],
        data: jpg[2].toString("base64"),
        category: "result",
        stageId: s.id,
        review: true,
        ...extra,
      },
      f.admin,
      "POST",
      201,
    );
  const first = await upload();
  await f.api(
    `/api/material-versions/${first.review.versionId}/comments`,
    { text: "Сохранить этот комментарий" },
    f.clients[0].cookie,
    "POST",
  );
  const current = await upload({
    materialId: first.review.materialId,
    expectedVersionId: first.review.versionId,
  });
  await confirmFixtureReview(
    (path, body) => f.api(path, body, f.clients[0].cookie, "POST"),
    current.review.versionId,
  );
  await f.api(
    `/api/material-versions/${current.review.versionId}/decision`,
    { decision: "approved", confirm: true, expectedRevision: 0 },
    f.clients[0].cookie,
    "POST",
  );
  const tables = [
      "review_versions",
      "review_events",
      "review_notifications",
      "review_views",
    ],
    before = tables.map((table) => f.rows(`SELECT * FROM ${table}`));
  const paths = f.rows("SELECT id,path FROM files"),
    stages = f.rows("SELECT * FROM stages");
  for (const [from, to] of [
    [s.id, null],
    [null, p.stages[1].id],
    [p.stages[1].id, null],
  ]) {
    await f.api(
      `/api/projects/${p.id}/files/${current.id}`,
      { stageId: to, expectedStageId: from },
      f.admin,
      "PATCH",
    );
    assert.ok(
      f.rows("SELECT stageId FROM files").every((row) => row.stageId === to),
    );
    assert.equal(f.rows("SELECT stageId FROM review_materials")[0].stageId, to);
  }
  assert.deepEqual(
    tables.map((table) => f.rows(`SELECT * FROM ${table}`)),
    before,
  );
  assert.deepEqual(f.rows("SELECT id,path FROM files"), paths);
  assert.deepEqual(f.rows("SELECT * FROM stages"), stages);
  await f.api(
    `/api/projects/${p.id}/files/${first.id}`,
    { expectedStageId: null },
    f.admin,
    "DELETE",
    409,
  );
  const next = await upload({
    stageId: null,
    materialId: first.review.materialId,
    expectedVersionId: current.review.versionId,
  });
  assert.equal(next.review.versionNumber, 3);
  await f.api(
    `/api/material-versions/${next.review.versionId}/comments`,
    { text: "Комментарий без этапа" },
    f.clients[0].cookie,
    "POST",
  );
  await f.api(
    `/api/materials/${first.review.materialId}`,
    null,
    f.clients[1].cookie,
    "GET",
    403,
  );
  assert.equal(
    f.rows("SELECT stageId FROM review_events ORDER BY id DESC LIMIT 1")[0]
      .stageId,
    null,
  );
});
test("upload tickets reject same-project stage changes and foreign projects before writing files", async (t) => {
  const f = await ownershipFixture();
  t.after(() => f.close());
  const p = f.projects[0],
    s = p.stages[0];
  const ticket = await f.api(
    `/api/projects/${p.id}/upload-intents`,
    { stageId: s.id },
    f.admin,
    "POST",
    201,
  );
  const payload = {
    name: "scope.pdf",
    contentType: pdf[1],
    data: pdf[2].toString("base64"),
    category: "document",
    stageId: s.id,
    uploadIntent: ticket.uploadIntent,
  };
  for (const stageId of [null, p.stages[1].id])
    await f.api(
      `/api/projects/${p.id}/files`,
      { ...payload, stageId },
      f.admin,
      "POST",
      409,
    );
  await f.api(
    `/api/projects/${f.projects[1].id}/files`,
    { ...payload, stageId: f.projects[1].stages[0].id },
    f.admin,
    "POST",
    409,
  );
  assert.equal(f.rows("SELECT count(*) AS n FROM files")[0].n, 0);
  const saved = await f.api(
    `/api/projects/${p.id}/files`,
    payload,
    f.admin,
    "POST",
    201,
  );
  const retried = await f.api(
    `/api/projects/${p.id}/files`,
    payload,
    f.admin,
    "POST",
    201,
  );
  assert.equal(saved.id, retried.id);
  await f.api(
    `/api/projects/${p.id}/files/${saved.id}`,
    { stageId: null, expectedStageId: s.id },
    f.admin,
    "PATCH",
  );
  await f.api(`/api/projects/${p.id}/files`, payload, f.admin, "POST", 409);
  assert.equal(f.rows("SELECT count(*) AS n FROM files")[0].n, 1);
});

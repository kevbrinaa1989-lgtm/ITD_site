import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { ownershipFixture } from "./tests/ownership-fixture.mjs";
import { fixtures } from "./tests/preview-fixtures.mjs";
import {
  bindData,
  backupData,
  verifyBackup,
  restoreBackup,
} from "./data-storage.mjs";
async function setup(t, count = 1) {
  const f = await ownershipFixture();
  t.after(() => f.close());
  const p = f.projects[0],
    s = p.stages[0],
    client = f.clients[0].cookie;
  const route = `/api/approval-center/projects/${p.id}/stages/${s.id}`;
  async function upload(extra = {}) {
    const [name, contentType, bytes] = fixtures[0];
    return f.api(
      `/api/projects/${p.id}/files`,
      {
        name,
        contentType,
        data: bytes.toString("base64"),
        category: "result",
        stageId: s.id,
        review: true,
        ...extra,
      },
      f.admin,
      "POST",
      201,
    );
  }
  for (let i = 0; i < count; i++)
    await upload({ name: `Материал-${i + 1}.png` });
  const state = () => f.api(route, null, client);
  const confirm = async (v) => {
    await f.api(
      `/api/approval-center/versions/${v.id}/view`,
      { page: 1 },
      client,
    );
    await f.api(
      `/api/approval-center/versions/${v.id}/view`,
      { confirm: true },
      client,
    );
  };
  const entry = (m, decision = "approved", comment = "", markers = []) => ({
    materialId: m.id,
    versionId: m.currentVersion.id,
    expectedRevision: m.currentVersion.revision,
    decision,
    comment,
    markers,
  });
  const save = async (entries, revision) =>
    f.api(
      route + "/draft",
      {
        expectedRevision: revision ?? (await state()).draft.revision,
        entries,
        position: {},
      },
      client,
      "PUT",
    );
  const submit = async (revision, operationId = randomUUID(), status = 200) =>
    f.api(
      route + "/submit",
      { expectedRevision: revision, operationId, confirm: true },
      client,
      "POST",
      status,
    );
  return {
    ...f,
    p,
    s,
    client,
    route,
    upload,
    state,
    confirm,
    entry,
    save,
    submit,
  };
}
for (const count of [1, 10, 30, 50, 100])
  test(`atomic approval packet of ${count} files, one notification, one immutable PDF statement`, async (t) => {
    const f = await setup(t, count),
      before = await f.state();
    for (const m of before.materials) await f.confirm(m.currentVersion);
    const d = await f.save(before.materials.map((m) => f.entry(m))),
      n = f.rows("SELECT count(*) AS n FROM review_notifications")[0].n;
    const op = randomUUID(),
      r = await f.submit(d.revision, op);
    assert.equal(r.accepted.length, count);
    assert.equal(
      f.rows("SELECT count(*) AS n FROM review_notifications")[0].n,
      n + 1,
    );
    const again = await f.submit(d.revision, op);
    assert.equal(again.packageId, r.packageId);
    assert.equal(again.replayed, true);
    const after = await f.state();
    assert.ok(
      after.materials.every((m) => m.currentVersion.status === "approved"),
    );
    assert.equal(after.draft.entries.length, 0);
    assert.equal(after.stage.approved, false);
    assert.deepEqual(after.stage.blockers, []);
    const statement = await f.api(
      `/api/approval-center/packages/${r.packageId}`,
      null,
      f.client,
    );
    assert.equal(statement.materials.length, count);
    const response = await f.request(
      `/api/approval-center/packages/${r.packageId}/pdf`,
      null,
      f.client,
    );
    assert.equal(response.status, 200);
    const pdf = await PDFDocument.load(await response.arrayBuffer());
    assert.ok(pdf.getPageCount() >= 1);
    await f.restart();
    assert.deepEqual(
      await f.api(
        `/api/approval-center/packages/${r.packageId}`,
        null,
        f.client,
      ),
      statement,
    );
  });
test("full 40 → 35 + 5 → corrections → confirmation → new versions → separate stage acceptance", async (t) => {
  const f = await setup(t, 40),
    state = await f.state();
  for (const m of state.materials) await f.confirm(m.currentVersion);
  const markers = [
    {
      page: 1,
      x: 0.24,
      y: 0.7,
      body: "Заменить светильник <script>alert(1)</script>",
    },
  ];
  const entries = state.materials.map((m, i) =>
    f.entry(
      m,
      i < 35 ? "approved" : "changes_requested",
      i < 35 ? "" : "Заменить модель",
      i < 35 ? [] : markers,
    ),
  );
  const d = await f.save(entries),
    first = await f.submit(d.revision),
    snap = await f.api(
      `/api/approval-center/packages/${first.packageId}`,
      null,
      f.client,
    );
  let current = await f.state();
  assert.equal(
    current.materials.filter(
      (m) => m.currentVersion.status === "changes_requested",
    ).length,
    5,
  );
  assert.equal(first.roundNumber, 1);
  const newEntries = [];
  for (const m of current.materials.slice(35)) {
    const n = m.notes[0];
    assert.equal(n.history.length, 1);
    // Missing reports cannot publish an unaccountable correction.
    await f.api(
      `/api/projects/${f.p.id}/files`,
      {
        name: "bad.png",
        contentType: "image/png",
        data: fixtures[0][2].toString("base64"),
        category: "result",
        stageId: f.s.id,
        materialId: m.id,
        expectedVersionId: m.currentVersion.id,
      },
      f.admin,
      "POST",
      400,
    );
    const uploaded = await f.upload({
      name: "Исправлено.png",
      materialId: m.id,
      expectedVersionId: m.currentVersion.id,
      correctionReport: {
        description: "Заменён светильник",
        resolutions: [
          {
            noteId: n.id,
            fixed: true,
            explanation: "Установлена другая модель",
          },
        ],
      },
    });
    const updated = (await f.state()).materials.find((x) => x.id === m.id),
      note = updated.notes[0];
    assert.equal(note.status, "fixed");
    assert.equal(updated.versions[0].status, "changes_requested");
    await f.api(
      `/api/approval-center/notes/${note.id}/events`,
      { type: "confirmed", body: "Проверено", expectedRevision: note.revision },
      f.admin,
      "POST",
      403,
    );
    await f.api(
      `/api/approval-center/notes/${note.id}/events`,
      {
        type: "confirmed",
        body: "Исправление проверено",
        expectedRevision: note.revision,
        versionId: uploaded.review.versionId,
      },
      f.client,
    );
    await f.confirm(updated.currentVersion);
    newEntries.push(f.entry(updated));
  }
  const nextDraft = await f.save(newEntries),
    second = await f.submit(nextDraft.revision);
  assert.equal(second.roundNumber, 2);
  assert.deepEqual(
    await f.api(
      `/api/approval-center/packages/${first.packageId}`,
      null,
      f.client,
    ),
    snap,
  );
  current = await f.state();
  assert.equal(current.stage.approved, false);
  assert.deepEqual(current.stage.blockers, []);
  const operationId = randomUUID();
  await f.api(
    f.route + "/approve-stage",
    { operationId, token: current.stage.token, confirm: true },
    f.client,
  );
  assert.equal((await f.state()).stage.approved, true);
  assert.equal(
    (
      await f.api(
        f.route + "/approve-stage",
        { operationId, token: current.stage.token, confirm: true },
        f.client,
      )
    ).replayed,
    true,
  );
  const db = new DatabaseSync(join(f.dataDir, "itd.sqlite"));
  try {
    assert.throws(
      () => db.exec("UPDATE approval_packages SET snapshot='{}'"),
      /immutable/,
    );
    assert.throws(
      () => db.exec("DELETE FROM approval_note_events"),
      /immutable/,
    );
    assert.throws(
      () => db.exec("UPDATE approval_notes SET body='replacement'"),
      /immutable/,
    );
  } finally {
    db.close();
  }
});
test("drafts restore after restart, CAS prevents two-tab overwrite, stale versions roll the whole packet back", async (t) => {
  const f = await setup(t, 2),
    s = await f.state();
  for (const m of s.materials) await f.confirm(m.currentVersion);
  const d = await f.save(s.materials.map((m) => f.entry(m)));
  await f.save([], 0).then(
    () => assert.fail("must conflict"),
    () => {},
  );
  await f.restart();
  assert.deepEqual((await f.state()).draft, d);
  await f.upload({
    materialId: s.materials[1].id,
    expectedVersionId: s.materials[1].currentVersion.id,
  });
  const before = f.rows("SELECT count(*) AS n FROM review_events")[0].n;
  await f.submit(d.revision, randomUUID(), 409);
  const after = await f.state();
  assert.equal(after.materials[0].currentVersion.status, "pending_approval");
  assert.equal(after.packages.length, 0);
  assert.equal(after.draft.entries.length, 2);
  assert.equal(after.conflicts.length, 1);
  assert.equal(f.rows("SELECT count(*) AS n FROM review_events")[0].n, before);
});
test("PDF requires all real pages plus explicit confirmation; malformed coordinates and unread approvals rejected", async (t) => {
  const f = await setup(t, 0),
    pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.addPage();
  pdf.addPage();
  await f.upload({
    name: "План.pdf",
    contentType: "application/pdf",
    data: Buffer.from(await pdf.save()).toString("base64"),
  });
  const m = (await f.state()).materials[0],
    path = `/api/approval-center/versions/${m.currentVersion.id}/view`;
  const d = await f.save([f.entry(m)]);
  await f.submit(d.revision, randomUUID(), 409);
  await f.api(path, { page: 1 }, f.client);
  await f.api(path, { confirm: true }, f.client, "POST", 409);
  await f.api(path, { page: 4 }, f.client, "POST", 400);
  await f.api(path, { page: 2 }, f.client);
  await f.api(path, { page: 3 }, f.client);
  assert.equal(
    (await f.api(path, { confirm: true }, f.client)).confirmed,
    true,
  );
  const invalid = f.entry(m, "changes_requested", "Изменить", [
    { page: 4, x: 1.1, y: 0, body: "wrong" },
  ]);
  await f.api(
    f.route + "/draft",
    { expectedRevision: d.revision, entries: [invalid], position: {} },
    f.client,
    "PUT",
    400,
  );
  await f.submit(d.revision);
});
test("ownership, roles, stage scoping, idempotency payload binding and optional materials", async (t) => {
  const f = await setup(t, 2),
    s = await f.state(),
    other = f.clients[1].cookie,
    m = s.materials[0];
  await f.api(f.route, null, other, "GET", 403);
  await f.api(f.route, null, null, "GET", 401);
  await f.api(
    `/api/approval-center/projects/${f.p.id}/stages/${f.projects[1].stages[0].id}`,
    null,
    f.client,
    "GET",
    404,
  );
  await f.api(
    f.route + "/draft",
    { expectedRevision: 0, entries: [], position: {} },
    f.admin,
    "PUT",
    403,
  );
  await f.api(
    `/api/approval-center/versions/${m.currentVersion.id}/view`,
    { page: 1 },
    other,
    "POST",
    403,
  );
  await f.confirm(m.currentVersion);
  const d = await f.save([f.entry(m)]),
    op = randomUUID(),
    pack = await f.submit(d.revision, op);
  await f.submit(d.revision + 1, op, 409);
  await f.api(
    `/api/approval-center/packages/${pack.packageId}`,
    null,
    other,
    "GET",
    403,
  );
  await f.api(
    `/api/approval-center/materials/${s.materials[1].id}/metadata`,
    { room: "Гостиная", required: false, expectedRevision: 0 },
    f.client,
    "PATCH",
    403,
  );
  await f.api(
    `/api/approval-center/materials/${s.materials[1].id}/metadata`,
    { room: "Гостиная", required: false, expectedRevision: 0 },
    f.admin,
    "PATCH",
  );
  assert.deepEqual((await f.state()).stage.blockers, []);
  // Confirmation of an annotation is not a file decision; unchanged materials keep the same round.
  const remaining = (await f.state()).materials[1];
  await f.confirm(remaining.currentVersion);
  const d2 = await f.save([f.entry(remaining)]);
  assert.equal((await f.submit(d2.revision)).roundNumber, 1);
});
test("designer publishes selected existing files atomically with one notification and stable retry", async (t) => {
  const f = await setup(t, 0),
    files = [];
  for (let i = 0; i < 10; i++)
    files.push(await f.upload({ name: `Публикация-${i}.png`, review: false }));
  const request = {
    fileIds: files.map((f) => f.id),
    operationId: randomUUID(),
    confirm: true,
  };
  await f.api(f.route + "/publish", request, f.client, "POST", 403);
  const before = f.rows("SELECT count(*) AS n FROM review_notifications")[0].n;
  const result = await f.api(f.route + "/publish", request, f.admin);
  assert.equal(result.materials.length, 10);
  assert.equal(
    f.rows("SELECT count(*) AS n FROM review_notifications")[0].n,
    before + 1,
  );
  assert.deepEqual(await f.api(f.route + "/publish", request, f.admin), result);
  assert.equal((await f.state()).materials.length, 10);
});

test("backup and restore preserve approval snapshots, drafts, annotations and corrections exactly", async (t) => {
  const f = await setup(t),
    before = await f.state(),
    m = before.materials[0];
  const saved = await f.save([
    f.entry(m, "changes_requested", "Исправить", [
      { page: 1, x: 0.25, y: 0.75, body: "Светильник" },
    ]),
  ]);
  await f.submit(saved.revision);
  const note = (await f.state()).materials[0].notes[0];
  await f.upload({
    materialId: m.id,
    expectedVersionId: m.currentVersion.id,
    correctionReport: {
      description: "Светильник изменён",
      resolutions: [{ noteId: note.id, fixed: true, explanation: "Заменён" }],
    },
  });
  const updated = (await f.state()).materials[0];
  await f.save([f.entry(updated, null, "Продолжить проверку")]);
  const tables = f
    .rows(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name LIKE 'approval_%' ORDER BY name",
    )
    .map((r) => r.name);
  const rows = tables.map((table) =>
    f.rows(`SELECT * FROM ${table} ORDER BY rowid`),
  );
  await f.stop();
  const settingsFile = join(f.root, "backup-settings.json");
  await bindData(f.dataDir, {
    settingsFile,
    backupDestination: join(f.root, "backups"),
  });
  const copy = await backupData({
    settingsFile,
    destination: join(f.root, "backups"),
  });
  verifyBackup(copy);
  const restored = join(f.root, "restored");
  restoreBackup(copy, restored);
  const db = new DatabaseSync(join(restored, "itd.sqlite"));
  try {
    assert.deepEqual(
      tables.map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({...row})),
      ),
      rows,
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM sessions").get().n, 0);
    assert.throws(() =>
      db.prepare("UPDATE approval_notes SET body='changed'").run(),
    );
    assert.throws(() => db.prepare("DELETE FROM approval_packages").run());
    assert.throws(() =>
      db.prepare("UPDATE approval_corrections SET report='{}'").run(),
    );
  } finally {
    db.close();
  }
});

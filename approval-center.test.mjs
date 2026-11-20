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
test("submitted return text stays with its project, stage and version and appears once alongside its pins", async (t) => {
  const f = await setup(t, 3);
  const [general, pinned, both] = (await f.state()).materials;
  const mark = { page: 1, x: 0.5, y: 0.5, body: "Перенести розетку" };
  const draft = await f.save([
    f.entry(general, "changes_requested", "Уточнить размер прохода"),
    f.entry(pinned, "changes_requested", "", [mark]),
    f.entry(both, "changes_requested", "Уточнить размещение мебели", [mark]),
  ]);
  const asStudio = () => f.api(f.route, null, f.admin);
  assert.ok((await asStudio()).materials.every(m => !m.notes.length && !m.returnComments.length));
  await f.submit(draft.revision);
  for (const state of [await asStudio(), await f.state()]) {
    const [a, b, c] = state.materials;
    assert.deepEqual(a.returnComments.map(x => [x.body, x.versionId, x.versionNumber, x.authorName]),
      [["Уточнить размер прохода", general.currentVersion.id, 1, f.clients[0].name]]);
    assert.deepEqual(a.notes, []);
    assert.deepEqual(b.returnComments, []);
    assert.equal(b.notes[0].body, mark.body);
    assert.deepEqual(c.returnComments.map(x => x.body), ["Уточнить размещение мебели"]);
    assert.equal(c.notes[0].body, mark.body);
  }
  const next = await f.upload({ materialId: general.id, expectedVersionId: general.currentVersion.id,
    correctionReport: { description: "Добавлен размер", resolutions: [] } });
  const updated = (await asStudio()).materials[0];
  assert.equal(updated.currentVersion.id, next.review.versionId);
  assert.equal(updated.returnComments[0].versionId, general.currentVersion.id);
  assert.equal((await f.api(`/api/approval-center/projects/${f.p.id}/stages/${f.p.stages[1].id}`, null, f.admin)).materials.length, 0);
  await f.api(f.route, null, f.clients[1].cookie, "GET", 403);
});
test("published general remarks survive approval and keep intentionally matching pins", async (t) => {
  const f = await setup(t, 3);
  const [approved, separate, mirrored] = (await f.state()).materials;
  const comment = "Размеры согласованы с учётом чистовой отделки.";
  const mark = { page: 1, x: 0.25, y: 0.75, body: "Проверить зазор." };
  await f.confirm(approved.currentVersion);
  const draft = await f.save([
    f.entry(approved, "approved", comment),
    { ...f.entry(separate, "changes_requested", mark.body, [mark]), separateComment: true },
    f.entry(mirrored, "changes_requested", mark.body, [mark]),
  ]);
  await f.submit(draft.revision);
  await f.restart();
  for (const user of [f.client, f.admin]) {
    const { materials: [a, b, c] } = await f.api(f.route, null, user);
    assert.deepEqual(a.returnComments.map(n => n.body), [comment]);
    assert.deepEqual(b.returnComments.map(n => n.body), [mark.body]);
    assert.deepEqual(b.notes.map(n => n.body), [mark.body]);
    assert.deepEqual(c.returnComments, []);
    assert.deepEqual(c.notes.map(n => n.body), [mark.body]);
  }
  await f.api(`/api/material-versions/${approved.currentVersion.id}/cancel`, {
    confirm: true, reason: "Перепроверить план.", expectedRevision: (await f.state()).materials[0].currentVersion.revision,
  }, f.admin);
  const reopened = (await f.state()).materials[0];
  const followup = await f.save([f.entry(reopened, null, "", [mark])]);
  await f.submit(followup.revision);
  await f.api(`/api/material-versions/${reopened.currentVersion.id}/decision`, {
    decision: "approved", confirm: true, comment: mark.body, expectedRevision: reopened.currentVersion.revision,
  }, f.client);
  const material = (await f.state()).materials[0];
  assert.deepEqual(material.returnComments.map(n => n.body), [mark.body, comment]);
});
test("two confirmed corrections on the returned file allow one new explicit approval and preserve the return", async (t) => {
  const f = await setup(t, 2);
  const [original, other] = (await f.state()).materials;
  const markers = [
    { page: 1, x: 0.22, y: 0.41, body: "Изменить ширину шкафа" },
    { page: 1, x: 0.65, y: 0.78, body: "Уточнить положение розетки" },
  ];
  const returned = await f.submit((await f.save([
    f.entry(original, "changes_requested", "Две поправки к плану", markers),
  ])).revision);
  const statementPath = `/api/approval-center/packages/${returned.packageId}`;
  const firstStatement = await f.api(statementPath, null, f.client);
  const material = async () => (await f.state()).materials.find(m => m.id === original.id);
  const versionId = original.currentVersion.id;
  const viewPath = `/api/approval-center/versions/${versionId}/view`;
  const noteEvent = async (index, type, body, actor, status = 200) => {
    const n = (await material()).notes[index];
    return f.api(`/api/approval-center/notes/${n.id}/events`,
      { type, body, expectedRevision: n.revision, versionId }, actor, "POST", status);
  };
  const awaitingFix = await material();
  assert.deepEqual(awaitingFix.notes.map(({ page, x, y, body }) => ({ page, x, y, body })), markers);
  assert.equal(awaitingFix.correctionApprovalRevision, null);
  await noteEvent(0, "fixed", "Уточнена ширина", f.admin);
  await noteEvent(1, "fixed", "Уточнено положение", f.admin);
  await noteEvent(0, "confirmed", "Проверено", f.client, 409);
  await f.api(viewPath, { page: 1 }, f.client);
  await noteEvent(0, "confirmed", "Проверено", f.client);
  assert.equal((await material()).canApproveAfterCorrection, false);
  await noteEvent(1, "confirmed", "Согласна с исправлением", f.client);
  const ready = await material();
  assert.equal(ready.currentVersion.status, "changes_requested");
  assert.equal(ready.canApproveAfterCorrection, true);
  assert.ok(ready.correctionApprovalRevision > 0);
  assert.equal(ready.currentVersion.file.review.correctionApprovalRevision, ready.correctionApprovalRevision);

  // A previous decision cannot be reversed by an ordinary or bulk draft.
  const ordinary = await f.save([f.entry(ready)]);
  await f.submit(ordinary.revision, randomUUID(), 409);
  const approval = { ...f.entry(ready), afterCorrection: ready.correctionApprovalRevision };
  const individual = await f.save([approval]);
  await f.submit(individual.revision, randomUUID(), 409);
  await f.api(viewPath, { confirm: true }, f.client);
  await noteEvent(1, "reopened", "Хочу ещё раз проверить", f.client);
  assert.equal((await material()).canApproveAfterCorrection, false);
  assert.equal((await f.state()).conflicts.length, 1);
  await f.submit(individual.revision, randomUUID(), 409);

  await noteEvent(1, "fixed", "Уточнение добавлено", f.admin);
  await noteEvent(1, "confirmed", "Проверено ещё раз", f.client);
  const updated = await material();
  assert.ok(updated.correctionApprovalRevision > ready.correctionApprovalRevision);
  await f.submit(individual.revision, randomUUID(), 409);
  assert.equal(f.rows("SELECT COUNT(*) AS n FROM approval_packages")[0].n, 1);
  await f.restart();
  assert.equal((await f.state()).draft.entries[0].afterCorrection, ready.correctionApprovalRevision);
  const finalDraft = await f.save([{ ...approval, afterCorrection: updated.correctionApprovalRevision }]);
  const operationId = randomUUID();
  const sent = await f.submit(finalDraft.revision, operationId);
  assert.equal((await f.submit(finalDraft.revision, operationId)).replayed, true);
  assert.notEqual(sent.packageId, returned.packageId);
  assert.deepEqual(await f.api(statementPath, null, f.client), firstStatement);
  const after = await material();
  assert.equal(after.currentVersion.status, "approved");
  assert.equal(after.canApproveAfterCorrection, false);
  assert.deepEqual(after.currentVersion.file.review.decisionHistory.map(e => e.type), ["changes_requested", "approved"]);
  assert.equal(after.notes.length, 2);
  const state = await f.state();
  assert.equal(state.stage.acceptedSeparately, false);
  assert.equal(state.materials.find(m => m.id === other.id).currentVersion.status, "pending_approval");
});
test("moving a returned file between stages keeps its history and scopes the new approval to its current stage", async (t) => {
  const f = await setup(t);
  const [original] = (await f.state()).materials;
  const v = original.currentVersion;
  const mark = { page: 1, x: 0.3, y: 0.5, body: "Уточнить размеры" };
  const returned = await f.submit((await f.save([f.entry(original, "changes_requested", "", [mark])])).revision);
  const nextStage = f.p.stages[1];
  await f.api(`/api/projects/${f.p.id}/files/${v.file.id}`,
    { stageId: nextStage.id, expectedStageId: f.s.id }, f.admin, "PATCH");
  const nextRoute = `/api/approval-center/projects/${f.p.id}/stages/${nextStage.id}`;
  const nextState = () => f.api(nextRoute, null, f.client);
  assert.equal((await f.state()).materials.length, 0);
  const [moved] = (await nextState()).materials;
  const [note] = moved.notes;
  const notePath = `/api/approval-center/notes/${note.id}/events`;
  await f.api(notePath, { type: "fixed", body: "Размеры уточнены", versionId: v.id,
    expectedRevision: note.revision }, f.admin);
  await f.confirm(v);
  await f.api(notePath, { type: "confirmed", body: "Проверено", versionId: v.id,
    expectedRevision: note.revision + 1 }, f.client);
  const ready = await nextState();
  assert.equal(ready.materials[0].canApproveAfterCorrection, true);
  const entries = [{ ...f.entry(ready.materials[0]), afterCorrection: ready.materials[0].correctionApprovalRevision }];
  const draft = await f.api(nextRoute + "/draft", { expectedRevision: ready.draft.revision, entries, position: {} }, f.client, "PUT");
  const accepted = await f.api(nextRoute + "/submit", { expectedRevision: draft.revision, operationId: randomUUID(), confirm: true }, f.client);
  const statement = (id) => f.api(`/api/approval-center/packages/${id}`, null, f.client);
  assert.equal((await statement(returned.packageId)).scope, f.s.id);
  assert.equal((await statement(accepted.packageId)).scope, nextStage.id);
  assert.equal((await nextState()).materials[0].currentVersion.status, "approved");
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
    const confirmNote = {
      type: "confirmed", body: "Исправление проверено",
      expectedRevision: note.revision, versionId: uploaded.review.versionId,
    };
    const notePath = `/api/approval-center/notes/${note.id}/events`;
    const viewPath = `/api/approval-center/versions/${uploaded.review.versionId}/view`;
    await f.api(notePath, confirmNote, f.client, "POST", 409);
    await f.api(viewPath, { page: 1 }, f.client);
    await f.api(notePath, confirmNote, f.client);
    await f.api(viewPath, { confirm: true }, f.client);
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
  assert.equal(current.stage.acceptedSeparately, false);
  assert.deepEqual(current.stage.blockers, []);
  const operationId = randomUUID();
  await f.api(
    f.route + "/approve-stage",
    { operationId, token: current.stage.token, confirm: true },
    f.client,
  );
  const accepted = (await f.state()).stage;
  assert.equal(accepted.approved, true);
  assert.equal(accepted.acceptedSeparately, true);
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
  // A response lost after the commit can be retried without losing the draft or increasing its revision.
  assert.deepEqual(await f.save(d.entries, 0), d);
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
test("a correction receipt belongs to one note, revision and fully displayed replacement file", async (t) => {
  const f = await setup(t, 0);
  async function uploadPlan(pageLabels, extra = {}) {
    const pdf = await PDFDocument.create();
    for (const label of pageLabels) pdf.addPage().drawText(label);
    return f.upload({
      name: "План.pdf", contentType: "application/pdf",
      data: Buffer.from(await pdf.save()).toString("base64"), ...extra,
    });
  }
  const readPage = (versionId, page, status = 200) =>
    f.api(`/api/approval-center/versions/${versionId}/view`, { page }, f.client, "POST", status);
  const receipt = (note, versionId) => ({
    type: "confirmed", body: "Проверила листы.", expectedRevision: note.revision, versionId,
  });
  const events = (note, action, status = 200, user = f.client) =>
    f.api(`/api/approval-center/notes/${note.id}/events`, action, user, "POST", status);
  const counters = () => f.rows(`SELECT
    (SELECT count(*) FROM approval_note_events) AS notes,
    (SELECT count(*) FROM review_events) AS history,
    (SELECT count(*) FROM review_notifications) AS notifications,
    (SELECT count(*) FROM approval_stage_events) AS stages`)[0];

  await uploadPlan(["A", "B", "C"]);
  const original = (await f.state()).materials[0];
  const firstVersion = original.currentVersion.id;
  for (const page of [1, 2, 3]) await readPage(firstVersion, page);
  await f.api(`/api/approval-center/versions/${firstVersion}/view`, { confirm: true }, f.client);
  const draft = await f.save([f.entry(original, "changes_requested", "Уточните размеры.", [
    { page: 1, x: 0.22, y: 0.35, body: "Размер на листе A" },
    { page: 2, x: 0.44, y: 0.58, body: "Размер на листе B" },
  ])]);
  await f.submit(draft.revision);
  const open = (await f.state()).materials[0].notes;
  const second = await uploadPlan(["B", "C", "A"], {
    materialId: original.id, expectedVersionId: firstVersion,
    correctionReport: { description: "Переставлены листы и указаны размеры.",
      resolutions: open.map((n) => ({ noteId: n.id, fixed: true, explanation: n.body + " уточнён." })) },
  });
  const secondVersion = second.review.versionId;
  const before = await f.state();
  const [a, b] = before.materials[0].notes;
  assert.equal(a.versionId, firstVersion);
  assert.equal(a.correctionVersionId, secondVersion);
  assert.equal(a.correctionVersionNumber, 2);
  assert.equal(a.correctionExplanation, a.body + " уточнён.");

  const confirmation = receipt(a, secondVersion);
  await events(a, { type: "confirmed", body: confirmation.body, expectedRevision: a.revision }, 400);
  await events(a, confirmation, 403, f.clients[1].cookie);
  await events(a, receipt(a, firstVersion), 409);
  await events(a, { type: "fixed", body: "Уточнено", expectedRevision: a.revision, versionId: firstVersion }, 409, f.admin);
  const preview = await f.request(`/api/files/${second.id}/preview`, null, f.client);
  assert.equal(preview.status, 200);
  await preview.arrayBuffer();
  await events(a, confirmation, 409);
  await readPage(secondVersion, 1);
  await events(a, confirmation, 409);
  await readPage(secondVersion, 4, 400);
  await readPage(secondVersion, 3);
  await events(a, confirmation, 409);
  await readPage(secondVersion, 2);

  const initialCounts = counters();
  await events(a, confirmation);
  const once = counters();
  assert.deepEqual(once, { notes: initialCounts.notes + 1, history: initialCounts.history + 1,
    notifications: initialCounts.notifications + 1, stages: initialCounts.stages });
  assert.equal((await events(a, confirmation)).replayed, true);
  await events(a, { ...confirmation, body: "Другое действие" }, 409);
  assert.deepEqual(counters(), once);
  const after = await f.state();
  assert.equal(after.stage.status, before.stage.status);
  assert.equal(after.stage.approved, false);
  const material = after.materials[0];
  assert.equal(material.currentVersion.status, before.materials[0].currentVersion.status);
  assert.equal(material.versions.find((v) => v.id === secondVersion).confirmedView, false);
  assert.deepEqual(material.notes.map((n) => n.status), ["confirmed", "fixed"]);

  const stale = receipt(b, secondVersion);
  const third = await uploadPlan(["A", "C", "B"], {
    materialId: original.id, expectedVersionId: secondVersion,
    correctionReport: { description: "Уточнён размер на листе B.",
      resolutions: [{ noteId: b.id, fixed: true, explanation: "Размер на листе B обновлён." }] },
  });
  const thirdVersion = third.review.versionId;
  const current = (await f.state()).materials[0].notes[1];
  assert.equal(current.id, b.id);
  assert.equal(current.correctionVersionId, thirdVersion);
  await events(b, stale, 409);
  await events(b, { ...stale, versionId: thirdVersion }, 409);
  await events(b, { ...stale, expectedRevision: current.revision }, 409);
  for (const page of [1, 2, 3]) await readPage(thirdVersion, page);
  await events(b, { type: "reply", body: "Приложен ответ студии.", expectedRevision: current.revision,
    versionId: thirdVersion }, 200, f.admin);
  await events(b, receipt(current, thirdVersion), 409);
  assert.equal((await f.state()).materials[0].notes[1].status, "fixed");

  // Older events can legitimately lack a version. An earlier known fix must
  // not be used as evidence for a later, unbound assertion.
  const db = new DatabaseSync(join(f.dataDir, "itd.sqlite"));
  try {
    const actor = current.history.findLast((e) => e.type === "fixed").actorId;
    db.prepare("INSERT INTO approval_note_events(noteId,actorId,type,body,versionId,createdAt) VALUES(?,?,'fixed',?,NULL,?)")
      .run(b.id, actor, "Старая отметка без версии", Date.now());
    db.prepare("UPDATE approval_notes SET revision=revision+1 WHERE id=?").run(b.id);
  } finally {
    db.close();
  }
  const legacy = (await f.state()).materials[0].notes[1];
  assert.equal(legacy.correctionVersionId, null);
  await events(legacy, receipt(legacy, thirdVersion), 409);
});
test("PDF requires all real pages plus explicit confirmation; malformed coordinates and unread approvals rejected", async (t) => {
  const f = await setup(t, 0),
    pdf = await PDFDocument.create();
  for (let page = 1; page <= 5; page++) pdf.addPage();
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
  await f.api(path, { page: 5 }, f.client);
  const refreshed = (await f.state()).materials[0];
  const sparse = refreshed.versions.find((v) => v.id === refreshed.currentVersion.id);
  assert.deepEqual(sparse.viewedPageNumbers, [1, 5]);
  assert.equal(sparse.viewedPages, 2);
  assert.equal(sparse.pageCount, 5);
  assert.equal(sparse.confirmedView, false);
  await f.api(path, { confirm: true }, f.client, "POST", 409);
  await f.api(path, { page: 6 }, f.client, "POST", 400);
  for (const page of [2, 3, 4]) await f.api(path, { page }, f.client);
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
  await f.api(`/api/stages/${f.s.id}`, { status: "approved" }, f.admin, "PATCH");
  const manual = (await f.state()).stage;
  assert.equal(manual.approved, true);
  assert.equal(manual.acceptedSeparately, false);
});
test("designer publishes selected existing files atomically with one notification and stable retry", async (t) => {
  const f = await setup(t, 0),
    files = [];
  for (let i = 0; i < 10; i++)
    files.push(await f.upload({ name: `Публикация-${i}.png`, review: false }));
  const request = {
    fileIds: files.map((f) => f.id).reverse(),
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
  const ordered = (await f.state()).materials;
  assert.deepEqual(ordered.map((m) => m.currentVersion.file.id), files.map((file) => file.id));
  const first = ordered[0];
  await f.upload({ materialId: first.id, expectedVersionId: first.currentVersion.id, name: "Первый-v2.png" });
  await f.restart();
  const revised = (await f.state()).materials;
  assert.deepEqual(revised.map((m) => m.id), ordered.map((m) => m.id));
  assert.equal(revised[0].currentVersion.versionNumber, 2);
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

import test from "node:test";
import assert from "node:assert/strict";
import "./project-state.js";
import "./project-files.js";
const { entries, select } = globalThis.ITDProjectFiles;
const project = {
  stages: [{ id: 1, title: "Планировка" }],
  files: [
    {
      id: 1,
      name: "scan-old.pdf",
      contentType: "application/pdf",
      category: "result",
      stageId: 1,
      size: 100,
      review: {
        materialId: 7,
        versionId: 9,
        versionNumber: 1,
        isCurrent: false,
        status: "approved",
      },
    },
    {
      id: 2,
      name: "camera-current.jpg",
      contentType: "image/jpeg",
      category: "result",
      stageId: 1,
      size: 200,
      review: {
        materialId: 7,
        versionId: 10,
        versionNumber: 2,
        isCurrent: true,
        status: "pending_approval",
      },
    },
    {
      id: 3,
      name: "technical.pdf",
      contentType: "application/pdf",
      category: "document",
      stageId: null,
      size: 300,
      document: {
        title: "Договор на проект",
        kind: "Договор",
        number: "Д-12",
        date: "2026-11-12",
      },
    },
    {
      id: 4,
      name: "render.jpg",
      contentType: "image/jpeg",
      category: "result",
      stageId: null,
      size: 400,
    },
    {
      id: 5,
      name: "estimate.pdf",
      contentType: "application/pdf",
      category: "document",
      stageId: 1,
      size: 500,
      document: {
        title: "Смета отделки",
        kind: "Смета",
        number: "С-3",
        date: "2026-10-10",
      },
    },
  ],
};
test("one material per version group, every stored file remains represented and source is immutable", () => {
  const before = structuredClone(project),
    e = entries(project);
  assert.equal(e.length, 4);
  assert.equal(e.find((x) => x.key === "material-7").file.id, 2);
  assert.deepEqual(
    e.flatMap((x) => x.versions.map((f) => f.id)).sort(),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(project, before);
});
test("logical document title and separate metadata survive projection", () => {
  const d = entries(project).find((e) => e.file.id === 3);
  assert.equal(d.title, "Договор на проект");
  assert.equal(d.file.name, "technical.pdf");
  assert.equal(d.file.document.number, "Д-12");
});
test("search finds document number, title and historical filenames without duplicating versions", () => {
  const e = entries(project);
  assert.equal(select(e, { query: "д-12" })[0].file.id, 3);
  const old = select(e, { query: "SCAN-OLD" });
  assert.equal(old.length, 1);
  assert.equal(old[0].matchFile.id, 1);
  assert.equal(old[0].file.id, 2);
  assert.equal(select(e, { query: "нет такого" }).length, 0);
});
test("category, stage and type filters combine without changing the original catalog", () => {
  const e = entries(project);
  assert.deepEqual(
    select(e, { category: "document", stage: "1", type: "kind:Смета" }).map(
      (x) => x.file.id,
    ),
    [5],
  );
  assert.deepEqual(
    select(e, { stage: "unassigned" }).map((x) => x.file.id),
    [4, 3],
  );
  assert.deepEqual(
    select(e, { type: "images" }).map((x) => x.file.id),
    [4, 2],
  );
  assert.equal(e.length, 4);
});
test("sorts use upload order and real document date, never invented timestamps", () => {
  const e = entries(project);
  assert.deepEqual(
    select(e, { category: "document", sort: "document-date" }).map(
      (x) => x.file.id,
    ),
    [3, 5],
  );
  assert.deepEqual(
    select(e, { sort: "oldest" }).map((x) => x.file.id),
    [2, 3, 4, 5],
  );
  assert.deepEqual(
    select(e, { sort: "name" }).map((x) => x.title),
    [...e.map((x) => x.title)].sort((a, b) => a.localeCompare(b, "ru")),
  );
});
test("legacy unassigned files and missing current flag stay accessible", () => {
  const p = structuredClone(project);
  p.files[1].review.isCurrent = false;
  p.files.push({
    id: 6,
    name: "legacy.pdf",
    category: "document",
    contentType: "application/pdf",
    size: 50,
    stageId: null,
  });
  const e = entries(p);
  assert.equal(e.length, 5);
  assert.equal(e.find((e) => e.key === "material-7").file.id, 2);
  assert.equal(e.find((e) => e.file.id === 6).title, "legacy");
});
test("legacy documents without requisites remain available through their displayed type filter", () => {
  const e = entries({
    stages: [],
    files: [
      {
        id: 1,
        name: "old.pdf",
        category: "document",
        contentType: "application/pdf",
        stageId: null,
        size: 50,
      },
    ],
  });
  assert.equal(
    select(e, { category: "document", type: "kind:Документ" }).length,
    1,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import "./project-state.js";
const { currentStage, selectedStage, progress, materialLabel } = globalThis.ITDProjectState;
const stages = (statuses) =>
  statuses.map((status, id) => ({
    id: id + 1,
    status,
    title:
      id === 0
        ? "Обмеры"
        : id === 1
          ? "Планировочное решение"
          : "Этап " + (id + 1),
  }));
test("seven-stage regression: approved measurements never outrank work in progress", () => {
  const input = stages([
      "approved",
      "in_progress",
      ...Array(5).fill("planned"),
    ]),
    snapshot = structuredClone(input);
  assert.equal(currentStage(input).id, 2);
  assert.deepEqual(progress(input), {
    approved: 1,
    completed: 0,
    accepted: 1,
    total: 7,
    percent: 14,
    label: "Согласовано или завершено: 1 из 7 этапов",
    detail: "Согласовано: 1 · Завершено: 0",
  });
  assert.deepEqual(input, snapshot);
});
for (const [statuses, expected] of [
  [["approved", "planned", "in_progress"], 3],
  [["pending_approval", "in_progress"], 2],
  [["approved", "changes_requested", "in_progress"], 2],
  [["in_progress", "changes_requested"], 1],
  [["approved", "pending_approval", "planned"], 2],
  [["approved", "planned"], 2],
  [["approved", "completed"], null],
  [[], null],
  [["unknown", "planned"], 2],
])
  test("current-stage priority " + statuses.join("/"), () =>
    assert.equal(currentStage(stages(statuses))?.id || null, expected),
  );
test("accepted progress is not a completed-stage count and never counts a stage twice", () => {
  for (const [input, expected] of [
    [
      ["approved", "completed", "planned"],
      [2, 1, 1, 67],
    ],
    [
      ["approved", "approved"],
      [2, 2, 0, 100],
    ],
    [["completed"], [1, 0, 1, 100]],
    [[], [0, 0, 0, 0]],
    [
      ["changes_requested", "pending_approval", "in_progress", "planned"],
      [0, 0, 0, 0],
    ],
  ]) {
    const p = progress(stages(input));
    assert.deepEqual(
      [p.accepted, p.approved, p.completed, p.percent],
      expected,
    );
  }
});
test("overview selection distinguishes the default, a deliberately empty stage and unassigned files", () => {
  const all = stages(["planned", "in_progress", "completed"]);
  assert.equal(selectedStage(all)?.id, 2);
  assert.equal(selectedStage(all, null)?.id, 2);
  assert.equal(selectedStage(all, 1)?.id, 1);
  assert.equal(selectedStage(all, 0), null);
  assert.equal(selectedStage([], null), null);
});
test("logical labels stay separate from real filenames and remain stable between versions", () => {
  const stage = { title: "Обмеры" },
    file = { id: 12, name: "CAMERA_EXPORT_V2.pdf", review: { materialId: 3 } };
  assert.equal(
    materialLabel({ title: "План потолка", file, stage }),
    "План потолка",
  );
  assert.equal(
    materialLabel({ title: "CAMERA_EXPORT_V1.jpg", file, stage }),
    "Материал №3",
  );
  assert.equal(
    materialLabel({ file, stage }),
    materialLabel({ file: { ...file, id: 20, name: "v3.jpg" }, stage }),
  );
  assert.equal(file.name, "CAMERA_EXPORT_V2.pdf");
  assert.equal(materialLabel({}), "Материал проекта");
});
test("ordinary filenames keep their readable stem and replacement files keep the original title", () => {
  const original = "План кухни. Итоговая версия.лист 3.pdf";
  const file = { id: 19, name: "Заменённый файл.pdf", review: { materialId: 5, title: original, originalName: original } };
  assert.equal(materialLabel({ file }), "План кухни. Итоговая версия.лист 3");
  assert.equal(materialLabel({ file, title: "Расстановка мебели. Вариант 2" }), "Расстановка мебели. Вариант 2");
  for (const stem of ["План кухни", "План спальни", "Развёртка стен гостиной с указанием отметок и чистовых материалов"]) {
    assert.equal(materialLabel({ file: { name: stem + ".pdf" } }), stem);
  }
  for (const name of ["IMG_20261119.jpg", "c1526f9a-676a-4b73-81fc-8b1766473990.pdf", "0123456789abcdef01234567.pdf", "123456.jpg", "v2.pdf"]) {
    assert.equal(materialLabel({ file: { ...file, review: { materialId: 5, title: name, originalName: name } } }), "Материал №5");
  }
});

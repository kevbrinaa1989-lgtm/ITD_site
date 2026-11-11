import test from "node:test";
import assert from "node:assert/strict";
import "./project-state.js";
const { currentStage, progress, materialLabel } = globalThis.ITDProjectState;
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
test("logical labels stay separate from real filenames and remain stable between versions", () => {
  const stage = { title: "Обмеры" },
    file = { id: 12, name: "CAMERA_EXPORT_V2.pdf", review: { materialId: 3 } };
  assert.equal(
    materialLabel({ title: "План потолка", file, stage }),
    "План потолка",
  );
  assert.equal(
    materialLabel({ title: "CAMERA_EXPORT_V1.jpg", file, stage }),
    "Обмеры · Материал №3",
  );
  assert.equal(
    materialLabel({ file, stage }),
    materialLabel({ file: { ...file, id: 20, name: "v3.jpg" }, stage }),
  );
  assert.equal(file.name, "CAMERA_EXPORT_V2.pdf");
  assert.equal(materialLabel({}), "Материал проекта");
});

"use strict";
// Pure presentation rules. Never writes to the API or changes stage statuses.
(() => {
  function currentStage(stages = []) {
    return (
      stages.find((s) =>
        ["in_progress", "changes_requested"].includes(s.status),
      ) ||
      stages.find((s) => s.status === "pending_approval") ||
      stages.find((s) => s.status === "planned") ||
      null
    );
  }
  function selectedStage(stages = [], id) {
    if (id == null) return currentStage(stages);
    return stages.find((stage) => stage.id === id) || null;
  }
  function progress(stages = []) {
    const approved = stages.filter((s) => s.status === "approved").length;
    const completed = stages.filter((s) => s.status === "completed").length;
    const accepted = approved + completed,
      total = stages.length;
    return {
      approved,
      completed,
      accepted,
      total,
      percent: total ? Math.round((accepted / total) * 100) : 0,
      label: total
        ? `Согласовано или завершено: ${accepted} из ${total} этапов`
        : "Этапы пока не добавлены",
      detail: `Согласовано: ${approved} · Завершено: ${completed}`,
    };
  }
  function readableName(value) {
    if (!/\p{L}/u.test(value)) return false;
    // Camera exports, storage keys and bare revision numbers are poor titles for people.
    return !/^(?:[a-f\d]{16,}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|v\d+)$/i.test(value)
      && !/^(?:camera[_-]export(?:[_-]|$)|(?:img|dsc[f_n]?|pxl|vid|scan|screenshot|image|file)(?:$|[ _-]*\d))/i.test(value);
  }
  function materialLabel({ title, file, originalName } = {}) {
    const source = String(file?.review?.originalName || originalName || file?.name || "").trim();
    const logical = String(title || file?.review?.title || "").trim();
    const withoutExtension = (name) => name.replace(/\.[^.\s/\\]+$/u, "").trim();
    if (logical && logical !== source && readableName(withoutExtension(logical))) return logical;
    const name = withoutExtension(source);
    if (readableName(name)) return name;
    const id = file?.review?.materialId || file?.id;
    return id ? "Материал №" + id : "Материал проекта";
  }
  globalThis.ITDProjectState = Object.freeze({
    currentStage,
    selectedStage,
    progress,
    materialLabel,
  });
})();

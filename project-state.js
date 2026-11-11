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
  function materialLabel({ title, file, stage } = {}) {
    const logical = String(title || "").trim();
    // Legacy material titles were initialized from the first uploaded filename.
    // Do not guess a human title by stripping a technical filename's extension.
    if (
      logical &&
      logical !== file?.name &&
      !/\.[a-z0-9]{2,8}$/i.test(logical) &&
      !/^(?:[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f-]{27,})$/i.test(logical)
    )
      return logical;
    const id = file?.review?.materialId || file?.id;
    return `${stage?.title || "Материал проекта"}${id ? ` · Материал №${id}` : ""}`;
  }
  globalThis.ITDProjectState = Object.freeze({
    currentStage,
    progress,
    materialLabel,
  });
})();

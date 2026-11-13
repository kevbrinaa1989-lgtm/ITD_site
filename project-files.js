"use strict";
// Read-only library projection. A material owns its versions; stored rows stay intact.
(() => {
  const format = (f) =>
    f.contentType === "application/pdf"
      ? "PDF"
      : f.contentType?.startsWith("image/")
        ? f.contentType === "image/jpeg"
          ? "JPG"
          : f.contentType.split("/")[1].toUpperCase()
        : (f.name.split(".").pop() || "FILE").toUpperCase();
  const size = (n) =>
    n >= 1048576
      ? `${(n / 1048576).toFixed(1)} МБ`
      : `${Math.max(0.1, n / 1024).toFixed(1)} КБ`;
  function entries(project) {
    const groups = new Map();
    for (const file of project.files || []) {
      const key = file.review
        ? `material-${file.review.materialId}`
        : `file-${file.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(file);
    }
    return [...groups].map(([key, versions]) => {
      const ordered = [...versions].sort(
        (a, b) =>
          (b.review?.versionNumber || 0) - (a.review?.versionNumber || 0) ||
          b.id - a.id,
      );
      const file = ordered.find((f) => f.review?.isCurrent) || ordered[0];
      const stage = project.stages.find((s) => s.id === file.stageId);
      const document = file.category === "document";
      return {
        key,
        file,
        versions: ordered,
        stage,
        document,
        title: document
          ? file.document?.title || file.name.replace(/\.[^.]+$/, "")
          : globalThis.ITDProjectState.materialLabel({
              title: file.review?.title,
              file,
              stage,
            }),
        type: format(file),
        status: file.review?.status || null,
      };
    });
  }
  const normalize = (v) =>
    String(v || "")
      .normalize("NFKC")
      .toLocaleLowerCase("ru-RU")
      .replace(/ё/g, "е")
      .trim();
  function select(
    items,
    {
      category = "all",
      query = "",
      stage = "",
      type = "",
      sort = "newest",
    } = {},
  ) {
    const needle = normalize(query);
    return items
      .filter(
        (e) =>
          (category === "all" || e.file.category === category) &&
          (!stage ||
            (stage === "unassigned"
              ? e.file.stageId == null
              : String(e.file.stageId) === stage)) &&
          (!type ||
            (type.startsWith("kind:")
              ? e.document &&
                (e.file.document?.kind || "Документ") === type.slice(5)
              : type === "images"
                ? e.file.contentType.startsWith("image/")
                : type === "pdf"
                  ? e.type === "PDF"
                  : !e.file.contentType.startsWith("image/") &&
                    e.type !== "PDF")),
      )
      .map((e) => ({
        ...e,
        matchFile: needle
          ? e.versions.find((f) => normalize(f.name).includes(needle))
          : null,
      }))
      .filter(
        (e) =>
          !needle ||
          normalize(
            [
              e.title,
              e.stage?.title,
              e.file.document?.kind,
              e.file.document?.number,
            ].join(" "),
          ).includes(needle) ||
          e.matchFile,
      )
      .sort((a, b) =>
        sort === "name"
          ? a.title.localeCompare(b.title, "ru") || a.file.id - b.file.id
          : sort === "document-date"
            ? (b.file.document?.date || "").localeCompare(
                a.file.document?.date || "",
              ) || b.file.id - a.file.id
            : sort === "oldest"
              ? a.file.id - b.file.id
              : b.file.id - a.file.id,
      );
  }
  globalThis.ITDProjectFiles = Object.freeze({ entries, select, format, size });
})();

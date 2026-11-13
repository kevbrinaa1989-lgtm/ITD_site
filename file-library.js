"use strict";
(() => {
  const { node, button } = window.ITDUI,
    model = window.ITDProjectFiles;
  const $ = (id) => document.getElementById(id);
  const labels = {
    pending_approval: "На согласовании",
    changes_requested: "Нужны изменения",
    approved: "Согласован",
  };
  const states = new Map();
  let h,
    project,
    album = false,
    detailFileId = null,
    opener;
  const state = () => {
    if (!states.has(project.id))
      states.set(project.id, {
        category: "all",
        query: "",
        stage: "",
        type: "",
        sort: "newest",
      });
    return states.get(project.id);
  };
  const meta = (text) => node("p", text, "library-meta");
  function link(file) {
    const a = node("a", "Скачать", "library-download");
    a.href = `/api/files/${file.id}/download`;
    a.download = file.name;
    a.setAttribute("aria-label", `Скачать: ${file.name}`);
    return a;
  }
  function badge(e) {
    const b = node(
      "span",
      labels[e.status] || "Без согласования",
      "library-status",
    );
    b.dataset.status = e.status || "ordinary";
    return b;
  }
  function fileType(e) {
    const icon = node("span", e.type, "library-file-type");
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }
  function openReview(file) {
    const position = scrollY;
    h.openMaterial(file, () => {
      h.selectTab("files");
      requestAnimationFrame(() => scrollTo(0, position));
    }).catch((error) => h.message(error.message, true));
  }
  function actions(e) {
    const box = node("div", undefined, "library-item-actions");
    box.append(link(e.file));
    if (h.getUser()?.role === "admin" && !e.file.review) {
      const menu = node("details", undefined, "library-more");
      menu.append(node("summary", "Действия"));
      const content = node("div", undefined, "library-more-content");
      if (!e.document) content.append(window.ITDReview.sendControl(e.file));
      content.append(h.deleteControl(e.file, content));
      menu.append(content);
      box.append(menu);
    }
    return box;
  }
  // A photo opens with all current images from its own stage, regardless of
  // library search/category filters. Other projects and older versions are excluded.
  function stageImages(file) {
    return model.select(model.entries(project), {
      category: "result",
      stage: file.stageId == null ? "unassigned" : String(file.stageId),
      sort: state().sort,
    }).filter((entry) => window.ITDViewer.image(entry.file))
      .map((entry) => entry.file);
  }
  function material(e) {
    const file = e.matchFile || e.file;
    let card;
    if (window.ITDViewer.image(e.file)) {
      const historical = file.id !== e.file.id;
      card = window.ITDViewer.thumbnail(
        e.file,
        stageImages(e.file),
        historical
          ? { onOpen: () => openReview(file), label: `Открыть версию: ${e.title}` }
          : { label: `Открыть фото: ${e.title}` },
      );
      card.querySelector(".gallery-caption").remove();
    } else {
      card = node("article", undefined, "gallery-card");
      const open = e.file.review
        ? button("", () => openReview(file))
        : window.ITDViewer.supported(file)
          ? window.ITDViewer.control(file, [file], "")
          : button("", () => documentDetail(e));
      open.className = "gallery-open library-format-cover";
      open.setAttribute("aria-label", `Открыть материал: ${e.title}`);
      open.append(fileType(e), node("span", "Материал проекта"));
      card.append(open);
    }
    card.classList.add("library-material");
    card.dataset.libraryKey = e.key;
    card.dataset.fileId = e.file.id;
    const copy = node("div", undefined, "library-material-copy");
    const title = node("h3", e.title);
    title.title = e.title;
    copy.append(
      title,
      meta(
        `${e.type} · ${model.size(e.file.size)}${e.file.review ? ` · Версия ${e.file.review.versionNumber}` : ""}`,
      ),
      badge(e),
    );
    if (e.file.review)
      copy.append(
        button(
          e.versions.length > 1
            ? `${e.versions.length} версии · комментарии и согласование`
            : "Комментарии и согласование",
          () => openReview(file),
          "library-history",
        ),
      );
    if (e.matchFile && e.matchFile.id !== e.file.id)
      copy.append(
        meta(
          `Найдено в версии ${e.matchFile.review.versionNumber}: ${e.matchFile.name}`,
        ),
      );
    copy.append(actions(e));
    card.append(copy);
    return card;
  }
  function documentRow(e) {
    const row = node("article", undefined, "library-document document-card");
    row.dataset.libraryKey = e.key;
    row.dataset.fileId = e.file.id;
    const copy = node("div", undefined, "library-document-copy");
    const title = node("h3", e.title);
    title.title = e.title;
    const d = e.file.document;
    copy.append(
      title,
      meta(
        [
          d?.kind || "Документ",
          d?.number ? `№ ${d.number}` : "",
          d?.date
            ? new Date(d.date + "T12:00:00").toLocaleDateString("ru-RU")
            : "",
        ]
          .filter(Boolean)
          .join(" · "),
      ),
      meta(`${e.stage?.title || "Без этапа"} · ${model.size(e.file.size)}`),
    );
    const controls = node("div", undefined, "library-document-actions");
    controls.append(
      button("Открыть", () => documentDetail(e), "library-document-open"),
      link(e.file),
    );
    row.append(fileType(e), copy, controls);
    return row;
  }
  function documentDetail(e) {
    const dialog = $("library-document-dialog"),
      host = $("library-document-detail");
    opener = document.activeElement;
    detailFileId = e.file.id;
    host.replaceChildren();
    const title = node("h2", e.title);
    title.id = "library-document-title";
    host.append(
      node("p", e.document ? "Документ проекта" : "Файл проекта", "eyebrow"),
      title,
    );
    const fields = node("dl", undefined, "library-document-fields"),
      d = e.file.document;
    for (const [label, value] of [
      ["Вид", d?.kind],
      ["Номер", d?.number],
      [
        "Дата",
        d?.date
          ? new Date(d.date + "T12:00:00").toLocaleDateString("ru-RU")
          : "",
      ],
      ["Этап", e.stage?.title || "Без привязки к этапу"],
      ["Формат", e.type],
      ["Размер", model.size(e.file.size)],
      ["Имя файла", e.file.name],
    ])
      if (value) fields.append(node("dt", label), node("dd", value));
    host.append(fields);
    const controls = node("div", undefined, "library-detail-actions");
    if (window.ITDViewer.supported(e.file))
      controls.append(
        window.ITDViewer.control(e.file, [e.file], "Предпросмотр"),
      );
    else
      host.append(
        meta(
          "Предпросмотр этого формата недоступен. Скачайте оригинал, чтобы открыть его на устройстве.",
        ),
      );
    controls.append(link(e.file));
    if (h.getUser()?.role === "admin")
      controls.append(h.deleteControl(e.file, controls));
    host.append(controls);
    if (!dialog.open) dialog.showModal();
  }
  function render() {
    if (!project) return;
    const all = model.entries(project),
      s = state(),
      items = model.select(all, s);
    const materials = items.filter((e) => !e.document),
      documents = items.filter((e) => e.document);
    const imageCount = materials.filter((e) =>
      window.ITDViewer.image(e.file),
    ).length;
    $("library-album-toggle").hidden = !imageCount;
    $("library-album-toggle").textContent = album
      ? "← К библиотеке"
      : "Смотреть альбом";
    $("library-upload").hidden = h.getUser()?.role !== "admin";
    $("library-count").textContent =
      `Материалов: ${all.filter((e) => !e.document).length} · Документов: ${all.filter((e) => e.document).length}`;
    $("library-results-count").textContent =
      `Найдено: ${items.length}${all.some((e) => e.versions.length > 1) ? " · Предыдущие версии — в истории материалов" : ""}`;
    for (const b of document.querySelectorAll("[data-library-category]")) {
      const selected = b.dataset.libraryCategory === s.category;
      b.setAttribute("aria-pressed", String(selected));
      b.classList.toggle("is-active", selected);
    }
    for (const [id, key] of [
      ["library-search", "query"],
      ["library-stage", "stage"],
      ["library-type", "type"],
      ["library-sort", "sort"],
    ])
      $(id).value = s[key];
    $("library-filters").open ||= !!s.stage || !!s.type;
    const list = $("library-content");
    window.ITDViewer.releaseWithin(list);
    list.replaceChildren();
    $("library-empty").hidden = items.length > 0;
    $("library-empty-text").textContent = all.length
      ? "По этим условиям файлы не найдены. Измените поиск или сбросьте фильтры."
      : h.getUser()?.role === "admin"
        ? "Загрузите первые материалы или документы проекта."
        : "Здесь появятся материалы и документы, опубликованные студией.";
    $("library-reset").hidden = !all.length;
    if (album && imageCount) {
      list.hidden = true;
      window.ITDGallery.render({
        ...project,
        files: materials.map((e) => e.file),
      });
      $("project-gallery").hidden = false;
      return;
    }
    album = false;
    list.hidden = false;
    window.ITDViewer.releaseWithin($("project-gallery"));
    $("project-gallery").replaceChildren();
    $("project-gallery").hidden = true;
    if (materials.length) {
      const section = node("section", undefined, "library-materials");
      section.append(
        node(
          "h3",
          "Материалы проекта",
          `library-section-title${s.category === "result" ? " sr-only" : ""}`,
        ),
      );
      const stages = [...project.stages.map((s) => s.id), null];
      for (const id of stages) {
        const group = materials.filter((e) => (e.stage?.id ?? null) === id);
        if (!group.length) continue;
        const heading = node("div", undefined, "library-stage-heading");
        heading.append(
          node("h4", group[0].stage?.title || "Без привязки к этапу"),
          node("span", String(group.length)),
        );
        const grid = node("div", undefined, "library-grid");
        grid.append(...group.map((e) => material(e)));
        section.append(heading, grid);
      }
      list.append(section);
    }
    if (documents.length) {
      const section = node("section", undefined, "library-documents");
      section.append(
        node(
          "h3",
          "Документы",
          `library-section-title${s.category === "document" ? " sr-only" : ""}`,
        ),
        ...documents.map(documentRow),
      );
      list.append(section);
    }
  }
  function setProject(next) {
    const changed = project?.id !== next?.id;
    project = next;
    if (changed) {
      album = false;
      closeDocument();
    }
    if (!project) {
      window.ITDViewer.releaseWithin($("library-content"));
      $("library-content").replaceChildren();
      $("project-gallery").replaceChildren();
      return;
    }
    const s = state();
    $("library-stage").replaceChildren(
      new Option("Все этапы", ""),
      new Option("Без этапа", "unassigned"),
      ...project.stages.map((s) => new Option(s.title, String(s.id))),
    );
    const kinds = [
      ...new Set(
        project.files
          .filter((f) => f.category === "document")
          .map((f) => f.document?.kind || "Документ"),
      ),
    ];
    $("library-type").replaceChildren(
      new Option("Все типы", ""),
      new Option("Изображения", "images"),
      new Option("PDF", "pdf"),
      new Option("Другие форматы", "other"),
      ...kinds.map((k) => new Option(k, "kind:" + k)),
    );
    if (![...$("library-stage").options].some((o) => o.value === s.stage))
      s.stage = "";
    if (![...$("library-type").options].some((o) => o.value === s.type))
      s.type = "";
    if (detailFileId && !project.files.some((f) => f.id === detailFileId))
      closeDocument();
    render();
  }
  function closeDocument() {
    if ($("library-document-dialog")?.open)
      $("library-document-dialog").close();
    detailFileId = null;
  }
  function category(value) {
    if (project) {
      state().category = value;
      album = false;
      render();
    }
  }
  function init(hooks) {
    h = hooks;
    for (const b of document.querySelectorAll("[data-library-category]"))
      b.addEventListener("click", () => category(b.dataset.libraryCategory));
    for (const [id, key, event] of [
      ["library-search", "query", "input"],
      ["library-stage", "stage", "change"],
      ["library-type", "type", "change"],
      ["library-sort", "sort", "change"],
    ])
      $(id).addEventListener(event, () => {
        state()[key] = $(id).value;
        album = false;
        render();
      });
    $("library-upload").addEventListener("click", () =>
      h.openUpload(
        state().stage && state().stage !== "unassigned"
          ? Number(state().stage)
          : null,
        state().category === "document" ? "document" : "result",
      ),
    );
    $("library-album-toggle").addEventListener("click", () => {
      album = !album;
      render();
    });
    $("library-reset").addEventListener("click", () => {
      Object.assign(state(), { query: "", stage: "", type: "" });
      render();
    });
    $("library-document-close").addEventListener("click", closeDocument);
    $("library-document-dialog").addEventListener("close", () => {
      detailFileId = null;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    });
  }
  window.ITDLibrary = {
    init,
    setProject,
    category,
    filterStage: (id) => {
      state().category = "all";
      state().stage = String(id);
      state().query = "";
      state().type = "";
      album = false;
      render();
    },
    onTab: (tab) => {
      if (tab !== "files") closeDocument();
    },
    reset: () => {
      closeDocument();
      states.clear();
      project = null;
      album = false;
    },
  };
})();

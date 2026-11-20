"use strict";
(() => {
  const { node, button } = window.ITDUI,
    model = window.ITDProjectFiles;
  const $ = (id) => document.getElementById(id);
  const labels = {
    pending_approval: "На согласовании",
    changes_requested: "На доработку",
    approved: "Согласован",
  };
  const states = new Map();
  let h,
    project,
    album = false,
    detailFileId = null,
    opener,
    scopeFiles = null,
    scopeEpoch = 0;
  const state = () => {
    if (!states.has(project.id))
      states.set(project.id, {
        category: "all",
        query: "",
        stage: "unassigned",
        type: "",
        sort: "oldest",
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
  function reviewStatus(review) {
    if (!review) return "Без согласования";
    const studio = h.getUser()?.role === "admin";
    if (review.canApproveAfterCorrection)
      return studio ? "Ожидает согласования клиента" : "Можно согласовать";
    if (review.status === "pending_approval" && review.versionNumber > 1)
      return studio ? "Ожидает проверки клиента" : "Проверить исправления";
    return labels[review.status] || "Без согласования";
  }
  function badge(e) {
    const b = node("span", reviewStatus(e.file.review), "library-status");
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
    return h.openMaterial(file, () => {
      h.selectTab("files");
      requestAnimationFrame(() => scrollTo(0, position));
    }).catch((error) => h.message(error.message, true));
  }
  function actions(e) {
    const box = node("div", undefined, "library-item-actions");
    box.append(link(e.file));
    if (h.getUser()?.role === "admin") {
      const menu = node("details", undefined, "library-more");
      menu.append(node("summary", "Действия"));
      const content = node("div", undefined, "library-more-content");
      if (!e.document) content.append(window.ITDReview.sendControl(e.file));
      content.append(
        button(
          "Переименовать / переместить",
          () => editFile(e),
          "library-edit",
        ),
        h.deleteControl(e.file, content),
      );
      menu.append(content);
      box.append(menu);
    }
    return box;
  }
  // A photo opens with all current images from its own stage, regardless of
  // library search/category filters. Other projects and older versions are excluded.
  function stageImages(file) {
    return model
      .select(
        model.entries({ ...project, files: scopeFiles ?? project.files }),
        {
          category: "result",
          stage: file.stageId == null ? "unassigned" : String(file.stageId),
          sort: state().sort,
        },
      )
      .filter((entry) => window.ITDViewer.image(entry.file))
      .map((entry) => entry.file);
  }
  function material(e) {
    const file = e.file;
    let card;
    if (window.ITDViewer.image(e.file)) {
      card = window.ITDViewer.thumbnail(
        file,
        stageImages(file),
        { label: `Открыть фото: ${e.title}` },
      );
      if (e.versions.some((version) => version.contentType === "application/pdf"))
        card.classList.add("library-plan-preview");
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
      open.append(e.file.contentType === "application/pdf"
        ? window.ITDApprovalThumbnails.mount(e.file, { width: 480, height: 360 })
        : fileType(e));
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
    if (!e.file.review || e.versions.length > 1) copy.append(meta(e.file.name));
    if (e.file.review)
      copy.append(
        button(
          e.versions.length > 1
            ? `Версии · ${e.versions.length} · комментарии и согласование`
            : "Комментарии и согласование",
          () => openReview(file),
          "library-history",
        ),
      );
    if (e.matchFile && e.matchFile.id !== e.file.id)
      copy.append(
        button(
          `Открыть архивную версию ${e.matchFile.review.versionNumber} · ${e.matchFile.name}`,
          () => openReview(e.matchFile),
          "library-archive-match",
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
      controls.append(
        button(
          "Переименовать / переместить",
          () => editFile(e),
          "library-edit",
        ),
        h.deleteControl(e.file, controls),
      );
    host.append(controls);
    if (!dialog.open) dialog.showModal();
  }
  function render() {
    if (!project) return;
    const s = state(),
      all = model.entries({
        ...project,
        files: (scopeFiles ?? project.files).filter(
          (f) =>
            (f.stageId == null ? "unassigned" : String(f.stageId)) === s.stage,
        ),
      }),
      items = model.select(all, s);
    const materials = items.filter((e) => !e.document),
      documents = items.filter((e) => e.document);
    const imageCount = materials.filter((e) =>
      window.ITDViewer.image(e.file),
    ).length;
    const showAlbum = album && imageCount > 0;
    const chosenStage = project.stages.find((stage) => String(stage.id) === s.stage);
    const categoryNames = { all: "Файлы", document: "Документы", result: "Материалы" };
    const sectionName = showAlbum ? "Альбом" : categoryNames[s.category];
    const stageTitle = chosenStage && `${sectionName} этапа «${chosenStage.title}»`;
    $("library-album-toggle").hidden = !imageCount;
    let returnLabel = `К списку файлов · ${items.length}`;
    if (s.query || s.type) returnLabel = `К результатам поиска · ${items.length}`;
    else if (s.category === "result")
      returnLabel = `${chosenStage ? "Все материалы этапа" : "Все материалы без этапа"} · ${items.length}`;
    $("library-album-toggle").textContent = showAlbum ? returnLabel : `Смотреть альбом · ${imageCount}`;
    $("library-upload").hidden = h.getUser()?.role !== "admin";
    $("library-title").textContent = stageTitle || (showAlbum ? "Альбом материалов без этапа" : "Файлы проекта");
    $("library-back").hidden = !chosenStage;
    const count = $("library-count");
    if (showAlbum) count.textContent = `Изображений в альбоме · ${imageCount}`;
    else if (s.stage === "unassigned") count.textContent = `${sectionName} без этапа · ${items.length}`;
    else if (s.category !== "all") count.textContent = `${stageTitle} · ${items.length}`;
    else count.textContent = `Материалов: ${all.filter((e) => !e.document).length} · Документов: ${all.filter((e) => e.document).length}`;
    $("library-results-count").hidden = showAlbum;
    $("library-results-count").textContent = showAlbum ? "" :
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
    $("library-filters").open ||= !!s.type;
    const list = $("library-content");
    clearMaterialCards();
    $("library-empty").hidden = items.length > 0;
    $("library-empty-text").textContent = all.length
      ? "По этим условиям файлы не найдены. Измените поиск или сбросьте фильтры."
      : h.getUser()?.role === "admin"
        ? "Загрузите первые материалы или документы проекта."
        : "Здесь появятся материалы и документы, опубликованные студией.";
    $("library-reset").hidden = !all.length;
    if (showAlbum) {
      list.hidden = true;
      window.ITDGallery.render({
        ...project,
        files: materials.map((e) => e.file),
      }, reviewStatus);
      $("project-gallery").hidden = false;
      return;
    }
    if (scopeFiles !== null) album = false;
    list.hidden = false;
    window.ITDViewer.releaseWithin($("project-gallery"));
    $("project-gallery").replaceChildren();
    $("project-gallery").hidden = true;
    if (materials.length) {
      const section = node("section", undefined, "library-materials");
      section.append(
        node(
          "h3",
          chosenStage ? "Материалы этапа" : "Материалы проекта",
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
  function clearMaterialCards() {
    const list = $("library-content");
    window.ITDViewer.releaseWithin(list);
    window.ITDApprovalThumbnails.clear(list);
    list.replaceChildren();
  }
  function setProject(next) {
    const changed = project?.id !== next?.id;
    project = next;
    if (changed) {
      if (project)
        Object.assign(state(), {
          stage: "unassigned",
          sort: "oldest",
          category: "all",
          query: "",
          type: "",
        });
      album = false;
      $("library-edit-dialog").close();
      closeDocument();
    }
    if (!project) {
      scopeEpoch++;
      scopeFiles = null;
      clearMaterialCards();
      window.ITDViewer.releaseWithin($("project-gallery"));
      $("project-gallery").replaceChildren();
      return;
    }
    const s = state();
    const selectedStage = project.stages.find(
      (stage) => String(stage.id) === s.stage,
    );
    if (s.stage !== "unassigned" && !selectedStage) s.stage = "unassigned";
    $("library-stage").replaceChildren(
      new Option(selectedStage?.title || "Файлы проекта без этапа", s.stage),
    );
    $("library-stage").disabled = true;
    $("library-stage").closest("label").hidden = true;
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
      s.stage = "unassigned";
    if (![...$("library-type").options].some((o) => o.value === s.type))
      s.type = "";
    if (detailFileId && !project.files.some((f) => f.id === detailFileId))
      closeDocument();
    loadScope();
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
  // Navigate to a precise library scope, discarding any previous manual
  // search/filter selections so that another stage cannot leak into the view.
  function showScope(categoryValue, stageValue, openAlbum = false) {
    if (!project) return;
    const stage = stageValue == null || stageValue === 0 ? "unassigned" : String(stageValue);
    const s = state();
    if (s.stage !== stage) s.sort = "oldest";
    Object.assign(s, {
      category: categoryValue,
      stage,
      query: "",
      type: "",
    });
    album = !!openAlbum;
    closeDocument();
    loadScope();
  }
  async function loadScope(refresh = false) {
    if (!project) return;
    const epoch = ++scopeEpoch,
      pid = project.id,
      stage = state().stage;
    $("library-stage").replaceChildren(
      new Option(
        project.stages.find((s) => String(s.id) === stage)?.title ||
          "Файлы проекта без этапа",
        stage,
      ),
    );
    if (!refresh) {
      scopeFiles = null;
      render();
    }
    try {
      const result = await h.api(
        `/api/projects/${pid}/files?stageId=${stage === "unassigned" ? "none" : encodeURIComponent(stage)}`,
      );
      if (
        epoch !== scopeEpoch ||
        project?.id !== pid ||
        state().stage !== stage
      )
        return;
      if (
        result.projectId !== pid ||
        (result.stageId == null ? "unassigned" : String(result.stageId)) !==
          stage
      )
        throw new Error("Контекст списка файлов изменился. Обновите страницу.");
      scopeFiles = result.files;
      render();
    } catch (error) {
      if (epoch !== scopeEpoch || project?.id !== pid) return;
      scopeFiles = [];
      render();
      h.message(error.message, true);
    }
  }
  function editFile(e) {
    const dialog = $("library-edit-dialog"),
      form = $("library-edit-form"),
      pid = project.id;
    const title = e.file.review?.title || e.file.document?.title || e.file.name;
    form.elements.title.value = title;
    form.elements.stageId.replaceChildren(
      new Option("Файлы проекта · без этапа", ""),
      ...project.stages.map(
        (stage) => new Option(stage.title, String(stage.id)),
      ),
    );
    form.elements.stageId.value = String(e.file.stageId ?? "");
    $("library-edit-note").textContent = e.file.review
      ? "Перемещается весь материал вместе со всеми версиями. Комментарии, решения и исходные файлы сохранятся."
      : e.document
        ? "Меняется название в каталоге. Исходное имя файла и реквизиты сохранятся."
        : "При переименовании сохраните расширение файла. Оригинал не копируется.";
    $("library-edit-error").textContent = "";
    form.onsubmit = async (event) => {
      event.preventDefault();
      const submit = form.querySelector("button[type=submit]");
      submit.disabled = true;
      try {
        const stageId = form.elements.stageId.value
          ? Number(form.elements.stageId.value)
          : null;
        await h.api(`/api/projects/${pid}/files/${e.file.id}`, "PATCH", {
          stageId,
          expectedStageId: e.file.stageId ?? null,
          ...(form.elements.title.value.trim() !== title
            ? { title: form.elements.title.value.trim(), expectedTitle: title }
            : {}),
        });
        dialog.close();
        closeDocument();
        await h.refresh();
        h.message("Изменения сохранены. Файл доступен в выбранном разделе.");
      } catch (error) {
        $("library-edit-error").textContent = error.message;
      } finally {
        submit.disabled = false;
      }
    };
    dialog.showModal();
  }
  function init(hooks) {
    h = hooks;
    for (const b of document.querySelectorAll("[data-library-category]"))
      b.addEventListener("click", () => category(b.dataset.libraryCategory));
    for (const [id, key, event] of [
      ["library-search", "query", "input"],

      ["library-type", "type", "change"],
      ["library-sort", "sort", "change"],
    ])
      $(id).addEventListener(event, () => {
        state()[key] = $(id).value;
        if (key !== "sort") album = false;
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
      Object.assign(state(), { query: "", type: "" });
      render();
    });
    $("library-back").addEventListener("click", () => h.backToStage(Number(state().stage)));
    $("library-edit-close").addEventListener("click", () =>
      $("library-edit-dialog").close(),
    );
    $("library-document-close").addEventListener("click", closeDocument);
    $("library-document-dialog").addEventListener("close", () => {
      detailFileId = null;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    });
  }
  window.ITDLibrary = {
    init,
    setProject,
    openReview,
    category,
    showScope,
    stageId: () => project ? (state().stage === "unassigned" ? 0 : Number(state().stage)) : undefined,
    filterStage: (id) => showScope("all", id),
    onTab: (tab) => {
      if (tab === "files") return loadScope(true);
      closeDocument();
    },
    reset: () => {
      closeDocument();
      clearMaterialCards();
      $("library-document-detail").replaceChildren();
      $("library-edit-form").reset();
      $("library-edit-form").onsubmit = null;
      $("library-edit-note").textContent = "";
      $("library-edit-error").textContent = "";
      opener = null;
      states.clear();
      project = null;
      scopeFiles = null;
      scopeEpoch++;
      $("library-edit-dialog").close();
      album = false;
    },
  };
})();

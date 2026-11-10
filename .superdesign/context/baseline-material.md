# Existing materials and selected-version detail — exact selected rendering source

Current rendered layout is a full-width material list followed below by selected detail. It is NOT a desktop list/detail split yet. The file is opened in a separate viewer, NOT embedded in the current detail. Baseline must preserve this; audit variants can improve it. Each role-specific branch below is visible only for that role. Keep current/historical version distinction and confirmation/comment controls.

## material-review.js:3:30
```js
  const $ = (id) => document.getElementById(id),
    el = (tag, text, cls) => {
      const n = document.createElement(tag);
      if (text !== undefined) n.textContent = text;
      if (cls) n.className = cls;
      return n;
    };
  const labels = {
    planned: "Не начат",
    in_progress: "В работе",
    pending_approval: "Ожидает согласования",
    changes_requested: "Нужны изменения",
    approved: "Согласован",
    completed: "Завершён",
  };
  const eventsNames = {
    submitted: "Материал отправлен на согласование",
    version_uploaded: "Загружена новая версия",
    version_replaced: "Текущая версия заменена",
    approved: "Клиент согласовал версию",
    changes_requested: "Клиент запросил изменения",
    comment: "Комментарий клиента",
    admin_reply: "Ответ студии",
    approval_cancelled: "Согласование отменено",
    first_viewed: "Материал впервые просмотрен клиентом",
  };
  const date = (value) =>
    value ? new Date(value).toLocaleString("ru-RU") : "Не указана";
```

## material-review.js:92:164
```js
  function fileControls(file) {
    const n = el("div", undefined, "review-file-actions");
    if (window.ITDViewer.supported(file))
      n.append(window.ITDViewer.control(file, [file], "Посмотреть"));
    else n.append(el("span", "Предпросмотр недоступен", "file-meta"));
    const link = el("a", "Скачать", "file-download");
    link.href = `/api/files/${file.id}/download`;
    link.download = file.name;
    n.append(link);
    return n;
  }
  function viewLabel(version) {
    const view = version.view;
    if (!view?.viewed) return "Не просмотрено";
    return `Просмотрено ${date(view.lastViewedAt)}`;
  }

  // The material title is set when version 1 is uploaded; later versions may
  // have a different file type. Keep the readable title, but derive its file
  // extension from the selected version rather than the original upload.
  function versionFileName(material, version) {
    const actual = String(version?.file?.name || "").trim();
    const title = String(material?.title || "").trim() || actual || "Материал";
    const match = actual.match(/\.([A-Za-z0-9]{2,10})$/);
    if (!match) return title;
    const ext = match[1].toLowerCase();
    const base = title.replace(/\.(?:pdf|jpe?g|png|webp|gif|svg|dwg|dxf|docx?|xlsx?|pptx?|txt|zip|rar|7z)$/i, "");
    return `${base || title}.${ext}`;
  }
  function presentedFile(material, version) {
    // Only the label used by the viewer/download changes; the stored file ID,
    // content type and original name in the database are untouched.
    return { ...version.file, name: versionFileName(material, version) };
  }
  function fileTile(file) {
    const name = String(file?.name || "");
    const extension = name.match(/\.([A-Za-z0-9]{2,5})$/)?.[1]?.toUpperCase() || "ФАЙЛ";
    const type = ["PDF", "DWG", "DXF", "JPG", "JPEG", "PNG", "WEBP", "DOC", "DOCX", "XLS", "XLSX"].includes(extension) ? extension : "ФАЙЛ";
    const badge = el("div", undefined, "review-file-tile");
    badge.setAttribute("aria-hidden", "true");
    badge.append(el("span", "▤", "review-file-tile-icon"), el("span", type === "JPEG" ? "JPG" : type, "review-file-tile-type"));
    return badge;
  }
  function statusTag(value) {
    const item = el("span", labels[value] || value, "review-status");
    item.dataset.status = value;
    return item;
  }
  function card(material) {
    const v = material.currentVersion,
      n = el("article", undefined, "review-card review-material-card"),
      stage = project.stages.find((s) => s.id === material.stageId);
    n.dataset.materialId = String(material.id);
    if (selection === Number(material.id)) n.classList.add("is-selected");
    const main = el("div", undefined, "review-card-main");
    const copy = el("div", undefined, "review-card-copy");
    copy.append(
      el("p", `${stage?.title || "Этап"}${admin() ? ` · ${project.title} · ${project.clientName || "Без клиента"}` : ""}`, "review-context"),
      el("h3", versionFileName(material, v)),
      el("p", `Версия ${v.versionNumber} · ${date(v.createdAt)} · ${v.uploadedByName || "Студия"}`, "file-meta"),
      statusTag(v.status),
    );
    if (admin()) copy.append(el("p", viewLabel(v), "review-view-status"));
    if (v.decisionAt) copy.append(el("p", `${v.decisionByName || "Клиент"} · ${date(v.decisionAt)}`, "file-meta"));
    main.append(fileTile(v.file), copy);
    const actions = el("div", undefined, "review-card-action-area");
    actions.append(
      fileControls(presentedFile(material, v)),
      button("Открыть согласование и комментарии", () => open(material.id, v.id), "primary review-open-button"),
    );
    n.append(main, actions);
    return n;
  }
```

## material-review.js:165:188
```js
  function matches(material) {
    const f = $("review-filter").value;
    if (f === "viewed") return !!material.currentVersion.view?.viewed;
    if (f === "unviewed") return !material.currentVersion.view?.viewed;
    return !f || material.currentVersion.status === f;
  }
  function renderList() {
    const n = $("review-material-list");
    n.replaceChildren();
    const shown = materials.filter(matches);
    for (const m of shown) n.append(card(m));
    if ($("review-material-count")) $("review-material-count").textContent = `${shown.length} ${shown.length === 1 ? "материал" : shown.length >= 2 && shown.length <= 4 ? "материала" : "материалов"}`;
    if (!n.childElementCount)
      n.append(
        el("p", "Материалы по выбранному фильтру отсутствуют.", "empty-note"),
      );
    document.querySelectorAll("[data-review-stage]").forEach((host) => {
      host.replaceChildren();
      for (const m of materials.filter(
        (m) => String(m.stageId) === host.dataset.reviewStage,
      ))
        host.append(card(m));
    });
  }
```

## material-review.js:251:265
```js
  function textForm(id, label, name, submitText, callback) {
    const form = el("form", undefined, "review-form");
    form.id = id;
    const caption = el("label", label),
      input = el("textarea");
    input.name = name;
    input.required = true;
    input.maxLength = 4000;
    input.rows = 3;
    input.setAttribute("aria-label", label);
    caption.append(input);
    form.append(caption);
    attachSubmit(form, submitText, callback);
    return form;
  }
```

## material-review.js:319:582
```js
  function renderDetail() {
    const { material, versions, events } = detail,
      v = versions.find((v) => v.id === versionId),
      host = $("review-material-detail");
    host.replaceChildren();
    if (!v) {
      host.append(el("p", "Версия недоступна.", "error"));
      return;
    }
    const current = v.id === material.currentVersion.id,
      stage = project.stages.find((s) => s.id === material.stageId);

    document.querySelectorAll(".review-material-card[data-material-id]").forEach((node) => {
      node.classList.toggle("is-selected", Number(node.dataset.materialId) === Number(material.id));
    });
    const summary = el("div", undefined, "review-detail-header");
    const description = el("div", undefined, "review-detail-heading");
    description.append(
      el("p", `${project.title} / ${stage?.title || "Этап"} / Версия ${v.versionNumber}`, "review-context"),
      el("h2", versionFileName(material, v)),
      el("p", `Версия ${v.versionNumber} · ${date(v.createdAt)} · ${v.uploadedByName || "Студия"}`, "file-meta"),
      statusTag(v.status),
    );
    summary.append(fileTile(v.file), description);
    host.append(summary);
    const label = el("label", "Версия материала"),
      picker = el("select");
    picker.id = "review-version-select";
    for (const item of versions)
      picker.add(
        new Option(
          `Версия ${item.versionNumber}${item.id === material.currentVersion.id ? " — текущая" : " — история"} · ${labels[item.status] || item.status}`,
          String(item.id),
        ),
      );
    picker.value = String(v.id);
    picker.addEventListener("change", () =>
      open(material.id, Number(picker.value)),
    );
    label.append(picker);

    const versionTools = el("div", undefined, "review-version-tools");
    versionTools.append(label, fileControls(presentedFile(material, v)));
    host.append(versionTools);
    if (v.file.name && v.file.name !== versionFileName(material, v)) {
      const technical = el("details", undefined, "review-technical");
      technical.append(el("summary", "Сведения о файле"), el("p", v.file.name, "file-meta"));
      host.append(technical);
    }
    if (admin()) {
      host.append(el("p", viewLabel(v), "review-view-status"));
      const views = el("dl", undefined, "recovery-fields");
      for (const [key, value] of [
        ["Первый просмотр", date(v.view?.firstViewedAt)],
        ["Последний просмотр", date(v.view?.lastViewedAt)],
        ["Количество открытий", v.view?.viewCount || 0],
      ])
        views.append(el("dt", key), el("dd", String(value)));
      host.append(views);
      if (v.views?.length) {
        const history = el("details", undefined, "admin-history");
        history.append(el("summary", "Просмотры пользователей"));
        for (const view of v.views)
          history.append(
            el(
              "p",
              `${view.userName || `Пользователь ${view.userId}`} · Первый: ${date(view.firstViewedAt)} · Последний: ${date(view.lastViewedAt)}`,
              "file-meta",
            ),
          );
        host.append(history);
      }
    }
    if (v.decisionAt)
      host.append(
        el(
          "p",
          `Решение: ${v.decisionByName || "Клиент"} · ${date(v.decisionAt)}`,
          "review-decision",
        ),
      );
    if (!current)
      host.append(
        el(
          "p",
          "Это предыдущая версия. Решения сохранены в истории. Согласовать можно только текущую версию.",
          "review-warning",
        ),
      );
    if (current && !admin() && v.status === "pending_approval") {
      const controls = el("div", undefined, "review-decision-actions"),
        changes = textForm(
          "review-changes-form",
          "Что нужно изменить? Комментарий обязателен.",
          "comment",
          "Отправить замечания",
          (values) =>
            mutate(`/api/material-versions/${v.id}/decision`, {
              decision: "changes_requested",
              comment: values.comment,
              expectedRevision: v.revision,
            }),
        );
      changes.hidden = true;
      controls.append(
        button(
          "Согласовать",
          () => {
            if (
              window.confirm(
                `Вы подтверждаете согласование версии ${v.versionNumber} файла «${versionFileName(material, v)}»?`,
              )
            )
              return mutate(`/api/material-versions/${v.id}/decision`, {
                decision: "approved",
                confirm: true,
                expectedRevision: v.revision,
              });
          },
          "primary",
        ),
        button(
          "Нужны изменения",
          () => {
            changes.hidden = false;
            changes.querySelector("textarea").focus();
          },
          "review-secondary",
        ),
      );
      host.append(controls, changes);
    }
    if (current && admin()) {
      if (v.status === "approved") {
        const cancel = el("details", undefined, "admin-editor");
        cancel.append(
          el("summary", "Отменить согласование"),
          textForm(
            "review-cancel-form",
            "Причина отмены согласования",
            "reason",
            "Отменить с записью в историю",
            (values) => {
              if (
                window.confirm(
                  `Отменить согласование версии ${v.versionNumber}? Причина останется в истории.`,
                )
              )
                return mutate(`/api/material-versions/${v.id}/cancel`, {
                  reason: values.reason,
                  confirm: true,
                  expectedRevision: v.revision,
                });
            },
          ),
        );
        host.append(cancel);
      }
      const upload = el("details", undefined, "admin-editor");
      upload.append(el("summary", "Загрузить новую версию"));
      const form = el("form", undefined, "review-form");
      form.id = "review-version-upload";
      const caption = el("label", "Файл новой версии"),
        file = el("input");
      file.type = "file";
      file.name = "file";
      file.required = true;
      caption.append(file);
      form.append(
        el(
          "p",
          "Новая версия потребует нового согласования. Старые версии и решения сохранятся.",
          "muted",
        ),
        caption,
      );
      attachSubmit(form, "Отправить новую версию", async () => {
        if (form.dataset.uploading) return;
        const generation = epoch,
          pid = project.id,
          seq = detailSeq,
          mid = material.id;
        form.dataset.uploading = "true";
        try {
          const result = await window.ITDUploads.send(form, {
            category: "result",
            stageId: material.stageId,
            materialId: material.id,
            expectedVersionId: material.currentVersion.id,
          });
          if (!result || !valid(generation, pid) || seq !== detailSeq) return;
          await h.refresh();
          if (!valid(generation, pid) || seq !== detailSeq) return;
          await open(mid);
          notice("Новая версия отправлена на согласование.");
          await loadNotifications();
        } finally {
          delete form.dataset.uploading;
        }
      });
      window.ITDUploads.register(form, {
        context: () => ({
          ...window.ITDUploads.contextOf(project),
          materialId: material.id,
          expectedVersionId: material.currentVersion.id,
        }),
      });
      upload.append(form);
      host.append(upload);
    }
    const comments = el("details", undefined, "review-comments-pane");
    const entries = events.filter((e) => e.versionId === v.id && e.body);
    comments.append(el("summary", `Комментарии (${entries.length})`));
    comments.open = true;
    const thread = el("div", undefined, "review-comments");
    for (const event of entries) {
      const entry = el("article", undefined, "review-comment");
      entry.append(
        el(
          "p",
          `${event.actorName || "Пользователь"} · ${event.actorRole === "admin" ? "Студия" : "Клиент"} · ${date(event.createdAt)}`,
          "file-meta",
        ),
        el("p", event.body, "review-comment-body"),
      );
      thread.append(entry);
    }
    if (!thread.childElementCount)
      thread.append(el("p", "Комментариев пока нет.", "muted"));
    comments.append(
      thread,
      textForm(
        "review-comment-form",
        admin() ? "Ответить клиенту" : "Комментарий к версии",
        "text",
        admin() ? "Отправить ответ" : "Отправить комментарий",
        (values) =>
          mutate(`/api/material-versions/${v.id}/comments`, {
            text: values.text,
          }),
      ),
    );
    host.append(comments);
    const history = el("details", undefined, "review-history-pane");
    history.append(el("summary", `История всех версий (${versions.length})`));
    const list = el("ol", undefined, "review-history");
    for (const event of events) {
      const item = el("li");
      item.append(
        el(
          "strong",
          `Версия ${event.versionNumber} · ${eventsNames[event.type] || "Событие материала"}`,
        ),
        el(
          "span",
          `${event.actorName || "Пользователь"} · ${date(event.createdAt)}`,
        ),
      );
      if (event.body) item.append(el("p", event.body));
      list.append(item);
    }
    history.append(list);
    host.append(history);
  }
```

## file-viewer.js:3:27
```js
  const el = (tag, text, className) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (className) n.className = className;
    return n;
  };
  const image = (f) =>
    ["image/jpeg", "image/png", "image/webp"].includes(f?.contentType);
  const supported = (f) => image(f) || f?.contentType === "application/pdf";
  const dialog = el("dialog", undefined, "file-viewer");
  dialog.setAttribute("aria-label", "Просмотр материала");
  const toolbar = el("div", undefined, "viewer-toolbar"),
    title = el("h2"),
    status = el("p", undefined, "viewer-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const button = (label, action) => {
    const b = el("button", label);
    b.type = "button";
    b.addEventListener("click", action);
    return b;
  };
  const viewport = el("div", undefined, "viewer-viewport"),
    content = el("div", undefined, "viewer-content");
  viewport.append(content);
```

## file-viewer.js:81:91
```js
    next = button("Следующий →", () => navigate(1));
  const minus = button("Уменьшить", () => setZoom(zoom - 0.25)),
    reset = button("Сбросить масштаб", () => setZoom(1)),
    plus = button("Увеличить", () => setZoom(zoom + 0.25));
  const download = el("a", "Скачать оригинал");
  download.className = "viewer-download";
  toolbar.append(title, button("Закрыть", close));
  const controls = el("div", undefined, "viewer-controls");
  controls.append(prev, next, minus, reset, plus, download);
  dialog.append(toolbar, controls, status, viewport);
  document.body.append(dialog);
```

## upload-context.js:31:35
```js
  }
  function showRecipient(record) {
    const context = record.draft?.context || record.context();
    record.projectLine.textContent = `Загрузка в проект: ${context?.projectTitle || "не выбран"}`;
    record.clientLine.textContent = `Клиент: ${context?.clientLabel || "не выбран"}`;
```

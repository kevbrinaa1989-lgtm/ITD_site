"use strict";
(() => {
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
  let h,
    project = null,
    materials = [],
    detail = null,
    selection = null,
    versionId = null,
    epoch = 0,
    detailSeq = 0,
    listSeq = 0,
    notifSeq = 0,
    timer,
    operation = null,
    notifications = [];
  const admin = () => h.getUser()?.role === "admin",
    valid = (generation, id) =>
      generation === epoch &&
      h.getUser() &&
      (id === undefined || project?.id === id);
  const notice = (text) => {
    $("review-message").textContent = text;
  };
  function button(text, callback, cls = "text-button") {
    const n = el("button", text, cls);
    n.type = "button";
    n.addEventListener("click", async () => {
      const generation = epoch;
      try {
        await callback();
      } catch (error) {
        if (valid(generation)) notice(error.message);
      }
    });
    return n;
  }
  function reset() {
    epoch++;
    detailSeq++;
    listSeq++;
    notifSeq++;
    clearInterval(timer);
    timer = null;
    operation = null;
    project = null;
    materials = [];
    detail = null;
    selection = null;
    versionId = null;
    notifications = [];
    for (const id of [
      "review-material-list",
      "review-material-detail",
      "notification-list",
    ])
      $(id)?.replaceChildren();
    $("review-material-detail").hidden = true;
    notice("");
    $("notifications-message").textContent = "";
    $("notification-count").textContent = "0";
    $("notification-count").hidden = true;
    $("review-filter").value = "";
  }
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
  function card(material) {
    const v = material.currentVersion,
      n = el("article", undefined, "review-card"),
      stage = project.stages.find((s) => s.id === material.stageId);
    n.dataset.materialId = String(material.id);
    n.append(
      el(
        "p",
        `${stage?.title || "Этап"}${admin() ? ` · ${project.title} · ${project.clientName || "Без клиента"}` : ""}`,
        "review-context",
      ),
      el("h3", material.title),
      el("p", `Версия ${v.versionNumber} · ${date(v.createdAt)}`, "file-meta"),
      el("p", labels[v.status] || v.status, "review-status"),
    );
    if (admin()) n.append(el("p", viewLabel(v), "review-view-status"));
    n.append(fileControls(v.file));
    if (v.decisionAt)
      n.append(
        el(
          "p",
          `${v.decisionByName || "Клиент"} · ${date(v.decisionAt)}`,
          "file-meta",
        ),
      );
    n.append(
      button(
        "Открыть согласование и комментарии",
        () => open(material.id, v.id),
        "primary",
      ),
    );
    return n;
  }
  function matches(material) {
    const f = $("review-filter").value;
    if (f === "viewed") return !!material.currentVersion.view?.viewed;
    if (f === "unviewed") return !material.currentVersion.view?.viewed;
    return !f || material.currentVersion.status === f;
  }
  function renderList() {
    const n = $("review-material-list");
    n.replaceChildren();
    for (const m of materials.filter(matches)) n.append(card(m));
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
  async function loadList() {
    if (!project) return;
    const generation = epoch,
      id = project.id,
      seq = ++listSeq;
    try {
      const result = await h.api(`/api/projects/${id}/materials`);
      if (!valid(generation, id) || seq !== listSeq) return;
      materials = result.materials;
      renderList();
    } catch (error) {
      if (valid(generation, id) && seq === listSeq) notice(error.message);
    }
  }
  function setProject(next) {
    if (project?.id !== next?.id) {
      epoch++;
      detailSeq++;
      listSeq++;
      operation = null;
      materials = [];
      detail = null;
      selection = null;
      versionId = null;
      $("review-material-detail").replaceChildren();
      $("review-material-detail").hidden = true;
      $("review-material-list").replaceChildren();
      notice("");
      $("review-filter").value = "";
    }
    project = next || null;
    if (project) loadList();
  }
  async function open(id, requestedVersion) {
    if (!project) return false;
    const generation = epoch,
      pid = project.id,
      seq = ++detailSeq;
    selection = Number(id);
    versionId = requestedVersion ? Number(requestedVersion) : null;
    h.selectTab("review");
    const host = $("review-material-detail");
    host.hidden = false;
    host.replaceChildren(el("p", "Загрузка версии…", "muted"));
    try {
      const result = await h.api(`/api/materials/${id}`);
      if (!valid(generation, pid) || seq !== detailSeq) return false;
      if (result.material.projectId !== pid)
        throw new Error("Материал относится к другому проекту.");
      detail = result;
      versionId = versionId || result.material.currentVersion.id;
      renderDetail();
      host.tabIndex = -1;
      host.focus({ preventScroll: true });
      host.scrollIntoView({ block: "start" });
      return true;
    } catch (error) {
      if (valid(generation, pid) && seq === detailSeq)
        host.replaceChildren(el("p", error.message, "error"));
      return false;
    }
  }
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
  function attachSubmit(form, text, callback) {
    const submit = el("button", text, "primary");
    submit.type = "submit";
    form.append(submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form)),
        generation = epoch;
      try {
        await callback(values);
      } catch (error) {
        if (valid(generation)) notice(error.message);
      }
    });
  }
  async function mutate(path, payload, newVersion = false) {
    if (operation || !project || !detail) return;
    const token = {},
      generation = epoch,
      pid = project.id,
      seq = detailSeq,
      mid = selection,
      vid = versionId;
    operation = token;
    const controls = [
      ...$("review-material-detail").querySelectorAll(
        "button,input,textarea,select",
      ),
    ].map((n) => [n, n.disabled]);
    controls.forEach(([n]) => (n.disabled = true));
    notice("Сохраняем…");
    try {
      await h.api(path, "POST", payload);
      if (!valid(generation, pid)) return;
      await h.refresh();
      if (!valid(generation, pid) || seq !== detailSeq) return;
      await open(mid, newVersion ? null : vid);
      notice(
        newVersion
          ? "Новая версия отправлена на согласование."
          : "Изменения сохранены.",
      );
      await loadNotifications();
    } catch (error) {
      if (valid(generation, pid) && seq === detailSeq) {
        if (error.status === 409) await open(mid, vid);
        notice(error.message);
      }
    } finally {
      if (operation === token) operation = null;
      controls.forEach(([n, disabled]) => (n.disabled = disabled));
    }
  }
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
    host.append(
      el(
        "p",
        `${project.title} · ${stage?.title || "Этап"}${admin() ? ` · ${project.clientId === null ? "Без клиента" : `${project.clientName} (${project.clientEmail})`}` : ""}`,
        "review-context",
      ),
      el("h2", material.title),
    );
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
    host.append(
      label,
      el(
        "p",
        `${v.file.name} · ${date(v.createdAt)} · ${v.uploadedByName || "Студия"}`,
        "file-meta",
      ),
      el("p", labels[v.status] || v.status, "review-status"),
      fileControls(v.file),
    );
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
                `Вы подтверждаете согласование версии ${v.versionNumber} материала «${material.title}»?`,
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
    host.append(el("h3", "Комментарии к этой версии"));
    const thread = el("div", undefined, "review-comments");
    for (const event of events.filter((e) => e.versionId === v.id && e.body)) {
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
    host.append(
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
    const history = el("details", undefined, "admin-history");
    history.append(el("summary", "История всех версий"));
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
  function reviewControl(file) {
    return file.review
      ? button(
          `Версия ${file.review.versionNumber} · ${labels[file.review.status] || file.review.status} · Обсудить`,
          () => open(file.review.materialId, file.review.versionId),
        )
      : document.createDocumentFragment();
  }
  function sendControl(file) {
    if (file.review || !admin() || file.category !== "result" || !file.stageId)
      return document.createDocumentFragment();
    return button("На согласование", async () => {
      if (
        !window.confirm(
          `Отправить файл «${file.name}» на согласование клиенту?`,
        )
      )
        return;
      const generation = epoch,
        pid = project.id;
      await h.api(`/api/files/${file.id}/review`, "POST", { confirm: true });
      if (valid(generation, pid)) await h.refresh();
    });
  }
  async function loadNotifications() {
    if (!h.getUser()) return;
    const generation = epoch,
      seq = ++notifSeq;
    try {
      const result = await h.api("/api/notifications");
      if (!valid(generation) || seq !== notifSeq) return;
      notifications = result.notifications;
      $("notification-count").textContent = String(result.unreadCount);
      $("notification-count").hidden = !result.unreadCount;
      renderNotifications();
      $("notifications-message").textContent = "";
    } catch (error) {
      if (valid(generation) && seq === notifSeq)
        $("notifications-message").textContent = error.message;
    }
  }
  function renderNotifications() {
    const list = $("notification-list");
    list.replaceChildren();
    for (const n of notifications) {
      const card = el(
        "article",
        undefined,
        "notification-card" + (n.readAt ? "" : " notification-unread"),
      );
      card.append(
        el("p", `${n.projectTitle} · ${date(n.createdAt)}`, "file-meta"),
        el("h3", eventsNames[n.type] || "Обновление материала"),
        el(
          "p",
          `${n.materialTitle} · Версия ${n.versionNumber} · ${n.actorName || "Студия"}`,
          "review-context",
        ),
        button("Открыть версию", async () => {
          const requestUser = h.getUser();
          await h.openProject(n.projectId);
          if (h.getUser() !== requestUser) return;
          const opened = await open(n.materialId, n.versionId);
          if (
            !opened ||
            h.getUser() !== requestUser ||
            project?.id !== n.projectId ||
            selection !== n.materialId ||
            versionId !== n.versionId
          )
            return;
          await h.api(`/api/notifications/${n.id}/read`, "POST", {});
          if (h.getUser() === requestUser) await loadNotifications();
        }),
      );
      if (!n.readAt)
        card.append(
          button("Отметить прочитанным", async () => {
            const generation = epoch;
            await h.api(`/api/notifications/${n.id}/read`, "POST", {});
            if (valid(generation)) await loadNotifications();
          }),
        );
      list.append(card);
    }
    if (!list.childElementCount)
      list.append(el("p", "Уведомлений пока нет.", "empty-note"));
  }
  async function rendered(file) {
    if (!h.getUser() || admin() || !project) return;
    let vid = file.review?.versionId;
    for (const m of materials)
      for (const version of m.versions || [m.currentVersion])
        if (version.file.id === file.id) vid = version.id;
    for (const version of detail?.versions || [])
      if (version.file.id === file.id) vid = version.id;
    if (!vid) return;
    const generation = epoch,
      pid = project.id;
    try {
      const result = await h.api(
        `/api/material-versions/${vid}/view`,
        "POST",
        {},
      );
      if (!valid(generation, pid)) return;
      for (const m of materials)
        for (const version of m.versions || [m.currentVersion])
          if (version.id === vid) version.view = result.view;
      for (const version of detail?.versions || [])
        if (version.id === vid) version.view = result.view;
    } catch (error) {
      if (valid(generation, pid))
        notice(`Не удалось сохранить просмотр: ${error.message}`);
    }
  }
  function start() {
    clearInterval(timer);
    loadNotifications();
    timer = setInterval(() => {
      if (!document.hidden && h.getUser()) loadNotifications();
    }, 30000);
  }
  function init(hooks) {
    h = hooks;
    $("review-filter").addEventListener("change", renderList);
    $("notifications-refresh").addEventListener("click", loadNotifications);
    window.ITDViewer.onRendered(rendered);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && h.getUser()) loadNotifications();
    });
  }
  function onTab(tab) {
    if (tab === "review" && project) loadList();
    if (tab === "notifications") loadNotifications();
  }
  window.ITDReview = {
    init,
    reset,
    start,
    setProject,
    onTab,
    open,
    reviewControl,
    sendControl,
  };
})();

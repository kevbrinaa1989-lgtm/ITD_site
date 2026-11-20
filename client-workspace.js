"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  let hooks,
    epoch = 0,
    notificationSeq = 0,
    notifications = [],
    notificationError = "",
    profileBusy = false,
    notificationsRequest = null,
    reviewView = "waiting",
    lastTab = null,
    viewedStages = new Map();
  const client = () => hooks?.getUser()?.role === "client";
  const valid = (generation, user) =>
    generation === epoch && client() && hooks.getUser() === user;
  function reviewMaterials() {
    return hooks.getProjects().flatMap((project) => {
      const entries = window.ITDProjectFiles.entries(project);
      return window.ITDProjectFiles.select(entries, { category: "result", sort: "oldest" })
        .filter((entry) => entry.file.review?.isCurrent)
        .map((entry) => ({ ...entry, project }));
    });
  }
  const waitingForDecision = (item) =>
    window.ITDUI.active(item.project) &&
    (item.status === "pending_approval" || item.file.review.canApproveAfterCorrection);
  const sentDecision = (file) => file.review.lastDecision;
  function previousReturn(item) {
    const previous = item.versions.find((f) =>
      f.review.versionNumber < item.file.review.versionNumber && sentDecision(f));
    return previous && sentDecision(previous) === "changes_requested" ? previous : null;
  }
  const date = (value) =>
    value ? new Date(value).toLocaleString("ru-RU") : "Дата не указана";
  function button(label, action, className = "text-button") {
    const el = node("button", label, className);
    el.type = "button";
    el.addEventListener("click", async () => {
      const generation = epoch,
        user = hooks.getUser();
      try {
        await action();
      } catch (error) {
        if (valid(generation, user))
          hooks.message(error.message || "Не удалось открыть раздел.", true);
      }
    });
    return el;
  }
  function projectCard(project) {
    const card = node(
      "article",
      undefined,
      "panel project-card client-project-card",
    );
    const stages = project.stages || [],
      state = window.ITDProjectState.progress(stages),
      completed = state.completed;
    const current = stages.filter((stage) =>
      ["in_progress", "pending_approval", "changes_requested"].includes(
        stage.status,
      ),
    );
    card.append(
      node("h3", project.title),
      node("p", project.status, "badge"),
      node(
        "p",
        stages.length
          ? `${state.label} · ${state.percent}% · ${state.detail}`
          : "Этапы пока не добавлены",
        "muted",
      ),
    );
    if (stages.length) {
      const progress = node("progress");
      progress.max = stages.length;
      progress.value = state.accepted;
      progress.setAttribute("aria-label", state.label);
      card.append(progress);
      card.append(
        node(
          "p",
          current.length
            ? `В работе: ${current.map((s) => s.title).join(" · ")}`
            : completed === stages.length
              ? "Все этапы завершены"
              : state.approved
                ? "Согласование получено; завершение отмечает студия"
                : "Этапы запланированы",
          "muted",
        ),
      );
    }
    const open = button(
      "Открыть проект →",
      () => hooks.openProject(project.id),
      "primary",
    );
    open.dataset.projectId = String(project.id);
    card.append(open);
    return card;
  }
  function materialButton(item, file, text, panel, className = "text-button") {
    const open = button(text, () => hooks.openMaterial(
      item.project.id, file.review.materialId, file.review.versionId,
      panel === "notes" ? { panel } : undefined,
    ), className);
    open.dataset.projectId = item.project.id;
    return open;
  }
  function decisionCard(item, file = item.file) {
    const card = node("article", undefined, "client-decision-card");
    const copy = node("div");
    const actions = node("div", undefined, "client-decision-actions");
    const history = reviewView === "history";
    const decision = history ? sentDecision(file) : file.review.status;
    const original = decision === "pending_approval" ? previousReturn(item) : null;
    const ready = !history && file.review.canApproveAfterCorrection;
    const events = history ? file.review.decisionHistory || [] : [];
    let state;
    if (ready) state = "Исправления приняты · Можно согласовать";
    else if (decision === "changes_requested") state = "Отправлено на доработку";
    else if (decision === "approved")
      state = file.review.status === "pending_approval" ? "Согласование отменено" : "Согласовано";
    else state = original ? "Исправления готовы к проверке" : "Ожидает решения";
    copy.append(
      node("p", [item.project.title, item.stage?.title || "Без этапа",
        item.project.status === "Архив" ? "Архив" : ""].filter(Boolean).join(" · "), "client-decision-context"),
      node("h3", item.title),
      node("p", events.length > 1 ? `Версия ${file.review.versionNumber}` :
        `Версия ${file.review.versionNumber} · ${state}`, "client-decision-state"),
    );
    if (events.length > 1) {
      const list = node("ol", undefined, "client-decision-state");
      list.setAttribute("aria-label", `История решений по версии ${file.review.versionNumber}`);
      const labels = { changes_requested: "Отправлено на доработку", approved: "Согласовано",
        approval_cancelled: "Согласование отменено" };
      for (const event of events) list.append(node("li", `${labels[event.type]} · ${date(event.createdAt)}`));
      copy.append(list);
    }
    card.dataset.materialId = file.review.materialId;
    card.dataset.versionId = file.review.versionId;
    if (decision === "changes_requested") {
      const next = item.versions.find((v) => v.review.versionNumber === file.review.versionNumber + 1);
      if (ready) actions.append(materialButton(item, file, "Перейти к согласованию", "viewer"));
      actions.append(materialButton(item, file, next ?
        `Исходное замечание · версия ${file.review.versionNumber}` : "Открыть замечания", "notes"));
      if (next) {
        actions.append(materialButton(item, next, `Исправленная версия ${next.review.versionNumber}`, "notes"));
        if (next.id !== item.file.id) actions.append(materialButton(item, item.file,
          `Текущая версия ${item.file.review.versionNumber}`, "notes"));
      }
    } else if (history) {
      actions.append(materialButton(item, file, "Открыть решение", "notes"));
    } else {
      actions.append(materialButton(item, file, original ? "Проверить исправления" : "Посмотреть и решить",
        original ? "notes" : "viewer"));
      if (original) actions.append(materialButton(item, original,
        `Исходное замечание · версия ${original.review.versionNumber}`, "notes"));
    }
    card.append(copy, actions);
    return card;
  }
  function homeDecision(item) {
    const section = node("section", undefined, "client-next-decision");
    section.setAttribute("aria-label", "Ждёт вашего решения");
    const copy = node("div");
    copy.append(node("p", "Ждёт вашего решения", "client-next-label"),
      node("h2", item.title),
      node("p", `${item.stage?.title || "Без этапа"} · Версия ${item.file.review.versionNumber}`, "client-decision-context"));
    const ready = item.file.review.canApproveAfterCorrection;
    const corrected = !ready && previousReturn(item);
    section.append(copy, materialButton(item, item.file,
      ready ? "Перейти к согласованию" : corrected ? "Проверить исправления" : "Посмотреть и решить",
      corrected ? "notes" : "viewer", "primary"));
    return section;
  }
  function heading(host, title, subtitle) {
    host.replaceChildren(node("h1", title));
    if (subtitle) host.append(node("p", subtitle, "muted"));
  }
  function renderProjects() {
    const host = $("client-projects-panel");
    heading(
      host,
      "Мои проекты",
      "Все назначенные вам проекты, включая архивные.",
    );
    const grid = node("div", undefined, "project-grid client-project-grid");
    hooks.getProjects().forEach((project) => grid.append(projectCard(project)));
    if (!grid.childElementCount)
      grid.append(
        node(
          "p",
          "Вам пока не назначен проект. После назначения он появится здесь. Свяжитесь со студией, если работа уже началась.",
          "empty-note",
        ),
      );
    host.append(grid);
  }
  function renderReview(materials = reviewMaterials()) {
    const host = $("client-review-panel");
    heading(host, "Решения");
    const choices = node("div", undefined, "client-decision-filters");
    choices.setAttribute("role", "group");
    choices.setAttribute("aria-label", "Показать решения");
    const list = node("div", undefined, "client-decision-list");
    list.id = "client-decision-list";
    const views = [
      ["waiting", "Ожидают решения", "Сейчас нет материалов, ожидающих вашего решения."],
      ["returned", "На доработке", "Материалов на доработке пока нет."],
      ["history", "История", "Здесь появятся решения после отправки студии."],
    ];
    let empty;
    for (const [key, label, emptyText] of views) {
      const selected = key === reviewView;
      const toggle = button(label, () => {
        if (key === reviewView) return;
        reviewView = key;
        renderReview();
        host.querySelector('.client-decision-filters [aria-pressed="true"]').focus({ preventScroll: true });
      });
      toggle.setAttribute("aria-pressed", String(selected));
      toggle.setAttribute("aria-controls", list.id);
      choices.append(toggle);
      if (selected) empty = emptyText;
    }
    if (reviewView === "history") {
      for (const item of materials) {
        for (const file of item.versions.filter(sentDecision)) list.append(decisionCard(item, file));
      }
    } else {
      const shown = reviewView === "waiting" ? materials.filter(waitingForDecision) :
        materials.filter((item) => window.ITDUI.active(item.project) &&
          (item.status === "changes_requested" || (item.status === "pending_approval" && previousReturn(item))));
      shown.forEach((item) => list.append(decisionCard(item)));
    }
    if (!list.childElementCount) list.append(node("p", empty, "empty-note"));
    host.append(choices, list);
  }
  function renderHome(materials = reviewMaterials()) {
    const host = $("client-home-panel"),
      user = hooks.getUser(),
      projects = hooks.getProjects(),
      waiting = materials.filter(waitingForDecision);
    const activeProjects = projects.filter(window.ITDUI.active);
    const project =
      activeProjects.find((p) => waiting.some((w) => w.project.id === p.id)) ||
      activeProjects[0] ||
      projects[0];
    window.ITDViewer?.releaseWithin(host);
    host.replaceChildren();
    if (project) {
      const header = node("div", undefined, "route-home-heading"),
        copy = node("div", undefined, "client-home-intro");
      const selected = window.ITDProjectState.selectedStage(project.stages, viewedStages.get(project.id));
      const projectWaiting = waiting.filter((item) => item.project.id === project.id);
      const featured = projectWaiting.find((item) => item.file.stageId === (selected?.id ?? null)) || projectWaiting[0];
      const name = node("div", undefined, "client-project-name");
      const title = node("h1", project.title);
      title.title = project.title;
      name.append(title, node("p", project.status, "badge"));
      copy.append(node("p", "Ваш проект", "eyebrow"), name);
      if (featured) copy.append(homeDecision(featured));
      else if (window.ITDUI.active(project))
        copy.append(node("p", "Сейчас от вас не требуется решений.", "client-decision-context"));
      header.append(copy, window.ITDUI.progress(project));
      host.append(header);
      if (projects.length > 1)
        host.append(
          button(`Все мои проекты · ${projects.length} →`, () =>
            hooks.selectTab("client-projects"),
          ),
        );
      host.append(
        window.ITDUI.journey(project, {
          featuredMaterialId: featured?.file.review.materialId,
          openStage: (id) => {
            viewedStages.set(project.id, id);
            renderHome();
          },
          openTab: (tab, options) => hooks.openProject(project.id, { ...options, tab }),
          openMaterial: (file) =>
            hooks.openMaterial(
              project.id,
              file.review.materialId,
              file.review.versionId,
            ),
        }, viewedStages.get(project.id)),
      );
      if (waiting.length > 1)
        host.append(button(`Все ожидающие решения · ${waiting.length}`, () => {
          reviewView = "waiting";
          hooks.selectTab("client-review");
        }));
    } else {
      heading(
        host,
        `Здравствуйте, ${user.name}`,
        "Ваши проекты и материалы появятся здесь после назначения студией.",
      );
      host.append(
        node(
          "p",
          "Вам пока не назначен проект. Если работа уже началась, свяжитесь со студией.",
          "empty-note",
        ),
      );
    }
    host.append(node("h2", "Последние события", "route-events-title"));
    const events = node("div", undefined, "client-events");
    const labels = {
      package_published: "Студия направила пакет материалов",
      submitted: "Новый материал на согласование",
      version_uploaded: "Новая версия материала",
      admin_reply: "Ответ студии",
      corrections_ready: "Исправления готовы к проверке",
      annotation_reply: "Ответ на замечание",
      annotation_fixed: "Дизайнер отметил исправление",
      annotation_confirmed: "Исправление подтверждено",
      annotation_reopened: "Повторная доработка",
      stage_approved: "Этап согласован",
      approval_cancelled: "Согласование отменено",
    };
    for (const event of notifications.slice(0, 5)) {
      const card = node("article", undefined, "panel");
      const material = materials.find((item) => item.project.id === event.projectId &&
        item.file.review.materialId === event.materialId);
      card.append(
        node(
          "p",
          `${event.projectTitle} · ${date(event.createdAt)}`,
          "file-meta",
        ),
        node("h3", labels[event.type] || "Обновление проекта"),
        node(
          "p",
          `${material?.title || window.ITDUI.materialTitle(event.materialTitle)} · Версия ${event.versionNumber}`,
        ),
      );
      const open = button("Открыть материал →", () =>
        hooks.openMaterial(event.projectId, event.materialId, event.versionId),
      );
      open.dataset.projectId = String(event.projectId);
      card.append(open);
      events.append(card);
    }
    if (notificationError)
      events.append(
        node("p", notificationError, "error"),
        button("Повторить загрузку событий", loadNotifications),
      );
    else if (!notifications.length)
      events.append(node("p", "Уведомлений пока нет.", "empty-note"));
    host.append(
      events,
      button("Все уведомления →", () => hooks.selectTab("notifications")),
    );
  }
  function fillProfile() {
    if (profileBusy) return;
    const user = hooks.getUser();
    $("profile-name").value = user.name || "";
    $("profile-phone").value = user.phone || "";
    $("profile-email").value = user.email || "";
  }
  async function loadNotifications() {
    if (!client() || notificationsRequest) return;
    const request = {};
    notificationsRequest = request;
    const generation = epoch,
      user = hooks.getUser(),
      seq = ++notificationSeq;
    try {
      const result = await hooks.api("/api/notifications");
      if (!valid(generation, user) || seq !== notificationSeq) return;
      notifications = result.notifications;
      notificationError = "";
      renderHome();
    } catch (error) {
      if (valid(generation, user) && seq === notificationSeq) {
        notificationError =
          "Не удалось загрузить события. Проверьте связь и повторите попытку.";
        renderHome();
      }
    } finally {
      if (notificationsRequest === request) notificationsRequest = null;
    }
  }
  function render() {
    if (client()) {
      const materials = reviewMaterials();
      renderHome(materials);
      renderProjects();
      renderReview(materials);
    }
  }
  function onTab(tab) {
    if (!client()) return;
    const previousTab = lastTab;
    lastTab = tab;
    if (tab === "client-home") {
      renderHome();
      loadNotifications();
    }
    if (tab === "client-projects") renderProjects();
    if (tab === "client-review") renderReview();
    const returningHome = tab === "client-home" && previousTab !== null;
    if (previousTab !== tab && (tab === "client-review" || returningHome)) {
      const generation = epoch, user = hooks.getUser();
      hooks.refresh().catch((error) => {
        if (lastTab === tab && valid(generation, user))
          hooks.message(error.message || "Не удалось обновить решения.", true);
      });
    }
    if (tab === "profile") fillProfile();
  }
  function reset() {
    epoch++;
    notificationSeq++;
    notifications = [];
    notificationError = "";
    profileBusy = false;
    notificationsRequest = null;
    reviewView = "waiting";
    lastTab = null;
    viewedStages.clear();
    $("profile-form")
      ?.querySelectorAll("input,button")
      .forEach((control) => (control.disabled = false));
    for (const id of [
      "client-home-panel",
      "client-projects-panel",
      "client-review-panel",
    ])
      $(id)?.replaceChildren();
    $("profile-form")?.reset();
    $("profile-error").textContent = "";
    $("profile-message").textContent = "";
  }
  function init(options) {
    hooks = options;
    $("profile-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!client() || profileBusy) return;
      const generation = epoch,
        user = hooks.getUser();
      const payload = {
        name: $("profile-name").value.trim(),
        phone: $("profile-phone").value.trim() || null,
      };
      const controls = [...$("profile-form").querySelectorAll("input,button")];
      profileBusy = true;
      controls.forEach((control) => (control.disabled = true));
      $("profile-error").textContent = "";
      $("profile-message").textContent = "Сохраняем…";
      try {
        const result = await hooks.api("/api/me/profile", "PATCH", payload);
        if (!valid(generation, user)) return;
        hooks.updateUser(result.user);
        render();
        $("profile-message").textContent = "Изменения сохранены.";
      } catch (error) {
        if (valid(generation, user)) {
          $("profile-message").textContent = "";
          $("profile-error").textContent =
            error instanceof TypeError
              ? "Нет связи с сервером. Проверьте подключение и повторите сохранение."
              : error.message;
        }
      } finally {
        if (generation === epoch) {
          profileBusy = false;
          controls.forEach((control) => (control.disabled = false));
        }
      }
    });
  }
  window.ITDClientWorkspace = { init, render, onTab, reset };
})();

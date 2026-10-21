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
    notificationsRequest = null;
  const client = () => hooks?.getUser()?.role === "client";
  const valid = (generation, user) =>
    generation === epoch && client() && hooks.getUser() === user;
  const pending = () =>
    hooks
      .getProjects()
      .flatMap((project) =>
        (project.files || [])
          .filter(
            (file) =>
              file.review?.isCurrent &&
              file.review.status === "pending_approval",
          )
          .map((file) => ({ project, file })),
      );
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
      completed = stages.filter((stage) => stage.status === "completed").length;
    const current =
      stages.find((stage) => stage.status === "in_progress") ||
      stages.find((stage) => stage.status !== "completed");
    card.append(
      node("h3", project.title),
      node("p", project.status, "badge"),
      node(
        "p",
        stages.length
          ? `Завершено ${completed} из ${stages.length} этапов · ${Math.round((completed / stages.length) * 100)}%`
          : "Этапы пока не добавлены",
        "muted",
      ),
    );
    if (stages.length) {
      const progress = node("progress");
      progress.max = stages.length;
      progress.value = completed;
      progress.setAttribute(
        "aria-label",
        `Завершено ${completed} из ${stages.length} этапов`,
      );
      card.append(progress);
      card.append(
        node(
          "p",
          current ? `Текущий этап: ${current.title}` : "Все этапы завершены",
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
  function materialCard({ project, file }) {
    const card = node("article", undefined, "review-card");
    const stage = (project.stages || []).find(
      (stage) => stage.id === file.stageId,
    );
    card.append(
      node(
        "p",
        `${project.title}${stage ? ` · ${stage.title}` : ""}${project.status === "Архив" ? " · Архив" : ""}`,
        "review-context",
      ),
      node("h3", file.name),
      node(
        "p",
        `Версия ${file.review.versionNumber} · Ожидает согласования`,
        "review-status",
      ),
    );
    const open = button(
      "Посмотреть и согласовать →",
      () =>
        hooks.openMaterial(
          project.id,
          file.review.materialId,
          file.review.versionId,
        ),
      "primary",
    );
    open.dataset.projectId = String(project.id);
    card.append(open);
    return card;
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
  function renderReview() {
    const host = $("client-review-panel");
    heading(
      host,
      "На согласование",
      "Проверьте текущую версию материала и оставьте решение в его карточке.",
    );
    const list = node("div", undefined, "review-material-list");
    pending().forEach((item) => list.append(materialCard(item)));
    if (!list.childElementCount)
      list.append(
        node(
          "p",
          "Сейчас нет материалов, ожидающих вашего согласования. История решений доступна внутри проекта.",
          "empty-note",
        ),
      );
    host.append(list);
  }
  function renderHome() {
    const host = $("client-home-panel"),
      user = hooks.getUser(),
      projects = hooks.getProjects(),
      waiting = pending();
    heading(
      host,
      `Здравствуйте, ${user.name}`,
      "Ваши проекты, материалы и последние события.",
    );
    const attention = node("section", undefined, "panel client-attention");
    attention.append(node("h2", "Нужно ваше внимание"));
    if (waiting.length) {
      attention.append(
        node("p", `Материалов на согласование: ${waiting.length}`),
      );
      attention.append(
        button(
          "Открыть материалы на согласование →",
          () => hooks.selectTab("client-review"),
          "primary",
        ),
      );
    } else
      attention.append(
        node(
          "p",
          "Сейчас от вас не требуется решений. Новые материалы появятся здесь после отправки студией.",
          "muted",
        ),
      );
    host.append(attention, node("h2", "Мои проекты"));
    const grid = node("div", undefined, "project-grid client-project-grid");
    projects.forEach((project) => grid.append(projectCard(project)));
    if (!projects.length)
      grid.append(
        node(
          "p",
          "Вам пока не назначен проект. Если работа уже началась, свяжитесь со студией.",
          "empty-note",
        ),
      );
    host.append(grid, node("h2", "Последние события"));
    const events = node("div", undefined, "client-events");
    const labels = {
      submitted: "Новый материал на согласование",
      version_uploaded: "Новая версия материала",
      admin_reply: "Ответ студии",
      approval_cancelled: "Согласование отменено",
    };
    for (const event of notifications.slice(0, 5)) {
      const card = node("article", undefined, "panel");
      card.append(
        node(
          "p",
          `${event.projectTitle} · ${date(event.createdAt)}`,
          "file-meta",
        ),
        node("h3", labels[event.type] || "Обновление проекта"),
        node("p", `${event.materialTitle} · Версия ${event.versionNumber}`),
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
      renderHome();
      renderProjects();
      renderReview();
    }
  }
  function onTab(tab) {
    if (!client()) return;
    if (tab === "client-home") {
      renderHome();
      loadNotifications();
    }
    if (tab === "client-projects") renderProjects();
    if (tab === "client-review") renderReview();
    if (tab === "profile") fillProfile();
  }
  function reset() {
    epoch++;
    notificationSeq++;
    notifications = [];
    notificationError = "";
    profileBusy = false;
    notificationsRequest = null;
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

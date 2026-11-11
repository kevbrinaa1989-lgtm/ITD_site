# Existing client homepage — exact selected rendering source

Actual branch is client-home in client-workspace.js. Preserve the generic count-based attention panel in baseline; UX improvements belong only in variants. Render greeting, attention, projects and latest events in that order. No hero/photo exists in current UI.

## client-workspace.js:3:8
```js
  const $ = (id) => document.getElementById(id);
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
```

## client-workspace.js:20:33
```js
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
```

## client-workspace.js:49:250
```js
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
```

"use strict";
(() => {
  const $ = (id) => document.getElementById(id),
    node = (tag, text, cls) => {
      const el = document.createElement(tag);
      if (text !== undefined) el.textContent = text;
      if (cls) el.className = cls;
      return el;
    };
  const statuses = {
      todo: "К выполнению",
      in_progress: "В работе",
      completed: "Выполнено",
      cancelled: "Отменено",
    },
    priorities = { normal: "Обычный", high: "Высокий", urgent: "Срочный" };
  let hooks,
    epoch = 0,
    listSeq = 0,
    detailSeq = 0,
    dashboardSeq = 0,
    projects = [],
    assignees = [],
    tasks = [],
    today = "",
    selected = null,
    dashboard = null;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const valid = (g) => g === epoch && hooks.getUser()?.role === "admin";
  const date = (value) => {
    if (!value) return "Не указана";
    const [y, m, d] = value.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("ru-RU");
  };
  const message = (text) => {
    $("task-message").textContent = text;
  };
  function button(text, action, cls = "text-button") {
    const el = node("button", text, cls);
    el.type = "button";
    el.addEventListener("click", async () => {
      const generation = epoch;
      try {
        await action();
      } catch (error) {
        if (valid(generation)) message(error.message);
      }
    });
    return el;
  }
  function reset() {
    epoch++;
    listSeq++;
    detailSeq++;
    dashboardSeq++;
    projects = [];
    assignees = [];
    tasks = [];
    today = "";
    selected = null;
    dashboard = null;
    for (const id of [
      "workspace-metrics",
      "workspace-attention",
      "workspace-deadlines",
      "task-list",
      "task-detail",
    ])
      $(id)?.replaceChildren();
    for (const id of [
      "workspace-message",
      "task-message",
      "workspace-calendar",
    ])
      $(id).textContent = "";
    $("task-filter-form").reset();
    $("workspace-project-filter").replaceChildren(
      new Option("Все активные проекты", ""),
    );
    $("workspace-type-filter").value = "";
    $("task-project-filter").replaceChildren(
      new Option("Активные проекты", ""),
    );
  }
  function options(select, items, label, value, placeholder) {
    const previous = select.value;
    select.replaceChildren(new Option(placeholder, ""));
    for (const item of items)
      select.add(new Option(label(item), String(value(item))));
    if ([...select.options].some((item) => item.value === previous))
      select.value = previous;
  }
  function metadata(result) {
    projects = result.projects;
    assignees = result.assignees;
    today = result.todayDate;
    options(
      $("task-project-filter"),
      projects,
      (p) =>
        `${p.title}${p.status === "Архив" ? " — архив" : p.status === "Завершён" ? " — завершён" : ""}`,
      (p) => p.id,
      "Активные проекты",
    );
  }
  async function loadTasks() {
    if (hooks.getUser()?.role !== "admin") return;
    const generation = epoch,
      seq = ++listSeq,
      preset = $("task-preset").value,
      query = new URLSearchParams({ timeZone: zone });
    const project = $("task-project-filter").value,
      status = $("task-status-filter").value,
      priority = $("task-priority-filter").value,
      search = $("task-search").value.trim();
    if (project) query.set("projectId", project);
    if (status) query.set("status", status);
    else if (preset === "completed") query.set("status", "completed");
    else query.set("status", "active");
    if (priority) query.set("priority", priority);
    if (search) query.set("search", search);
    if (preset === "mine") query.set("assigneeId", String(hooks.getUser().id));
    if (["today", "overdue"].includes(preset)) query.set("deadline", preset);
    if (preset === "nodue") query.set("deadline", "none");
    message("Загрузка задач…");
    try {
      const result = await hooks.api(`/api/admin/tasks?${query}`);
      if (!valid(generation) || seq !== listSeq) return;
      metadata(result);
      tasks = result.tasks;
      renderTasks();
      message("");
      return true;
    } catch (error) {
      if (valid(generation) && seq === listSeq) message(error.message);
      return false;
    }
  }
  function taskCard(task, compact = false) {
    const el = node("article", undefined, "workspace-task-card");
    el.dataset.taskId = String(task.id);
    el.append(
      node(
        "p",
        `${task.projectTitle}${task.stageTitle ? ` · ${task.stageTitle}` : ""}`,
        "workspace-context",
      ),
      node("h3", task.title),
      node(
        "p",
        `${statuses[task.status] || task.status} · ${priorities[task.priority] || task.priority}`,
        "workspace-context",
      ),
      node(
        "p",
        `${task.assigneeName || "Ответственный не указан"} · ${task.dueDate ? `Срок: ${date(task.dueDate)}` : "Без срока"}`,
        "workspace-context",
      ),
    );
    if (
      task.dueDate &&
      task.dueDate < today &&
      !["completed", "cancelled"].includes(task.status) &&
      !["Завершён", "Архив"].includes(task.projectStatus)
    )
      el.append(node("span", "Просрочена", "deadline-warning"));
    el.append(
      button(compact ? "Открыть задачу →" : "Открыть карточку →", () =>
        openTask(task.id),
      ),
    );
    return el;
  }
  function renderTasks() {
    const list = $("task-list");
    list.replaceChildren();
    for (const task of tasks) list.append(taskCard(task));
    if (!tasks.length)
      list.append(node("p", "По выбранным условиям задач нет.", "empty-note"));
  }
  function field(form, label, name, type, value, required = false) {
    const caption = node("label", label),
      input = node(type === "textarea" ? "textarea" : "input");
    if (type !== "textarea") input.type = type;
    input.name = name;
    input.value = value || "";
    input.required = required;
    input.setAttribute("aria-label", label);
    if (name === "title") input.maxLength = 200;
    if (name === "description") {
      input.maxLength = 4000;
      input.rows = 4;
    }
    caption.append(input);
    form.append(caption);
    return input;
  }
  function selectField(form, label, name, values, selectedValue, placeholder) {
    const caption = node("label", label),
      select = node("select");
    select.name = name;
    select.setAttribute("aria-label", label);
    if (placeholder) select.add(new Option(placeholder, ""));
    for (const [value, text] of values)
      select.add(new Option(text, String(value)));
    select.value = selectedValue == null ? "" : String(selectedValue);
    caption.append(select);
    form.append(caption);
    return select;
  }
  function renderEditor(task) {
    const host = $("task-detail");
    host.replaceChildren(node("h3", task ? task.title : "Новая задача"));
    if (task) {
      const details = node(
        "p",
        `Создал(а): ${task.createdByName || "Сотрудник"} · ${task.createdAt ? new Date(task.createdAt).toLocaleString("ru-RU") : "Дата не указана"}`,
        "workspace-context",
      );
      host.append(details);
    }
    const form = node("form", undefined, "workspace-task-form");
    form.id = "task-edit-form";
    field(form, "Название задачи", "title", "text", task?.title, true);
    field(form, "Описание", "description", "textarea", task?.description);
    const projectSelect = selectField(
      form,
      "Проект",
      "projectId",
      projects.map((p) => [
        p.id,
        `${p.title}${p.status === "Архив" ? " — архив" : ""}`,
      ]),
      task?.projectId,
      "Выберите проект",
    );
    projectSelect.required = true;
    const stageSelect = selectField(
      form,
      "Этап (необязательно)",
      "stageId",
      [],
      null,
      "Без этапа",
    );
    function stages(initial = false) {
      const stage = initial ? task?.stageId : stageSelect.value;
      options(
        stageSelect,
        projects.find((p) => String(p.id) === projectSelect.value)?.stages ||
          [],
        (s) => s.title,
        (s) => s.id,
        "Без этапа",
      );
      stageSelect.value = stage == null ? "" : String(stage);
      if (stageSelect.selectedIndex < 0) stageSelect.value = "";
    }
    projectSelect.addEventListener("change", () => stages());
    stages(true);
    const employee = selectField(
      form,
      "Ответственный",
      "assigneeId",
      assignees.map((p) => [p.id, p.name]),
      task?.assigneeId ??
        (!task &&
        assignees.length === 1 &&
        assignees[0].id === hooks.getUser()?.id
          ? assignees[0].id
          : null),
      "Выберите сотрудника",
    );
    employee.required = true;
    if (
      task &&
      ![...employee.options].some(
        (option) => option.value === String(task.assigneeId),
      )
    ) {
      const inactive = new Option(
        `${task.assigneeName || "Сотрудник"} — недоступен`,
        String(task.assigneeId),
      );
      employee.add(inactive);
      employee.value = String(task.assigneeId);
    }
    field(form, "Срок (необязательно)", "dueDate", "date", task?.dueDate);
    selectField(
      form,
      "Приоритет",
      "priority",
      Object.entries(priorities),
      task?.priority || "normal",
    );
    selectField(
      form,
      "Статус",
      "status",
      Object.entries(statuses),
      task?.status || "todo",
    );
    const save = node(
      "button",
      task ? "Сохранить задачу" : "Создать задачу",
      "primary",
    );
    save.type = "submit";
    form.append(
      save,
      button("Отмена", () => {
        detailSeq++;
        selected = null;
        host.replaceChildren(
          node("p", "Выберите задачу или создайте новую.", "muted"),
        );
      }),
    );
    host.append(form);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (form.dataset.busy) return;
      const values = Object.fromEntries(new FormData(form)),
        generation = epoch,
        seq = detailSeq;
      const payload = {
        title: values.title,
        description: values.description,
        projectId: Number(values.projectId),
        stageId: values.stageId ? Number(values.stageId) : null,
        assigneeId: Number(values.assigneeId),
        dueDate: values.dueDate || null,
        priority: values.priority,
        status: values.status,
        ...(task ? { expectedRevision: task.revision } : {}),
      };
      const controls = [
        ...form.querySelectorAll("input,textarea,select,button"),
      ];
      form.dataset.busy = "true";
      controls.forEach((el) => (el.disabled = true));
      try {
        const result = await hooks.api(
          task ? `/api/admin/tasks/${task.id}` : "/api/admin/tasks",
          task ? "PATCH" : "POST",
          payload,
        );
        if (!valid(generation) || seq !== detailSeq) return;
        await loadTasks();
        if (!valid(generation) || seq !== detailSeq) return;
        const id = result.task?.id || result.id || task?.id;
        if (id) await openTask(id);
        else renderEditor(null);
        message(task ? "Задача обновлена." : "Задача создана.");
      } catch (error) {
        if (valid(generation) && seq === detailSeq) {
          if (error.status === 409 && task) {
            await openTask(task.id);
            message(
              "Задача уже изменилась. Показана актуальная карточка; повторите изменения.",
            );
          } else message(error.message);
        }
      } finally {
        delete form.dataset.busy;
        controls.forEach((el) => (el.disabled = false));
      }
    });
  }
  async function openTask(id) {
    const generation = epoch,
      seq = ++detailSeq;
    selected = Number(id);
    hooks.selectTab("tasks");
    const host = $("task-detail");
    host.replaceChildren(node("p", "Загрузка задачи…", "muted"));
    try {
      const result = await hooks.api(`/api/admin/tasks/${id}`);
      if (!valid(generation) || seq !== detailSeq) return;
      const loaded = await loadTasks();
      if (!loaded || !valid(generation) || seq !== detailSeq) return;
      renderEditor(result.task);
      host.tabIndex = -1;
      host.focus({ preventScroll: true });
      host.scrollIntoView({ block: "start" });
    } catch (error) {
      if (valid(generation) && seq === detailSeq) message(error.message);
    }
  }
  async function newTask() {
    const generation = epoch,
      seq = ++detailSeq;
    selected = null;
    hooks.selectTab("tasks");
    const loaded = await loadTasks();
    if (!loaded || !valid(generation) || seq !== detailSeq) return;
    renderEditor(null);
    const host = $("task-detail");
    host.tabIndex = -1;
    host.focus({ preventScroll: true });
    host.scrollIntoView({ block: "start" });
  }
  function group(host, title, items, render) {
    const section = node("section", undefined, "workspace-section");
    section.append(node("h2", title));
    const list = node("div", undefined, "workspace-item-list");
    for (const item of items) list.append(render(item));
    if (!items.length) list.append(node("p", "Нет записей.", "empty-note"));
    section.append(list);
    host.append(section);
  }
  function materialCard(material, waiting = false) {
    const card = node("article", undefined, "workspace-attention-card");
    card.append(
      node(
        "p",
        `${material.projectTitle} · ${material.stageTitle}${material.clientName ? ` · ${material.clientName}` : ""}`,
        "workspace-context",
      ),
      node("h3", material.title),
    );
    if (waiting) {
      card.append(
        node(
          "p",
          `${material.viewed ? "Просмотрено клиентом" : "Не просмотрено клиентом"} · Ожидание: ${material.waitingDays} дн.`,
          "workspace-context",
        ),
        node(
          "p",
          `Версия ${material.versionNumber || "—"} · Отправлено: ${material.sentAt ? new Date(material.sentAt).toLocaleString("ru-RU") : "Не указано"}${material.firstViewedAt ? ` · Первый просмотр: ${new Date(material.firstViewedAt).toLocaleString("ru-RU")}` : ""}`,
          "workspace-context",
        ),
      );
    } else {
      const statusLabel =
        {
          pending_approval: "Ожидает согласования",
          changes_requested: "Нужны изменения",
          approved: "Согласован",
        }[material.status] || material.status;
      card.append(
        node(
          "p",
          `Версия ${material.versionNumber} · ${statusLabel} · ${material.createdAt ? new Date(material.createdAt).toLocaleString("ru-RU") : "Дата не указана"}`,
          "workspace-context",
        ),
      );
      if (material.reasons.includes("changes_requested"))
        card.append(node("span", "Клиент просит изменения", "workspace-tag"));
      if (material.reasons.includes("unanswered_comment"))
        card.append(node("span", "Ожидает ответа студии", "workspace-tag"));
      if (material.lastClientMessage)
        card.append(
          node("p", material.lastClientMessage.body, "workspace-comment"),
          node(
            "p",
            `${material.lastClientMessage.actorName || "Клиент"} · ${new Date(material.lastClientMessage.createdAt).toLocaleString("ru-RU")}`,
            "workspace-context",
          ),
        );
    }
    card.append(
      button("Открыть материал →", () =>
        hooks.openMaterial(
          material.projectId,
          material.materialId,
          material.versionId,
        ),
      ),
    );
    return card;
  }
  function stageCard(stage) {
    const card = node("article", undefined, "workspace-attention-card");
    card.append(
      node("p", stage.projectTitle, "workspace-context"),
      node("h3", stage.title),
      node(
        "p",
        `Начало: ${date(stage.startDate)} · Завершение: ${date(stage.plannedEndDate)}`,
        "workspace-context",
      ),
      button("Открыть этап →", () =>
        hooks.openStage(stage.projectId, stage.id),
      ),
    );
    return card;
  }
  async function loadDashboard() {
    if (hooks.getUser()?.role !== "admin") return;
    const generation = epoch,
      seq = ++dashboardSeq;
    $("workspace-message").textContent = "Загрузка обзора…";
    try {
      const result = await hooks.api(
        `/api/admin/workspace?timeZone=${encodeURIComponent(zone)}`,
      );
      if (!valid(generation) || seq !== dashboardSeq) return;
      dashboard = result;
      options(
        $("workspace-project-filter"),
        result.projects.filter(
          (project) => !["Завершён", "Архив"].includes(project.status),
        ),
        (p) => p.title,
        (p) => p.id,
        "Все активные проекты",
      );
      today = result.todayDate;
      projects = result.projects;
      assignees = result.assignees;
      $("workspace-calendar").textContent =
        `${date(today)} · Часовой пояс: ${result.timeZone}`;
      const metrics = $("workspace-metrics");
      metrics.replaceChildren();
      for (const [key, label, action] of [
        [
          "activeProjects",
          "Активные проекты",
          () => hooks.selectTab("projects"),
        ],
        [
          "pendingApproval",
          "Ждём согласования",
          () => $("workspace-waiting").scrollIntoView({ block: "start" }),
        ],
        ["changesRequested", "Нужны изменения", () => focusAttention()],
        ["unansweredThreads", "Ждут ответа студии", () => focusAttention()],
        ["todayTasks", "Задачи на сегодня", () => taskPreset("today")],
        ["overdueTasks", "Просроченные задачи", () => taskPreset("overdue")],
      ]) {
        const metric = button("", action, "workspace-metric");
        metric.dataset.metric = key;
        metric.append(
          node("strong", String(result.counts[key])),
          node("span", label),
        );
        metrics.append(metric);
      }
      const attention = $("workspace-attention");
      attention.replaceChildren();
      renderAttention();
      const deadlines = $("workspace-deadlines");
      deadlines.replaceChildren();
      for (const [key, title] of [
        ["overdue", "Просрочено"],
        ["today", "На сегодня"],
        ["upcoming", "Ближайшие 7 дней"],
      ]) {
        const period = node("section", undefined, "workspace-period");
        period.append(node("h2", title));
        group(period, "Задачи", result[key].tasks, (t) => taskCard(t, true));
        group(period, "Этапы", result[key].stages, stageCard);
        deadlines.append(period);
      }
      $("workspace-message").textContent = "";
    } catch (error) {
      if (valid(generation) && seq === dashboardSeq)
        $("workspace-message").textContent = error.message;
    }
  }
  function renderAttention() {
    if (!dashboard) return;
    const host = $("workspace-attention");
    host.replaceChildren();
    const project = $("workspace-project-filter").value,
      type = $("workspace-type-filter").value;
    group(
      host,
      "Требует действий студии",
      dashboard.attention.filter(
        (item) =>
          (!project || String(item.projectId) === project) &&
          (!type || item.reasons.includes(type)),
      ),
      (m) => materialCard(m),
    );
    const waiting = node("section");
    waiting.id = "workspace-waiting";
    const rows = dashboard.waiting.filter(
      (item) => !project || String(item.projectId) === project,
    );
    group(
      waiting,
      "Ожидаем решения клиента · не просмотрено",
      rows.filter((m) => !m.viewed),
      (m) => materialCard(m, true),
    );
    group(
      waiting,
      "Ожидаем решения клиента · просмотрено",
      rows.filter((m) => m.viewed),
      (m) => materialCard(m, true),
    );
    host.append(waiting);
  }
  function focusAttention() {
    $("workspace-attention").scrollIntoView({ block: "start" });
  }
  function taskPreset(value) {
    $("task-preset").value = value;
    $("task-status-filter").value = "";
    hooks.selectTab("tasks");
  }
  function init(options) {
    hooks = options;
    for (const [id, values] of [
      ["task-status-filter", statuses],
      ["task-priority-filter", priorities],
    ])
      for (const [value, label] of Object.entries(values))
        $(id).add(new Option(label, value));
    $("task-filter-form").addEventListener("submit", (event) => {
      event.preventDefault();
      loadTasks();
    });
    for (const id of [
      "task-preset",
      "task-project-filter",
      "task-status-filter",
      "task-priority-filter",
    ])
      $(id).addEventListener("change", loadTasks);
    $("task-new-button").addEventListener("click", newTask);
    $("workspace-new-task").addEventListener("click", newTask);
    $("workspace-new-project").addEventListener("click", () => {
      if (hooks.getUser()?.role !== "admin") return;
      hooks.selectTab("management");
      const form = $("create-project-form"),
        details = form.closest("details");
      if (details) details.open = true;
      form.scrollIntoView({ block: "start" });
      form.elements.namedItem("title").focus({ preventScroll: true });
    });
    $("workspace-refresh").addEventListener("click", loadDashboard);
    for (const id of ["workspace-project-filter", "workspace-type-filter"])
      $(id).addEventListener("change", renderAttention);
  }
  function onTab(tab) {
    if (tab === "workspace") loadDashboard();
    if (tab === "tasks") loadTasks();
  }
  window.ITDWorkspace = { init, reset, onTab, openTask };
})();

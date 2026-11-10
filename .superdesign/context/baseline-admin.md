# Existing administrator homepage — exact selected rendering source

Actual branch is workspace. Six metric cards in three desktop columns / two mobile columns, quick actions, two attention filters, studio actions, client waiting split by viewed, then three deadline periods. Baseline retains empty groups; collapsing them is a redesign. Callback-only logic can be mocked.

## admin-workspace.js:3:16
```js
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
```

## admin-workspace.js:139:173
```js
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
```

## admin-workspace.js:408:494
```js
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
```

## admin-workspace.js:510:563
```js
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
```

## admin-workspace.js:568:602
```js
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
```

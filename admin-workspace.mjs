const TASK_STATUSES = ["todo", "in_progress", "completed", "cancelled"];
const PRIORITIES = ["normal", "high", "urgent"];
const iso = (value) => (value == null ? null : new Date(value).toISOString());
export function validCalendarDate(value) {
  if (value === null) return true;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(value + "T00:00:00.000Z");
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
export function validateStageDates(body, current, fail) {
  const startDate =
    "startDate" in body ? body.startDate : (current?.startDate ?? null);
  const plannedEndDate =
    "plannedEndDate" in body
      ? body.plannedEndDate
      : (current?.plannedEndDate ?? null);
  if (!validCalendarDate(startDate) || !validCalendarDate(plannedEndDate))
    fail(400, "Укажите существующую дату в формате ГГГГ-ММ-ДД");
  if (startDate && plannedEndDate && startDate > plannedEndDate)
    fail(400, "Плановая дата завершения не может быть раньше начала");
  return { startDate, plannedEndDate };
}
export function initAdminWorkspace({ db, now = Date.now }) {
  const get = (sql, ...args) => db.prepare(sql).get(...args),
    all = (sql, ...args) => db.prepare(sql).all(...args),
    run = (sql, ...args) => db.prepare(sql).run(...args);
  const transaction = (action) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  transaction(() => {
    const columns = new Set(
      all("PRAGMA table_info(stages)").map((c) => c.name),
    );
    if (!columns.has("startDate"))
      db.exec("ALTER TABLE stages ADD COLUMN startDate TEXT");
    if (!columns.has("plannedEndDate"))
      db.exec("ALTER TABLE stages ADD COLUMN plannedEndDate TEXT");
    db.exec(`CREATE TABLE IF NOT EXISTS admin_tasks(
      id INTEGER PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',projectId INTEGER NOT NULL REFERENCES projects(id),
      stageId INTEGER REFERENCES stages(id),assigneeId INTEGER NOT NULL REFERENCES users(id),createdBy INTEGER NOT NULL REFERENCES users(id),
      createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,dueDate TEXT,priority TEXT NOT NULL DEFAULT 'normal',status TEXT NOT NULL DEFAULT 'todo',revision INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS admin_tasks_project ON admin_tasks(projectId,stageId);
      CREATE INDEX IF NOT EXISTS admin_tasks_assignee ON admin_tasks(assigneeId,status,dueDate);`);
  });
  function audit(type, user, projectId, payload) {
    const p = get("SELECT clientId FROM projects WHERE id=?", projectId);
    run(
      "INSERT INTO admin_management_events(type,actorId,clientId,projectId,payload,createdAt) VALUES(?,?,?,?,?,?)",
      type,
      user.id,
      p.clientId,
      projectId,
      JSON.stringify(payload),
      now(),
    );
  }
  function auditStageDates(user, projectId, stageId, previous, dates) {
    if (
      (previous?.startDate ?? null) !== dates.startDate ||
      (previous?.plannedEndDate ?? null) !== dates.plannedEndDate
    )
      audit("stage.dates_changed", user, projectId, {
        stageId,
        oldStartDate: previous?.startDate ?? null,
        newStartDate: dates.startDate,
        oldPlannedEndDate: previous?.plannedEndDate ?? null,
        newPlannedEndDate: dates.plannedEndDate,
      });
  }
  const taskSelect = `SELECT t.*,p.title AS projectTitle,p.status AS projectStatus,s.title AS stageTitle,u.name AS assigneeName,c.name AS createdByName FROM admin_tasks t JOIN projects p ON p.id=t.projectId LEFT JOIN stages s ON s.id=t.stageId JOIN users u ON u.id=t.assigneeId JOIN users c ON c.id=t.createdBy`;
  const task = (row) =>
    row && {
      ...row,
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    };
  const active = (p) =>
    !["Завершён", "Архив"].includes(p.status ?? p.projectStatus);
  const open = (t) => !["completed", "cancelled"].includes(t.status);
  function calendar(url, fail) {
    const input = url.searchParams.get("timeZone") ?? "UTC";
    let timeZone, formatter;
    if (input.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(input))
      fail(400, "Неизвестный часовой пояс");
    try {
      formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: input,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      timeZone = formatter.resolvedOptions().timeZone;
    } catch {
      fail(400, "Неизвестный часовой пояс");
    }
    const parts = formatter.formatToParts(new Date(now())),
      part = (type) => parts.find((p) => p.type === type).value;
    const todayDate = `${part("year")}-${part("month")}-${part("day")}`;
    const day = (date) => Date.parse(date + "T00:00:00Z") / 86400000,
      today = day(todayDate);
    const bucket = (date) =>
      !date
        ? "none"
        : day(date) < today
          ? "overdue"
          : day(date) === today
            ? "today"
            : day(date) <= today + 7
              ? "upcoming"
              : "later";
    return { timeZone, todayDate, day, today, bucket, formatter };
  }
  const options = () => ({
    projects: all("SELECT id,title,status FROM projects ORDER BY title,id").map(
      (p) => ({
        ...p,
        stages: all(
          "SELECT id,title,status,startDate,plannedEndDate FROM stages WHERE projectId=? ORDER BY id",
          p.id,
        ),
      }),
    ),
    assignees: all(
      "SELECT id,name FROM users WHERE role='admin' AND isActive=1 ORDER BY name,id",
    ),
  });
  const strict = (b, allowed, fail) => {
    if (Object.keys(b).some((key) => !allowed.includes(key)))
      fail(400, "Недопустимые поля запроса");
  };
  const editable = [
    "title",
    "description",
    "projectId",
    "stageId",
    "assigneeId",
    "dueDate",
    "priority",
    "status",
  ];
  function validateTask(b, previous, fail) {
    const result = {
      title: previous?.title ?? "",
      description: previous?.description ?? "",
      projectId: previous?.projectId,
      stageId: previous?.stageId ?? null,
      assigneeId: previous?.assigneeId,
      dueDate: previous?.dueDate ?? null,
      priority: previous?.priority ?? "normal",
      status: previous?.status ?? "todo",
    };
    for (const key of editable) if (key in b) result[key] = b[key];
    if (
      typeof result.title !== "string" ||
      !result.title.trim() ||
      result.title.length > 200 ||
      typeof result.description !== "string" ||
      result.description.length > 4000
    )
      fail(400, "Укажите название до 200 и описание до 4000 символов");
    result.title = result.title.trim();
    if (
      !Number.isSafeInteger(result.projectId) ||
      !get("SELECT id FROM projects WHERE id=?", result.projectId)
    )
      fail(400, "Проект не найден");
    if (
      result.stageId !== null &&
      (!Number.isSafeInteger(result.stageId) ||
        !get(
          "SELECT id FROM stages WHERE id=? AND projectId=?",
          result.stageId,
          result.projectId,
        ))
    )
      fail(400, "Этап не принадлежит выбранному проекту");
    if (
      !Number.isSafeInteger(result.assigneeId) ||
      !get(
        "SELECT id FROM users WHERE id=? AND role='admin' AND isActive=1",
        result.assigneeId,
      )
    )
      fail(400, "Выберите действующего сотрудника");
    if (
      !validCalendarDate(result.dueDate) ||
      !PRIORITIES.includes(result.priority) ||
      !TASK_STATUSES.includes(result.status)
    )
      fail(400, "Некорректный срок, приоритет или статус задачи");
    return result;
  }
  const taskFields = (t) => editable.map((key) => t[key]);
  function taskEvents(user, id, previous, next) {
    const changes = Object.fromEntries(
      editable
        .filter((k) => previous?.[k] !== next[k])
        .map((k) => [k, { old: previous?.[k] ?? null, new: next[k] }]),
    );
    audit(previous ? "task.updated" : "task.created", user, next.projectId, {
      taskId: id,
      changes,
    });
    if (previous && previous.dueDate !== next.dueDate)
      audit("task.due_date_changed", user, next.projectId, {
        taskId: id,
        oldDueDate: previous.dueDate,
        newDueDate: next.dueDate,
      });
    if (
      previous &&
      previous.status !== next.status &&
      ["completed", "cancelled"].includes(next.status)
    )
      audit("task." + next.status, user, next.projectId, {
        taskId: id,
        oldStatus: previous.status,
        newStatus: next.status,
      });
  }
  function dashboard(cal) {
    const projects = all("SELECT id,title,status FROM projects").filter(active);
    const ids = new Set(projects.map((p) => p.id));
    const tasks = all(taskSelect + " ORDER BY t.dueDate IS NULL,t.dueDate,t.id")
      .map(task)
      .filter((t) => ids.has(t.projectId) && open(t));
    const stages = all(
      `SELECT s.id,s.title,s.status,s.projectId,p.title AS projectTitle,s.startDate,s.plannedEndDate FROM stages s JOIN projects p ON p.id=s.projectId ORDER BY s.plannedEndDate IS NULL,s.plannedEndDate,s.id`,
    ).filter((s) => ids.has(s.projectId) && s.status !== "completed");
    const versions =
      all(`SELECT m.id AS materialId,v.id AS versionId,v.versionNumber,m.projectId,p.title AS projectTitle,m.stageId,s.title AS stageTitle,m.title,v.status,v.createdAt,p.clientId,u.name AS clientName,u.email AS clientEmail,w.firstViewedAt,w.lastViewedAt,
      NOT EXISTS(SELECT 1 FROM review_versions n WHERE n.materialId=m.id AND n.versionNumber>v.versionNumber) AS isCurrent
      FROM review_materials m JOIN review_versions v ON v.materialId=m.id JOIN projects p ON p.id=m.projectId JOIN users u ON u.id=p.clientId JOIN stages s ON s.id=m.stageId LEFT JOIN review_views w ON w.versionId=v.id AND w.userId=p.clientId ORDER BY v.createdAt,v.id`).filter(
        (m) => ids.has(m.projectId),
      );
    const current = versions.filter((v) => v.isCurrent),
      attention = [],
      waiting = [];
    for (const m of versions) {
      const clientMessage = get(
        "SELECT e.id,e.body,e.createdAt,u.name AS actorName FROM review_events e JOIN users u ON u.id=e.actorId WHERE e.versionId=? AND e.type IN ('comment','changes_requested') AND length(trim(e.body))>0 ORDER BY e.id DESC LIMIT 1",
        m.versionId,
      );
      const reply = get(
        "SELECT max(id) AS id FROM review_events WHERE versionId=? AND type='admin_reply'",
        m.versionId,
      );
      const unanswered = clientMessage && clientMessage.id > (reply?.id ?? 0);
      const reasons = [];
      if (m.isCurrent && m.status === "changes_requested")
        reasons.push("changes_requested");
      if (unanswered) reasons.push("unanswered_comment");
      const base = {
        materialId: m.materialId,
        versionId: m.versionId,
        versionNumber: m.versionNumber,
        isCurrent: !!m.isCurrent,
        projectId: m.projectId,
        projectTitle: m.projectTitle,
        clientName: m.clientName,
        clientEmail: m.clientEmail,
        stageId: m.stageId,
        stageTitle: m.stageTitle,
        title: m.title,
        status: m.status,
      };
      if (reasons.length)
        attention.push({
          ...base,
          reasons,
          createdAt: iso(clientMessage?.createdAt ?? m.createdAt),
          lastClientMessage: clientMessage
            ? {
                body: clientMessage.body,
                createdAt: iso(clientMessage.createdAt),
                actorName: clientMessage.actorName,
              }
            : null,
        });
      if (m.isCurrent && m.status === "pending_approval") {
        const cycle = get(
          "SELECT createdAt FROM review_events WHERE versionId=? AND type IN ('submitted','version_uploaded','approval_cancelled') ORDER BY id DESC LIMIT 1",
          m.versionId,
        );
        const sentAt = cycle?.createdAt ?? m.createdAt;
        const parts = cal.formatter.formatToParts(new Date(sentAt)),
          part = (type) => parts.find((p) => p.type === type).value,
          sentDate = `${part("year")}-${part("month")}-${part("day")}`;
        waiting.push({
          ...base,
          sentAt: iso(sentAt),
          viewed: !!m.firstViewedAt,
          firstViewedAt: iso(m.firstViewedAt),
          lastViewedAt: iso(m.lastViewedAt),
          waitingDays: Math.max(0, cal.today - cal.day(sentDate)),
        });
      }
    }
    waiting.sort(
      (a, b) => a.sentAt.localeCompare(b.sentAt) || a.versionId - b.versionId,
    );
    attention.sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.versionId - b.versionId,
    );
    const group = (key) => ({
      tasks: tasks.filter((t) => cal.bucket(t.dueDate) === key),
      stages: stages.filter((s) => cal.bucket(s.plannedEndDate) === key),
    });
    const today = group("today"),
      upcoming = group("upcoming"),
      overdue = group("overdue");
    return {
      counts: {
        activeProjects: projects.length,
        changesRequested: current.filter(
          (m) => m.status === "changes_requested",
        ).length,
        unansweredThreads: attention.filter((m) =>
          m.reasons.includes("unanswered_comment"),
        ).length,
        pendingApproval: waiting.length,
        unviewedPending: waiting.filter((m) => !m.viewed).length,
        overdueStages: overdue.stages.length,
        overdueTasks: overdue.tasks.length,
        todayTasks: today.tasks.length,
        upcomingTasks: upcoming.tasks.length,
        openTasks: tasks.length,
      },
      attention,
      waiting,
      today,
      upcoming,
      overdue,
      ...options(),
      todayDate: cal.todayDate,
      timeZone: cal.timeZone,
    };
  }
  async function handle({
    req,
    res,
    path,
    method,
    url,
    user,
    body,
    json,
    fail,
  }) {
    if (path !== "/api/admin/workspace" && !path.startsWith("/api/admin/tasks"))
      return false;
    if (!user) fail(401, "Войдите в кабинет");
    if (user.role !== "admin") fail(403, "Нет доступа");
    if (path === "/api/admin/workspace" && method === "GET") {
      const cal = calendar(url, fail);
      json(res, 200, dashboard(cal));
      return true;
    }
    if (path === "/api/admin/tasks" && method === "GET") {
      const cal = calendar(url, fail),
        params = url.searchParams;
      const parseId = (key) => {
        if (!params.has(key) || params.get(key) === "") return null;
        const value = params.get(key);
        if (
          !/^\d+$/.test(value) ||
          !Number.isSafeInteger(Number(value)) ||
          Number(value) < 1
        )
          fail(400, "Некорректный фильтр");
        return Number(value);
      };
      const projectId = parseId("projectId"),
        stageId = parseId("stageId"),
        assigneeId = parseId("assigneeId"),
        status = params.get("status") || null,
        priority = params.get("priority") || null,
        deadline = params.get("deadline") || null,
        search = params.get("search") || "";
      if (
        (status && status !== "active" && !TASK_STATUSES.includes(status)) ||
        (priority && !PRIORITIES.includes(priority)) ||
        (deadline &&
          !["today", "upcoming", "overdue", "none"].includes(deadline)) ||
        search.length > 200
      )
        fail(400, "Некорректный фильтр");
      let tasks = all(
        taskSelect + " ORDER BY t.dueDate IS NULL,t.dueDate,t.id DESC",
      )
        .map(task)
        .filter((t) =>
          projectId
            ? t.projectId === projectId
            : active({ status: t.projectStatus }),
        );
      const q = search.toLocaleLowerCase("ru");
      tasks = tasks.filter(
        (t) =>
          (!stageId || t.stageId === stageId) &&
          (!assigneeId || t.assigneeId === assigneeId) &&
          (!status || (status === "active" ? open(t) : t.status === status)) &&
          (!priority || t.priority === priority) &&
          (!deadline ||
            (open(t) &&
              (deadline === "none" || active({ status: t.projectStatus })) &&
              cal.bucket(t.dueDate) === deadline)) &&
          (!q ||
            [
              t.title,
              t.description,
              t.projectTitle,
              t.stageTitle ?? "",
              t.assigneeName,
            ].some((value) => value.toLocaleLowerCase("ru").includes(q))),
      );
      json(res, 200, {
        tasks,
        ...options(),
        todayDate: cal.todayDate,
        timeZone: cal.timeZone,
      });
      return true;
    }
    if (path === "/api/admin/tasks" && method === "POST") {
      const b = await body(req);
      strict(b, editable, fail);
      let id;
      transaction(() => {
        const next = validateTask(b, null, fail),
          timestamp = now();
        id = Number(
          run(
            "INSERT INTO admin_tasks(title,description,projectId,stageId,assigneeId,dueDate,priority,status,createdBy,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            ...taskFields(next),
            user.id,
            timestamp,
            timestamp,
          ).lastInsertRowid,
        );
        taskEvents(user, id, null, next);
      });
      json(res, 201, { task: task(get(taskSelect + " WHERE t.id=?", id)) });
      return true;
    }
    const match = path.match(/^\/api\/admin\/tasks\/(\d+)$/);
    if (match) {
      const id = Number(match[1]);
      if (!get("SELECT id FROM admin_tasks WHERE id=?", id))
        fail(404, "Задача не найдена");
      if (method === "GET") {
        json(res, 200, { task: task(get(taskSelect + " WHERE t.id=?", id)) });
        return true;
      }
      if (method === "PATCH") {
        const b = await body(req);
        strict(b, [...editable, "expectedRevision"], fail);
        if (!editable.some((key) => key in b))
          fail(400, "Укажите изменения задачи");
        transaction(() => {
          const previous = get("SELECT * FROM admin_tasks WHERE id=?", id);
          if (
            !Number.isSafeInteger(b.expectedRevision) ||
            b.expectedRevision !== previous.revision
          )
            fail(409, "Задача изменилась. Обновите данные");
          const next = validateTask(b, previous, fail);
          const updated = run(
            "UPDATE admin_tasks SET title=?,description=?,projectId=?,stageId=?,assigneeId=?,dueDate=?,priority=?,status=?,updatedAt=?,revision=revision+1 WHERE id=? AND revision=?",
            ...taskFields(next),
            now(),
            id,
            b.expectedRevision,
          );
          if (!updated.changes) fail(409, "Задача изменилась. Обновите данные");
          taskEvents(user, id, previous, next);
        });
        json(res, 200, { task: task(get(taskSelect + " WHERE t.id=?", id)) });
        return true;
      }
    }
    fail(404, "Маршрут не найден");
  }
  return { handle, transaction, auditStageDates };
}

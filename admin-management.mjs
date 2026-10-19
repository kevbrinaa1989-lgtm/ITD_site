import { decorateReviewFiles } from "./material-review.mjs";
const STATUSES = ["Новый", "В работе", "На паузе", "Завершён", "Архив"];
const iso = (value) => (value == null ? null : new Date(value).toISOString());
export function initAdminManagement({ db, now = Date.now }) {
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const tx = (action) => {
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
  tx(() => {
    const userColumns = new Set(
      all("PRAGMA table_info(users)").map((c) => c.name),
    );
    if (!userColumns.has("createdAt"))
      db.exec("ALTER TABLE users ADD COLUMN createdAt INTEGER");
    if (!userColumns.has("isActive"))
      db.exec(
        "ALTER TABLE users ADD COLUMN isActive INTEGER NOT NULL DEFAULT 1",
      );
    const projectColumns = new Set(
      all("PRAGMA table_info(projects)").map((c) => c.name),
    );
    if (!projectColumns.has("createdAt"))
      db.exec("ALTER TABLE projects ADD COLUMN createdAt INTEGER");
    if (!projectColumns.has("archivedFrom"))
      db.exec("ALTER TABLE projects ADD COLUMN archivedFrom TEXT");
    db.exec(`CREATE TABLE IF NOT EXISTS admin_management_events(
      id INTEGER PRIMARY KEY,type TEXT NOT NULL,actorId INTEGER NOT NULL REFERENCES users(id),
      clientId INTEGER REFERENCES users(id),relatedClientId INTEGER REFERENCES users(id),
      projectId INTEGER REFERENCES projects(id),payload TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS admin_events_client ON admin_management_events(clientId,id);
      CREATE INDEX IF NOT EXISTS admin_events_project ON admin_management_events(projectId,id);`);
  });
  const audit = (
    type,
    actorId,
    clientId,
    projectId,
    payload = {},
    relatedClientId = null,
  ) =>
    run(
      "INSERT INTO admin_management_events(type,actorId,clientId,relatedClientId,projectId,payload,createdAt) VALUES(?,?,?,?,?,?,?)",
      type,
      actorId,
      clientId,
      relatedClientId,
      projectId,
      JSON.stringify(payload),
      now(),
    );
  const clientsSelect = `SELECT u.id,u.name,u.email,u.createdAt,u.isActive,(SELECT count(*) FROM projects p WHERE p.clientId=u.id) AS projectCount FROM users u WHERE u.role='client'`;
  const client = (row) =>
    row && { ...row, createdAt: iso(row.createdAt), isActive: !!row.isActive };
  const projectsSelect = `SELECT p.id,p.title,p.clientId,p.status,p.createdAt,p.archivedFrom,u.name AS clientName,u.email AS clientEmail,
    (SELECT count(*) FROM stages s WHERE s.projectId=p.id) AS stageCount,
    (SELECT count(*) FROM stages s WHERE s.projectId=p.id AND s.status='completed') AS completedStageCount FROM projects p JOIN users u ON u.id=p.clientId`;
  const project = (row) =>
    row && {
      ...row,
      createdAt: iso(row.createdAt),
      progress: row.stageCount
        ? Math.round((row.completedStageCount / row.stageCount) * 100)
        : null,
      stages: all(
        "SELECT id,title,status,description FROM stages WHERE projectId=? ORDER BY id",
        row.id,
      ),
      files: decorateReviewFiles(db, all(
        "SELECT id,name,contentType,category,stageId,size FROM files WHERE projectId=? ORDER BY id",
        row.id,
      )),
    };
  function history(where, args, clientId) {
    const events = all(
      `SELECT e.id,e.type,e.clientId,e.relatedClientId,e.projectId,e.payload,e.createdAt,u.name AS actorName FROM admin_management_events e JOIN users u ON u.id=e.actorId WHERE ${where}`,
      ...args,
    ).map((e) => ({
      ...e,
      id: "management:" + e.id,
      source: "management",
      payload: JSON.parse(e.payload),
      createdAt: iso(e.createdAt),
    }));
    if (clientId != null)
      for (const e of all(
        `SELECT e.id,e.type,e.createdAt,e.requestId,u.name AS actorName FROM password_recovery_events e JOIN password_recovery_requests r ON r.id=e.requestId LEFT JOIN users u ON u.id=e.actorId WHERE r.userId=?`,
        clientId,
      ))
        events.push({
          ...e,
          id: "recovery:" + e.id,
          type: "recovery." + e.type,
          source: "recovery",
          payload: { requestId: e.requestId },
          createdAt: iso(e.createdAt),
        });
    return events.sort(
      (a, b) =>
        b.createdAt.localeCompare(a.createdAt) ||
        a.source.localeCompare(b.source) ||
        b.id.localeCompare(a.id, undefined, { numeric: true }),
    );
  }
  const checkBody = (b, allowed, fail) => {
    if (
      !Object.keys(b).length ||
      Object.keys(b).some((k) => !allowed.includes(k))
    )
      fail(400, "Недопустимые поля запроса");
  };
  const titleValid = (value) =>
    typeof value === "string" && value.trim().length > 0 && value.length <= 200;
  return async function handle({
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
    const supported =
      path.startsWith("/api/admin/clients") ||
      path.startsWith("/api/admin/projects") ||
      path === "/api/clients" ||
      (path === "/api/projects" && ["GET", "POST"].includes(method));
    if (!supported) return false;
    if (!user) fail(401, "Войдите в кабинет");
    if (path === "/api/projects" && method === "GET") {
      const rows = all(
        projectsSelect +
          (user.role === "admin" ? "" : " WHERE p.clientId=?") +
          " ORDER BY p.id DESC",
        ...(user.role === "admin" ? [] : [user.id]),
      );
      json(res, 200, { projects: rows.map(project) });
      return true;
    }
    if (user.role !== "admin") fail(403, "Нет доступа");
    if (path === "/api/clients" && method === "GET") {
      json(res, 200, {
        clients: all(clientsSelect + " ORDER BY u.name,u.id").map(client),
      });
      return true;
    }
    if (path === "/api/projects" && method === "POST") {
      const b = await body(req);
      checkBody(b, ["title", "clientId", "status"], fail);
      const status = b.status ?? "Новый";
      if (
        !titleValid(b.title) ||
        !Number.isSafeInteger(b.clientId) ||
        !STATUSES.slice(0, 4).includes(status)
      )
        fail(400, "Укажите название, клиента и допустимый статус");
      const id = tx(() => {
        if (
          !get(
            "SELECT id FROM users WHERE id=? AND role='client' AND isActive=1",
            b.clientId,
          )
        )
          fail(400, "Активный клиент не найден");
        const id = Number(
          run(
            "INSERT INTO projects(title,clientId,status,createdAt) VALUES(?,?,?,?)",
            b.title.trim(),
            b.clientId,
            status,
            now(),
          ).lastInsertRowid,
        );
        audit("project.created", user.id, b.clientId, id, {
          title: b.title.trim(),
          clientId: b.clientId,
          status,
        });
        return id;
      });
      json(res, 201, { id });
      return true;
    }
    if (path === "/api/admin/projects" && method === "GET") {
      const search = url.searchParams.get("search") ?? "",
        status = url.searchParams.get("status") ?? "active";
      if (
        search.length > 200 ||
        !(status === "active" || STATUSES.includes(status))
      )
        fail(400, "Некорректный фильтр");
      const rows = all(
        projectsSelect +
          " WHERE " +
          (status === "active" ? "p.status<>'Архив'" : "p.status=?") +
          " ORDER BY p.id DESC",
        ...(status === "active" ? [] : [status]),
      );
      const q = search.toLocaleLowerCase("ru");
      json(res, 200, {
        projects: rows
          .filter((p) =>
            [p.title, p.clientName, p.clientEmail].some((v) =>
              v.toLocaleLowerCase("ru").includes(q),
            ),
          )
          .map(project),
      });
      return true;
    }
    let match = path.match(/^\/api\/admin\/clients\/(\d+)$/);
    if (match) {
      const id = Number(match[1]);
      let c = client(get(clientsSelect + " AND u.id=?", id));
      if (!c) fail(404, "Клиент не найден");
      if (method === "GET") {
        json(res, 200, {
          client: c,
          projects: all(
            projectsSelect + " WHERE p.clientId=? ORDER BY p.id DESC",
            id,
          ).map(project),
          events: history(
            "(e.clientId=? OR e.relatedClientId=?)",
            [id, id],
            id,
          ),
        });
        return true;
      }
      if (method === "PATCH") {
        const b = await body(req);
        checkBody(b, ["name", "isActive", "confirm"], fail);
        if ("name" in b) {
          if (Object.keys(b).length !== 1 || !titleValid(b.name))
            fail(400, "Укажите корректное имя");
        } else if (
          typeof b.isActive !== "boolean" ||
          b.confirm !== true ||
          Object.keys(b).some((k) => !["isActive", "confirm"].includes(k))
        )
          fail(400, "Подтвердите изменение доступа");
        tx(() => {
          c = client(get(clientsSelect + " AND u.id=?", id));
          if (!c) fail(404, "Клиент не найден");
          if ("name" in b) {
            const name = b.name.trim();
            if (name !== c.name) {
              run("UPDATE users SET name=? WHERE id=?", name, id);
              audit("client.renamed", user.id, id, null, {
                oldName: c.name,
                newName: name,
              });
            }
          } else if (b.isActive !== c.isActive) {
            run(
              "UPDATE users SET isActive=? WHERE id=?",
              Number(b.isActive),
              id,
            );
            if (!b.isActive) {
              run("DELETE FROM sessions WHERE userId=?", id);
              for (const r of all(
                "SELECT id FROM password_recovery_requests WHERE userId=? AND status IN ('new','approved')",
                id,
              )) {
                run(
                  "UPDATE password_recovery_requests SET status='rejected',tokenHash=NULL,processedBy=?,processedAt=? WHERE id=?",
                  user.id,
                  now(),
                  r.id,
                );
                run(
                  "INSERT INTO password_recovery_events(requestId,type,actorId,createdAt) VALUES(?,?,?,?)",
                  r.id,
                  "rejected",
                  user.id,
                  now(),
                );
              }
            }
            audit(
              b.isActive ? "client.enabled" : "client.disabled",
              user.id,
              id,
              null,
              { oldValue: c.isActive, newValue: b.isActive },
            );
          }
        });
        json(res, 200, {
          client: client(get(clientsSelect + " AND u.id=?", id)),
        });
        return true;
      }
    }
    match = path.match(
      /^\/api\/admin\/projects\/(\d+)(?:\/(assign|restore))?$/,
    );
    if (match) {
      const id = Number(match[1]);
      let p = get(projectsSelect + " WHERE p.id=?", id);
      if (!p) fail(404, "Проект не найден");
      if (!match[2] && method === "GET") {
        json(res, 200, {
          project: project(p),
          events: history("e.projectId=?", [id]),
        });
        return true;
      }
      if (!match[2] && method === "PATCH") {
        const b = await body(req);
        checkBody(b, ["title", "status", "confirm"], fail);
        if (!("title" in b) && !("status" in b))
          fail(400, "Укажите изменение проекта");
        if (
          ("title" in b && !titleValid(b.title)) ||
          ("status" in b && !STATUSES.includes(b.status))
        )
          fail(400, "Некорректное название или статус");
        if ("confirm" in b && b.confirm !== true)
          fail(400, "Подтвердите изменение");
        tx(() => {
          p = get(projectsSelect + " WHERE p.id=?", id);
          if ("title" in b && b.title.trim() !== p.title) {
            run("UPDATE projects SET title=? WHERE id=?", b.title.trim(), id);
            audit("project.renamed", user.id, p.clientId, id, {
              oldTitle: p.title,
              newTitle: b.title.trim(),
            });
          }
          if ("status" in b && b.status !== p.status) {
            if (p.status === "Архив")
              fail(409, "Сначала восстановите проект из архива");
            if (b.status === "Архив") {
              if (b.confirm !== true) fail(400, "Подтвердите перенос в архив");
              run(
                "UPDATE projects SET status=?,archivedFrom=? WHERE id=?",
                b.status,
                p.status,
                id,
              );
              audit("project.archived", user.id, p.clientId, id, {
                oldStatus: p.status,
                newStatus: b.status,
              });
            } else {
              run("UPDATE projects SET status=? WHERE id=?", b.status, id);
              audit("project.status_changed", user.id, p.clientId, id, {
                oldStatus: p.status,
                newStatus: b.status,
              });
            }
          }
        });
        json(res, 200, {
          project: project(get(projectsSelect + " WHERE p.id=?", id)),
        });
        return true;
      }
      if (match[2] && method === "POST") {
        const b = await body(req);
        checkBody(
          b,
          match[2] === "assign"
            ? ["clientId", "expectedClientId", "confirm"]
            : ["confirm"],
          fail,
        );
        if (b.confirm !== true) fail(400, "Подтвердите действие");
        tx(() => {
          p = get(projectsSelect + " WHERE p.id=?", id);
          if (match[2] === "restore") {
            if (p.status !== "Архив") fail(409, "Проект не находится в архиве");
            const status =
              typeof p.archivedFrom === "string" &&
              p.archivedFrom.trim() &&
              p.archivedFrom !== "Архив"
                ? p.archivedFrom
                : "В работе";
            run(
              "UPDATE projects SET status=?,archivedFrom=NULL WHERE id=?",
              status,
              id,
            );
            audit("project.restored", user.id, p.clientId, id, {
              oldStatus: p.status,
              newStatus: status,
            });
          } else {
            if (
              !Number.isSafeInteger(b.clientId) ||
              !Number.isSafeInteger(b.expectedClientId)
            )
              fail(400, "Укажите текущего и нового клиента");
            if (p.clientId !== b.expectedClientId)
              fail(409, "Владелец проекта изменился. Обновите данные");
            if (
              !get(
                "SELECT id FROM users WHERE id=? AND role='client' AND isActive=1",
                b.clientId,
              )
            )
              fail(400, "Активный клиент не найден");
            if (p.clientId !== b.clientId) {
              run("UPDATE projects SET clientId=? WHERE id=?", b.clientId, id);
              audit(
                "project.reassigned",
                user.id,
                p.clientId,
                id,
                { oldClientId: p.clientId, newClientId: b.clientId },
                b.clientId,
              );
            }
          }
        });
        json(res, 200, {
          project: project(get(projectsSelect + " WHERE p.id=?", id)),
        });
        return true;
      }
    }
    fail(404, "Маршрут не найден");
  };
}

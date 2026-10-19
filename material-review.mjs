const iso = (value) => (value == null ? null : new Date(value).toISOString());
export function decorateReviewFiles(db, files) {
  const query =
    db.prepare(`SELECT v.materialId,v.id AS versionId,v.versionNumber,v.status,v.revision,
    NOT EXISTS(SELECT 1 FROM review_versions n WHERE n.materialId=v.materialId AND n.versionNumber>v.versionNumber) AS isCurrent
    FROM review_versions v WHERE v.fileId=?`);
  return files.map((file) => {
    const review = query.get(file.id);
    return review
      ? { ...file, review: { ...review, isCurrent: !!review.isCurrent } }
      : file;
  });
}
export function initMaterialReview({ db, now = Date.now, validatePreview }) {
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
  transaction(() =>
    db.exec(`CREATE TABLE IF NOT EXISTS review_materials(
    id INTEGER PRIMARY KEY,projectId INTEGER NOT NULL REFERENCES projects(id),stageId INTEGER NOT NULL REFERENCES stages(id),title TEXT NOT NULL,createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS review_versions(
      id INTEGER PRIMARY KEY,materialId INTEGER NOT NULL REFERENCES review_materials(id),fileId INTEGER NOT NULL UNIQUE REFERENCES files(id),versionNumber INTEGER NOT NULL,
      uploadedBy INTEGER NOT NULL REFERENCES users(id),createdAt INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending_approval',revision INTEGER NOT NULL DEFAULT 0,
      decisionAt INTEGER,decisionBy INTEGER REFERENCES users(id),UNIQUE(materialId,versionNumber));
    CREATE TABLE IF NOT EXISTS review_events(
      id INTEGER PRIMARY KEY,projectId INTEGER NOT NULL REFERENCES projects(id),stageId INTEGER NOT NULL REFERENCES stages(id),
      materialId INTEGER NOT NULL REFERENCES review_materials(id),versionId INTEGER NOT NULL REFERENCES review_versions(id),
      actorId INTEGER NOT NULL REFERENCES users(id),type TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS review_notifications(
      id INTEGER PRIMARY KEY,eventId INTEGER NOT NULL REFERENCES review_events(id),recipientId INTEGER NOT NULL REFERENCES users(id),readAt INTEGER,UNIQUE(eventId,recipientId));
    CREATE TABLE IF NOT EXISTS review_views(
      versionId INTEGER NOT NULL REFERENCES review_versions(id),userId INTEGER NOT NULL REFERENCES users(id),
      firstViewedAt INTEGER NOT NULL,lastViewedAt INTEGER NOT NULL,viewCount INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(versionId,userId));
    CREATE INDEX IF NOT EXISTS review_materials_project ON review_materials(projectId,stageId);
    CREATE INDEX IF NOT EXISTS review_events_material ON review_events(materialId,id);
    CREATE INDEX IF NOT EXISTS review_notifications_recipient ON review_notifications(recipientId,id);
    CREATE TRIGGER IF NOT EXISTS review_events_no_update BEFORE UPDATE ON review_events BEGIN SELECT RAISE(ABORT,'Review history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS review_events_no_delete BEFORE DELETE ON review_events BEGIN SELECT RAISE(ABORT,'Review history is immutable'); END;`),
  );
  function access(projectId, user, fail) {
    if (
      !user ||
      !get("SELECT id FROM users WHERE id=? AND isActive=1", user.id)
    )
      fail(401, "Войдите в кабинет");
    const p = get("SELECT * FROM projects WHERE id=?", projectId);
    if (!p) fail(404, "Проект не найден");
    if (user.role !== "admin" && p.clientId !== user.id)
      fail(403, "Нет доступа");
    return p;
  }
  const materialRow = (id, fail) => {
    const m = get("SELECT * FROM review_materials WHERE id=?", id);
    if (!m) fail(404, "Материал не найден");
    return m;
  };
  const latest = (materialId) =>
    get(
      "SELECT * FROM review_versions WHERE materialId=? ORDER BY versionNumber DESC LIMIT 1",
      materialId,
    );
  const viewState = (versionId, userId) => {
    const v = get(
      "SELECT userId,firstViewedAt,lastViewedAt,viewCount FROM review_views WHERE versionId=? AND userId=?",
      versionId,
      userId,
    );
    return v
      ? {
          ...v,
          viewed: true,
          firstViewedAt: iso(v.firstViewedAt),
          lastViewedAt: iso(v.lastViewedAt),
        }
      : {
          userId,
          viewed: false,
          firstViewedAt: null,
          lastViewedAt: null,
          viewCount: 0,
        };
  };
  const versionSelect = `SELECT v.id,v.materialId,v.fileId,v.versionNumber,v.status,v.revision,v.createdAt,v.decisionAt,
    u.name AS uploadedByName,d.name AS decisionByName FROM review_versions v JOIN users u ON u.id=v.uploadedBy LEFT JOIN users d ON d.id=v.decisionBy`;
  function version(id, user) {
    const v = get(versionSelect + " WHERE v.id=?", id);
    if (!v) return null;
    const owner = get(
      "SELECT p.clientId FROM review_materials m JOIN projects p ON p.id=m.projectId WHERE m.id=?",
      v.materialId,
    );
    const views = all(
      "SELECT w.*,u.name AS userName FROM review_views w JOIN users u ON u.id=w.userId WHERE w.versionId=?" +
        (user?.role === "admin" ? "" : " AND w.userId=?") +
        " ORDER BY w.firstViewedAt,w.userId",
      id,
      ...(user?.role === "admin" ? [] : [user?.id ?? owner.clientId]),
    ).map((w) => ({
      userId: w.userId,
      userName: w.userName,
      viewed: true,
      firstViewedAt: iso(w.firstViewedAt),
      lastViewedAt: iso(w.lastViewedAt),
      viewCount: w.viewCount,
    }));
    return {
      ...v,
      createdAt: iso(v.createdAt),
      decisionAt: iso(v.decisionAt),
      view: viewState(id, owner.clientId),
      views,
      file: decorateReviewFiles(db, [
        get(
          "SELECT id,name,contentType,size,category,stageId FROM files WHERE id=?",
          v.fileId,
        ),
      ])[0],
    };
  }
  function material(id, user) {
    const m = get("SELECT * FROM review_materials WHERE id=?", id);
    if (!m) return null;
    const versions = all(
      "SELECT id FROM review_versions WHERE materialId=? ORDER BY versionNumber",
      id,
    ).map((row) => version(row.id, user));
    return {
      ...m,
      createdAt: iso(m.createdAt),
      currentVersion: versions.at(-1),
      versions,
    };
  }
  const eventSelect = `SELECT e.id,e.projectId,e.stageId,e.materialId,e.versionId,e.actorId,e.type,e.body,e.createdAt,u.name AS actorName,u.role AS actorRole,v.versionNumber FROM review_events e JOIN users u ON u.id=e.actorId JOIN review_versions v ON v.id=e.versionId`;
  const event = (id) => {
    const e = get(eventSelect + " WHERE e.id=?", id);
    return e && { ...e, createdAt: iso(e.createdAt) };
  };
  function addEvent(m, v, user, type, body = "", notify = null) {
    const timestamp = now(),
      id = Number(
        run(
          "INSERT INTO review_events(projectId,stageId,materialId,versionId,actorId,type,body,createdAt) VALUES(?,?,?,?,?,?,?,?)",
          m.projectId,
          m.stageId,
          m.id,
          v.id,
          user.id,
          type,
          body,
          timestamp,
        ).lastInsertRowid,
      );
    const p = get("SELECT clientId FROM projects WHERE id=?", m.projectId);
    run(
      "INSERT INTO admin_management_events(type,actorId,clientId,projectId,payload,createdAt) VALUES(?,?,?,?,?,?)",
      "material." + type,
      user.id,
      p.clientId,
      m.projectId,
      JSON.stringify({
        stageId: m.stageId,
        materialId: m.id,
        versionId: v.id,
        versionNumber: v.versionNumber,
        type,
      }),
      timestamp,
    );
    const recipients =
      notify === "client"
        ? all(
            "SELECT id FROM users WHERE id=? AND role='client' AND isActive=1",
            p.clientId,
          )
        : notify === "admin"
          ? all("SELECT id FROM users WHERE role='admin' AND isActive=1")
          : [];
    for (const recipient of recipients)
      run(
        "INSERT INTO review_notifications(eventId,recipientId) VALUES(?,?)",
        id,
        recipient.id,
      );
    return id;
  }
  function deriveStage(stageId) {
    const statuses = all(
      `SELECT v.status FROM review_versions v JOIN review_materials m ON m.id=v.materialId WHERE m.stageId=? AND NOT EXISTS(SELECT 1 FROM review_versions n WHERE n.materialId=v.materialId AND n.versionNumber>v.versionNumber)`,
      stageId,
    ).map((row) => row.status);
    if (statuses.length)
      run(
        "UPDATE stages SET status=? WHERE id=?",
        statuses.includes("changes_requested")
          ? "changes_requested"
          : statuses.includes("pending_approval")
            ? "pending_approval"
            : "approved",
        stageId,
      );
  }
  const strict = (b, keys, fail) => {
    if (Object.keys(b).some((key) => !keys.includes(key)))
      fail(400, "Недопустимые поля запроса");
  };
  const validText = (value) =>
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 4000;
  const limits = new Map();
  function throttle(user, fail) {
    const timestamp = now();
    for (const [key, v] of limits) if (v.until <= timestamp) limits.delete(key);
    let entry = limits.get(user.id);
    if (!entry) {
      entry = { count: 0, until: timestamp + 60000 };
      limits.set(user.id, entry);
    }
    if (++entry.count > 120)
      fail(429, "Слишком много действий. Повторите через минуту");
  }
  function validateUpload(b, projectId, user, fail) {
    const wantsReview =
      b.review === true || "materialId" in b || "expectedVersionId" in b;
    if ("review" in b && typeof b.review !== "boolean")
      fail(400, "Некорректный признак согласования");
    if (!wantsReview) return null;
    if (b.review === false && ("materialId" in b || "expectedVersionId" in b))
      fail(400, "Некорректный запрос новой версии");
    if (user.role !== "admin") fail(403, "Нет доступа");
    access(projectId, user, fail);
    if (
      b.category !== "result" ||
      !Number.isSafeInteger(b.stageId) ||
      !get(
        "SELECT id FROM stages WHERE id=? AND projectId=?",
        b.stageId,
        projectId,
      )
    )
      fail(400, "Для согласования выберите результат и этап проекта");
    if ("materialId" in b || "expectedVersionId" in b) {
      if (
        !Number.isSafeInteger(b.materialId) ||
        !Number.isSafeInteger(b.expectedVersionId)
      )
        fail(400, "Укажите материал и текущую версию");
      const m = materialRow(b.materialId, fail);
      if (m.projectId !== projectId || m.stageId !== b.stageId)
        fail(400, "Материал относится к другому проекту или этапу");
      const current = latest(m.id);
      if (current.id !== b.expectedVersionId)
        fail(409, "Текущая версия изменилась. Обновите данные");
      return { materialId: m.id, expectedVersionId: current.id };
    }
    return { materialId: null };
  }
  function attachFile(fileId, b, projectId, user, fail) {
    const plan = validateUpload(b, projectId, user, fail);
    if (!plan) return null;
    const file = get("SELECT * FROM files WHERE id=?", fileId);
    if (
      !file ||
      file.projectId !== projectId ||
      file.stageId !== b.stageId ||
      file.category !== "result"
    )
      fail(400, "Файл не соответствует материалу");
    if (get("SELECT id FROM review_versions WHERE fileId=?", fileId))
      fail(409, "Файл уже включён в согласование");
    let m;
    if (plan.materialId) m = materialRow(plan.materialId, fail);
    else {
      const id = Number(
        run(
          "INSERT INTO review_materials(projectId,stageId,title,createdAt) VALUES(?,?,?,?)",
          projectId,
          b.stageId,
          file.name,
          now(),
        ).lastInsertRowid,
      );
      m = materialRow(id, fail);
    }
    const previous = latest(m.id),
      number = (previous?.versionNumber ?? 0) + 1;
    const id = Number(
        run(
          "INSERT INTO review_versions(materialId,fileId,versionNumber,uploadedBy,createdAt) VALUES(?,?,?,?,?)",
          m.id,
          fileId,
          number,
          user.id,
          now(),
        ).lastInsertRowid,
      ),
      v = get("SELECT * FROM review_versions WHERE id=?", id);
    addEvent(
      m,
      v,
      user,
      previous ? "version_uploaded" : "submitted",
      "",
      "client",
    );
    if (previous) addEvent(m, v, user, "version_replaced");
    deriveStage(m.stageId);
    return decorateReviewFiles(db, [{ id: fileId }])[0].review;
  }
  const notificationSelect = `SELECT n.id,n.readAt,e.type,e.projectId,p.title AS projectTitle,e.stageId,e.materialId,e.versionId,m.title AS materialTitle,v.versionNumber,u.name AS actorName,e.createdAt FROM review_notifications n JOIN review_events e ON e.id=n.eventId JOIN projects p ON p.id=e.projectId JOIN review_materials m ON m.id=e.materialId JOIN review_versions v ON v.id=e.versionId JOIN users u ON u.id=e.actorId`;
  const visibleNotifications = (user) =>
    all(
      notificationSelect +
        " WHERE n.recipientId=?" +
        (user.role === "admin" ? "" : " AND p.clientId=?") +
        " ORDER BY n.id DESC",
      user.id,
      ...(user.role === "admin" ? [] : [user.id]),
    ).map((n) => ({
      ...n,
      createdAt: iso(n.createdAt),
      readAt: iso(n.readAt),
    }));
  async function handle({ req, res, path, method, user, body, json, fail }) {
    const supported =
      /^\/api\/(?:projects\/\d+\/materials|materials\/\d+|material-versions\/\d+\/(?:decision|comments|cancel|view)|files\/\d+\/review|notifications(?:\/\d+\/read)?)$/.test(
        path,
      );
    if (!supported) return false;
    if (!user) fail(401, "Войдите в кабинет");
    if (path === "/api/notifications" && method === "GET") {
      const notifications = visibleNotifications(user);
      json(res, 200, {
        notifications,
        unreadCount: notifications.filter((n) => !n.readAt).length,
      });
      return true;
    }
    let match = path.match(/^\/api\/notifications\/(\d+)\/read$/);
    if (match && method === "POST") {
      const b = await body(req);
      strict(b, [], fail);
      throttle(user, fail);
      const notification = visibleNotifications(user).find(
        (n) => n.id === Number(match[1]),
      );
      if (!notification) fail(404, "Уведомление не найдено");
      run(
        "UPDATE review_notifications SET readAt=COALESCE(readAt,?) WHERE id=? AND recipientId=?",
        now(),
        notification.id,
        user.id,
      );
      json(res, 200, { ok: true });
      return true;
    }
    match = path.match(/^\/api\/projects\/(\d+)\/materials$/);
    if (match && method === "GET") {
      const id = Number(match[1]);
      access(id, user, fail);
      json(res, 200, {
        materials: all(
          "SELECT id FROM review_materials WHERE projectId=? ORDER BY id",
          id,
        ).map((row) => material(row.id, user)),
      });
      return true;
    }
    match = path.match(/^\/api\/materials\/(\d+)$/);
    if (match && method === "GET") {
      const m = materialRow(Number(match[1]), fail);
      access(m.projectId, user, fail);
      const result = material(m.id, user);
      json(res, 200, {
        material: result,
        versions: result.versions,
        events: all(
          eventSelect + " WHERE e.materialId=? ORDER BY e.id",
          m.id,
        ).map((e) => ({ ...e, createdAt: iso(e.createdAt) })),
      });
      return true;
    }
    match = path.match(/^\/api\/files\/(\d+)\/review$/);
    if (match && method === "POST") {
      if (user.role !== "admin") fail(403, "Нет доступа");
      const b = await body(req);
      strict(b, ["confirm"], fail);
      if (b.confirm !== true) fail(400, "Подтвердите отправку на согласование");
      throttle(user, fail);
      let result;
      transaction(() => {
        const f = get("SELECT * FROM files WHERE id=?", Number(match[1]));
        if (!f) fail(404, "Файл не найден");
        access(f.projectId, user, fail);
        result = attachFile(
          f.id,
          { review: true, category: f.category, stageId: f.stageId },
          f.projectId,
          user,
          fail,
        );
      });
      json(res, 201, { material: material(result.materialId, user) });
      return true;
    }
    match = path.match(
      /^\/api\/material-versions\/(\d+)\/(decision|comments|cancel|view)$/,
    );
    if (match && method === "POST") {
      const id = Number(match[1]),
        action = match[2],
        b = await body(req);
      throttle(user, fail);
      let eventId, viewResult;
      transaction(() => {
        const v = get("SELECT * FROM review_versions WHERE id=?", id);
        if (!v) fail(404, "Версия не найдена");
        const m = materialRow(v.materialId, fail);
        access(m.projectId, user, fail);
        if (action === "view") {
          strict(b, [], fail);
          if (user.role !== "client")
            fail(403, "Просмотр фиксируется только для клиента проекта");
          const file = get("SELECT * FROM files WHERE id=?", v.fileId);
          if (!validatePreview) fail(415, "Встроенный просмотр недоступен");
          validatePreview(file);
          const timestamp = now(),
            previous = get(
              "SELECT versionId FROM review_views WHERE versionId=? AND userId=?",
              id,
              user.id,
            );
          run(
            "INSERT INTO review_views(versionId,userId,firstViewedAt,lastViewedAt,viewCount) VALUES(?,?,?,?,1) ON CONFLICT(versionId,userId) DO UPDATE SET lastViewedAt=MAX(lastViewedAt,excluded.lastViewedAt),viewCount=viewCount+1",
            id,
            user.id,
            timestamp,
            timestamp,
          );
          if (!previous) addEvent(m, v, user, "first_viewed", "", "admin");
          viewResult = { view: viewState(id, user.id), firstView: !previous };
          return;
        }
        if (action === "comments") {
          strict(b, ["text"], fail);
          if (!validText(b.text))
            fail(400, "Напишите комментарий до 4000 символов");
          eventId = addEvent(
            m,
            v,
            user,
            user.role === "admin" ? "admin_reply" : "comment",
            b.text.trim(),
            user.role === "admin" ? "client" : "admin",
          );
          return;
        }
        if (action === "decision" && user.role !== "client")
          fail(403, "Согласовать материал может только клиент проекта");
        if (action === "cancel" && user.role !== "admin")
          fail(403, "Отменить согласование может только администратор");
        if (latest(m.id).id !== v.id)
          fail(409, "Решение доступно только для текущей версии");
        if (
          !Number.isSafeInteger(b.expectedRevision) ||
          b.expectedRevision !== v.revision
        )
          fail(409, "Версия изменилась. Обновите данные");
        if (action === "decision") {
          strict(
            b,
            ["decision", "comment", "confirm", "expectedRevision"],
            fail,
          );
          if (!["approved", "changes_requested"].includes(b.decision))
            fail(400, "Выберите решение");
          if (v.status !== "pending_approval")
            fail(409, "Решение уже сохранено");
          if (b.decision === "approved" && b.confirm !== true)
            fail(400, "Подтвердите согласование этой версии");
          if (b.decision === "changes_requested" && !validText(b.comment))
            fail(400, "Для изменений обязателен комментарий до 4000 символов");
          if ("comment" in b && b.comment !== "" && !validText(b.comment))
            fail(400, "Комментарий должен содержать до 4000 символов");
          const result = run(
            "UPDATE review_versions SET status=?,revision=revision+1,decisionAt=?,decisionBy=? WHERE id=? AND revision=? AND status=?",
            b.decision,
            now(),
            user.id,
            id,
            b.expectedRevision,
            "pending_approval",
          );
          if (!result.changes) fail(409, "Решение уже сохранено");
          eventId = addEvent(
            m,
            v,
            user,
            b.decision,
            (b.comment || "").trim(),
            "admin",
          );
        } else {
          strict(b, ["reason", "confirm", "expectedRevision"], fail);
          if (b.confirm !== true || !validText(b.reason))
            fail(400, "Подтвердите отмену и укажите причину до 4000 символов");
          if (v.status !== "approved") fail(409, "Эта версия не согласована");
          const result = run(
            "UPDATE review_versions SET status='pending_approval',revision=revision+1,decisionAt=NULL,decisionBy=NULL WHERE id=? AND revision=? AND status='approved'",
            id,
            b.expectedRevision,
          );
          if (!result.changes) fail(409, "Состояние версии изменилось");
          eventId = addEvent(
            m,
            v,
            user,
            "approval_cancelled",
            b.reason.trim(),
            "client",
          );
        }
        deriveStage(m.stageId);
      });
      json(
        res,
        200,
        viewResult ?? { version: version(id, user), event: event(eventId) },
      );
      return true;
    }
    fail(404, "Маршрут не найден");
  }
  return {
    handle,
    validateUpload,
    attachFile,
    transaction,
    isLinked: (fileId) =>
      !!get("SELECT id FROM review_versions WHERE fileId=?", fileId),
  };
}

import { randomBytes, createHash } from "node:crypto";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const TTL = 20 * 60 * 1000;
const WINDOW = 15 * 60 * 1000;
const RESPONSE =
  "Если такой аккаунт существует, запрос отправлен администратору.";
export function initPasswordRecovery({ db, passwordHash, now = Date.now }) {
  db.exec(`CREATE TABLE IF NOT EXISTS password_recovery_requests (
    id INTEGER PRIMARY KEY, email TEXT NOT NULL, userId INTEGER REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'new', createdAt INTEGER NOT NULL,
    processedBy INTEGER REFERENCES users(id), processedAt INTEGER, expiresAt INTEGER,
    tokenHash TEXT UNIQUE);
    CREATE TABLE IF NOT EXISTS password_recovery_events (
      id INTEGER PRIMARY KEY, requestId INTEGER NOT NULL REFERENCES password_recovery_requests(id),
      type TEXT NOT NULL, actorId INTEGER REFERENCES users(id), createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS password_recovery_limits (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL, expiresAt INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS recovery_email_status ON password_recovery_requests(email,status);
    CREATE INDEX IF NOT EXISTS recovery_events_request ON password_recovery_events(requestId,id);`);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const iso = (timestamp) =>
    timestamp == null ? null : new Date(timestamp).toISOString();
  const event = (id, type, actorId, timestamp) =>
    run(
      "INSERT INTO password_recovery_events(requestId,type,actorId,createdAt) VALUES(?,?,?,?)",
      id,
      type,
      actorId,
      timestamp,
    );
  const transaction = (action) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = action();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  function expire(timestamp) {
    transaction(() => {
      for (const row of all(
        "SELECT id FROM password_recovery_requests WHERE status='approved' AND expiresAt<=?",
        timestamp,
      )) {
        run(
          "UPDATE password_recovery_requests SET status='expired',tokenHash=NULL WHERE id=?",
          row.id,
        );
        event(row.id, "expired", null, timestamp);
      }
    });
  }
  function throttle(key, limit, timestamp, fail) {
    run("DELETE FROM password_recovery_limits WHERE expiresAt<=?", timestamp);
    run(
      "INSERT INTO password_recovery_limits(key,count,expiresAt) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1",
      key,
      timestamp + WINDOW,
    );
    if (
      get("SELECT count FROM password_recovery_limits WHERE key=?", key).count >
      limit
    )
      fail(429, "Слишком много попыток. Повторите через 15 минут");
  }
  const select = `SELECT r.id,r.email,r.userId,r.status,r.createdAt,r.processedAt,r.expiresAt,
    u.name AS clientName,a.name AS processedByName FROM password_recovery_requests r
    LEFT JOIN users u ON u.id=r.userId LEFT JOIN users a ON a.id=r.processedBy`;
  const serialize = (row) => ({
    ...row,
    createdAt: iso(row.createdAt),
    processedAt: iso(row.processedAt),
    expiresAt: iso(row.expiresAt),
  });
  const request = (id) => {
    const row = get(select + " WHERE r.id=?", id);
    return row && serialize(row);
  };
  return async function handle({
    req,
    res,
    path,
    method,
    user,
    body,
    json,
    fail,
  }) {
    if (
      !path.startsWith("/api/password-recovery/") &&
      !path.startsWith("/api/admin/password-recovery/")
    )
      return false;
    res.setHeader("Referrer-Policy", "no-referrer");
    let timestamp = now();
    const ip = digest(req.itdClientIP || req.socket.remoteAddress || "unknown");
    if (path === "/api/password-recovery/requests" && method === "POST") {
      const b = await body(req);
      timestamp = now();
      throttle("request:" + ip, 5, timestamp, fail);
      if (
        typeof b.email !== "string" ||
        b.email.length > 254 ||
        !/^\s*[^\s@]+@[^\s@]+\.[^\s@]+\s*$/.test(b.email)
      )
        fail(400, "Укажите корректный email");
      const email = b.email.trim().toLowerCase();
      expire(timestamp);
      transaction(() => {
        if (
          get(
            "SELECT id FROM password_recovery_requests WHERE email=? AND status IN ('new','approved')",
            email,
          )
        )
          return;
        const u = get(
          "SELECT id FROM users WHERE email=? AND role='client'",
          email,
        );
        const id = Number(
          run(
            "INSERT INTO password_recovery_requests(email,userId,createdAt) VALUES(?,?,?)",
            email,
            u?.id ?? null,
            timestamp,
          ).lastInsertRowid,
        );
        event(id, "requested", null, timestamp);
      });
      json(res, 202, { message: RESPONSE });
      return true;
    }
    if (path === "/api/password-recovery/reset" && method === "POST") {
      const b = await body(req);
      timestamp = now();
      throttle("reset:" + ip, 20, timestamp, fail);
      if (
        Object.keys(b).some(
          (key) => !["token", "password", "passwordConfirm"].includes(key),
        )
      )
        fail(400, "Недопустимые поля запроса");
      if (typeof b.token !== "string" || !/^[a-f0-9]{64}$/.test(b.token))
        fail(400, "Ссылка недействительна или срок её действия истёк");
      if (
        typeof b.password !== "string" ||
        b.password.length < 12 ||
        b.password.length > 256 ||
        b.password !== b.passwordConfirm
      )
        fail(400, "Укажите совпадающие пароли из 12–256 символов");
      expire(timestamp);
      if (
        !get(
          "SELECT r.id FROM password_recovery_requests r JOIN users u ON u.id=r.userId WHERE r.tokenHash=? AND r.status='approved' AND r.expiresAt>? AND u.role='client' AND u.isActive=1",
          digest(b.token),
          timestamp,
        )
      )
        fail(400, "Ссылка недействительна или срок её действия истёк");
      const encoded = await passwordHash(b.password);
      req.itdRecheckSession?.();
      timestamp = now();
      expire(timestamp);
      transaction(() => {
        const r = get(
          "SELECT r.id,r.userId FROM password_recovery_requests r JOIN users u ON u.id=r.userId WHERE r.tokenHash=? AND r.status='approved' AND r.expiresAt>? AND u.role='client' AND u.isActive=1",
          digest(b.token),
          timestamp,
        );
        if (!r) fail(400, "Ссылка недействительна или срок её действия истёк");
        run("UPDATE users SET password=? WHERE id=?", encoded, r.userId);
        run("DELETE FROM sessions WHERE userId=?", r.userId);
        run(
          "UPDATE password_recovery_requests SET status='used',tokenHash=NULL WHERE id=?",
          r.id,
        );
        event(r.id, "used", r.userId, timestamp);
        for (const other of all(
          "SELECT id FROM password_recovery_requests WHERE userId=? AND id<>? AND status IN ('new','approved')",
          r.userId,
          r.id,
        )) {
          run(
            "UPDATE password_recovery_requests SET status='rejected',tokenHash=NULL WHERE id=?",
            other.id,
          );
          event(other.id, "superseded", r.userId, timestamp);
        }
      });
      json(res, 200, { ok: true });
      return true;
    }
    if (path.startsWith("/api/admin/password-recovery/")) {
      if (!user) fail(401, "Войдите в кабинет");
      if (user.role !== "admin") fail(403, "Нет доступа");
      expire(timestamp);
      if (
        path === "/api/admin/password-recovery/requests" &&
        method === "GET"
      ) {
        json(res, 200, {
          requests: all(select + " ORDER BY r.id DESC").map(serialize),
        });
        return true;
      }
      const match = path.match(
        /^\/api\/admin\/password-recovery\/requests\/(\d+)(?:\/(approve|reject|copied))?$/,
      );
      if (!match) fail(404, "Запрос не найден");
      const id = Number(match[1]);
      let row = request(id);
      if (!row) fail(404, "Запрос не найден");
      if (!match[2] && method === "GET") {
        throttle("admin-view:" + user.id, 300, timestamp, fail);
        event(id, "viewed", user.id, timestamp);
        const events = all(
          "SELECT e.id,e.type,e.createdAt,u.name AS actorName FROM password_recovery_events e LEFT JOIN users u ON u.id=e.actorId WHERE e.requestId=? ORDER BY e.id",
          id,
        ).map((e) => ({ ...e, createdAt: iso(e.createdAt) }));
        json(res, 200, { request: row, events });
        return true;
      }
      if (match[2] && method === "POST") {
        await body(req);
        timestamp = now();
        expire(timestamp);
        throttle("admin-action:" + user.id, 100, timestamp, fail);
        let resetPath;
        transaction(() => {
          row = request(id);
          if (match[2] === "approve") {
            if (!["new", "approved"].includes(row.status))
              fail(409, "Этот запрос уже обработан");
            if (
              !row.userId ||
              !get(
                "SELECT id FROM users WHERE id=? AND role='client' AND isActive=1",
                row.userId,
              )
            )
              fail(400, "Восстановление доступно только существующему клиенту");
            const token = randomBytes(32).toString("hex");
            resetPath = "/reset-password/#" + token;
            run(
              "UPDATE password_recovery_requests SET status='approved',processedBy=?,processedAt=?,expiresAt=?,tokenHash=? WHERE id=?",
              user.id,
              timestamp,
              timestamp + TTL,
              digest(token),
              id,
            );
            event(id, "approved", user.id, timestamp);
            event(
              id,
              row.status === "approved" ? "reissued" : "issued",
              user.id,
              timestamp,
            );
          } else if (match[2] === "reject") {
            if (!["new", "approved"].includes(row.status))
              fail(409, "Этот запрос уже обработан");
            run(
              "UPDATE password_recovery_requests SET status='rejected',processedBy=?,processedAt=?,tokenHash=NULL WHERE id=?",
              user.id,
              timestamp,
              id,
            );
            event(id, "rejected", user.id, timestamp);
          } else {
            if (row.status !== "approved")
              fail(409, "Действующая ссылка отсутствует");
            event(id, "copied", user.id, timestamp);
          }
        });
        json(res, 200, {
          request: request(id),
          ...(resetPath ? { resetPath } : {}),
        });
        return true;
      }
    }
    fail(404, "Маршрут не найден");
  };
}

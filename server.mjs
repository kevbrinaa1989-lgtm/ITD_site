import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openConfiguredData } from "./data-storage.mjs";
import { initPasswordRecovery } from "./password-recovery.mjs";
const ROOT = dirname(fileURLToPath(import.meta.url));
const PDF_ASSETS = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, "vendor/pdfjs/assets.json"), "utf8"))));
function previewType(file, bytes) {
  const ext = file.name.split(".").pop().toLowerCase();
  if (["jpg", "jpeg"].includes(ext) && file.contentType === "image/jpeg" &&
      bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ext === "png" && file.contentType === "image/png" &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (ext === "webp" && file.contentType === "image/webp" && bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (ext === "pdf" && file.contentType === "application/pdf" &&
      bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) return "application/pdf";
  fail(415, "Предпросмотр этого файла недоступен. Вы можете скачать оригинал.");
}
const hash = (value) => createHash("sha256").update(value).digest("hex");
const passwordHash = (password) => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
};
const validPassword = (password, stored) => {
  const [salt, digest] = stored.split(":");
  return timingSafeEqual(
    scryptSync(password, salt, 64),
    Buffer.from(digest, "hex"),
  );
};
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
export function createApp(options = {}) {
  // An explicit dataDir is for first-time setup and isolated development/test fixtures.
  // Normal startup requires the saved, validated existing database.
  const store = options.dataDir ? null : openConfiguredData(options.storageOptions);
  const dataDir = store?.dataDir || resolve(options.dataDir);
  let db;
  try {
  if (!store) mkdirSync(join(dataDir, "files"), { recursive: true, mode: 0o700 });
  db = new DatabaseSync(join(dataDir, "itd.sqlite"));
  db.exec("PRAGMA foreign_keys=ON");
  if (!store) db.exec(
    `PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL,password TEXT NOT NULL); CREATE TABLE IF NOT EXISTS projects(id INTEGER PRIMARY KEY,title TEXT NOT NULL,clientId INTEGER NOT NULL REFERENCES users(id),status TEXT NOT NULL DEFAULT 'В работе'); CREATE TABLE IF NOT EXISTS stages(id INTEGER PRIMARY KEY,projectId INTEGER NOT NULL REFERENCES projects(id),title TEXT NOT NULL,status TEXT NOT NULL,description TEXT NOT NULL); CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY,projectId INTEGER NOT NULL REFERENCES projects(id),stageId INTEGER REFERENCES stages(id),name TEXT NOT NULL,contentType TEXT NOT NULL,category TEXT NOT NULL,path TEXT NOT NULL,size INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,userId INTEGER NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);`,
  );
  const email = (v) =>
    typeof v === "string" &&
    v.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  const text = (v, max = 200) =>
    typeof v === "string" && v.trim().length > 0 && v.length <= max;
  const adminEmail = options.adminEmail ?? (store ? undefined : process.env.ITD_ADMIN_EMAIL),
    adminPassword = options.adminPassword ?? (store ? undefined : process.env.ITD_ADMIN_PASSWORD);
  if (adminEmail || adminPassword) {
    if (
      !email(adminEmail) ||
      typeof adminPassword !== "string" ||
      adminPassword.length < 12 ||
      adminPassword.length > 256
    )
      throw Error(
        "Administrator requires a valid email and a password of 12–256 characters",
      );
    const existing = db
      .prepare("SELECT role FROM users WHERE email=?")
      .get(adminEmail.toLowerCase());
    if (existing && existing.role !== "admin")
      throw Error("Administrator email already belongs to a client");
    if (!existing)
      db.prepare(
        "INSERT INTO users(email,name,role,password) VALUES(?,?,?,?)",
      ).run(
        adminEmail.toLowerCase(),
        "Администратор",
        "admin",
        passwordHash(adminPassword),
      );
  }
  const run = (sql, ...args) => db.prepare(sql).run(...args),
    get = (sql, ...args) => db.prepare(sql).get(...args),
    all = (sql, ...args) => db.prepare(sql).all(...args);
  const recovery = initPasswordRecovery({db, passwordHash, now: options.recoveryNow});
  const limits = new Map();
  const json = (res, status, value) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
  };
  const body = async (req) => {
    let chunks = [],
      size = 0;
    const max = req.url?.match(/^\/api\/projects\/\d+\/files(?:\?|$)/)
      ? 14 * 1024 * 1024
      : 16 * 1024;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > max) fail(413, "Запрос слишком большой");
      chunks.push(chunk);
    }
    let value;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      fail(400, "Некорректный JSON");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail(400, "Требуется объект JSON");
    return value;
  };
  const safeUser = (u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
  });
  const server = http.createServer(async (req, res) => {
    try {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "same-origin");
      res.setHeader("X-Frame-Options", "DENY");
      const url = new URL(req.url, "http://localhost"),
        path = url.pathname,
        method = req.method;
      if (path.startsWith("/api/")) {
        if (!["GET", "HEAD"].includes(method)) {
          const origin = req.headers.origin;
          let same = false;
          try {
            const o = new URL(origin);
            same =
              ["http:", "https:"].includes(o.protocol) &&
              o.host === req.headers.host;
          } catch {}
          if (!same) fail(403, "Недопустимый источник запроса");
          if (path !== "/api/login" && req.headers["x-itd-request"] !== "1")
            fail(403, "Отсутствует защита запроса");
          if (
            !/^application\/json(?:;|$)/i.test(
              req.headers["content-type"] || "",
            )
          )
            fail(415, "Требуется JSON");
        }
        const cookie = (req.headers.cookie || "")
          .split(";")
          .map((x) => x.trim())
          .find((x) => x.startsWith("itd_session="))
          ?.slice(12);
        const user = cookie
          ? get(
              "SELECT users.* FROM sessions JOIN users ON users.id=sessions.userId WHERE token=? AND expires>?",
              hash(cookie),
              Date.now(),
            )
          : null;
        const admin = () => {
          if (!user) fail(401, "Войдите в кабинет");
          if (user.role !== "admin") fail(403, "Нет доступа");
        };
        const project = (id) => {
          if (!user) fail(401, "Войдите в кабинет");
          const p = get("SELECT * FROM projects WHERE id=?", id);
          if (!p) fail(404, "Проект не найден");
          if (user.role !== "admin" && p.clientId !== user.id)
            fail(403, "Нет доступа");
          return p;
        };
        if (await recovery({req,res,path,method,user,body,json,fail})) return;
        if (path === "/api/login" && method === "POST") {
          const now = Date.now(),
            ip = req.socket.remoteAddress || "unknown";
          for (const [k, v] of limits) if (v.until < now) limits.delete(k);
          const throttle = (key, max) => {
            let entry = limits.get(key);
            if (!entry || now > entry.until) {
              entry = { count: 0, until: now + 900000 };
              limits.set(key, entry);
            }
            if (++entry.count > max)
              fail(429, "Слишком много попыток. Повторите через 15 минут");
          };
          throttle("login-ip:" + ip, 300);
          const b = await body(req);
          if (
            !email(b.email) ||
            typeof b.password !== "string" ||
            b.password.length > 256
          )
            fail(400, "Укажите email и пароль");
          const pairKey =
            "login-pair:" + ip + ":" + hash(b.email.toLowerCase());
          throttle(pairKey, 15);
          const u = get(
            "SELECT * FROM users WHERE email=?",
            b.email.toLowerCase(),
          );
          const stored =
            u?.password ||
            `00000000000000000000000000000000:${"0".repeat(128)}`;
          if (!validPassword(b.password, stored) || !u)
            fail(401, "Неверный email или пароль");
          limits.delete(pairKey);
          const token = randomBytes(32).toString("hex");
          run("DELETE FROM sessions WHERE expires<?", now);
          run(
            "INSERT INTO sessions VALUES(?,?,?)",
            hash(token),
            u.id,
            now + 86400000,
          );
          res.setHeader(
            "Set-Cookie",
            `itd_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${options.secureCookies ? " ; Secure" : ""}`,
          );
          return json(res, 200, { user: safeUser(u) });
        }
        if (path === "/api/register" && method === "POST") {
          const key = "register:" + (req.socket.remoteAddress || "unknown"),
            now = Date.now();
          let limit = limits.get(key);
          if (!limit || now > limit.until) {
            limit = { count: 0, until: now + 900000 };
            limits.set(key, limit);
          }
          for (const [k, v] of limits) if (v.until < now) limits.delete(k);
          if (++limit.count > 100)
            fail(429, "Слишком много попыток. Повторите через 15 минут");
          const b = await body(req);
          if (
            !text(b.name) ||
            !email(b.email) ||
            typeof b.password !== "string" ||
            b.password.length < 12 ||
            b.password.length > 256
          )
            fail(400, "Укажите имя, email и пароль из 12–256 символов");
          if (get("SELECT id FROM users WHERE email=?", b.email.toLowerCase()))
            fail(409, "Этот email уже зарегистрирован");
          const id = Number(
            run(
              "INSERT INTO users(email,name,role,password) VALUES(?,?,?,?)",
              b.email.toLowerCase(),
              b.name.trim(),
              "client",
              passwordHash(b.password),
            ).lastInsertRowid,
          );
          const token = randomBytes(32).toString("hex");
          run(
            "INSERT INTO sessions VALUES(?,?,?)",
            hash(token),
            id,
            now + 86400000,
          );
          res.setHeader(
            "Set-Cookie",
            `itd_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${options.secureCookies ? " ; Secure" : ""}`,
          );
          return json(res, 201, {
            user: safeUser(get("SELECT * FROM users WHERE id=?", id)),
          });
        }
        if (!user) fail(401, "Войдите в кабинет");
        if (path === "/api/me" && method === "GET")
          return json(res, 200, { user: safeUser(user) });
        if (path === "/api/logout" && method === "POST") {
          if (cookie) run("DELETE FROM sessions WHERE token=?", hash(cookie));
          res.setHeader(
            "Set-Cookie",
            "itd_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
          );
          return json(res, 200, { ok: true });
        }
        if (path === "/api/projects" && method === "GET") {
          const projects = all(
            `SELECT p.id,p.title,p.status,u.name AS clientName,u.email AS clientEmail FROM projects p JOIN users u ON u.id=p.clientId ${user.role === "admin" ? "" : "WHERE p.clientId=?"} ORDER BY p.id DESC`,
            ...(user.role === "admin" ? [] : [user.id]),
          );
          for (const p of projects) {
            p.stages = all(
              "SELECT id,title,status,description FROM stages WHERE projectId=? ORDER BY id",
              p.id,
            );
            p.files = all(
              "SELECT id,name,contentType,category,stageId,size FROM files WHERE projectId=? ORDER BY id",
              p.id,
            );
          }
          return json(res, 200, { projects });
        }
        if (path === "/api/clients" && method === "GET") {
          admin();
          return json(res, 200, {
            clients: all(
              "SELECT id,name,email FROM users WHERE role='client' ORDER BY name,id",
            ),
          });
        }
        if (path === "/api/projects" && method === "POST") {
          admin();
          const b = await body(req);
          if (!text(b.title) || !Number.isSafeInteger(b.clientId))
            fail(400, "Укажите название и клиента");
          const u = get(
            "SELECT id FROM users WHERE id=? AND role='client'",
            b.clientId,
          );
          if (!u) fail(400, "Клиент не найден");
          const id = Number(
            run(
              "INSERT INTO projects(title,clientId) VALUES(?,?)",
              b.title.trim(),
              u.id,
            ).lastInsertRowid,
          );
          return json(res, 201, { id });
        }
        let match = path.match(/^\/api\/projects\/(\d+)\/stages$/);
        if (match && method === "POST") {
          admin();
          project(Number(match[1]));
          const b = await body(req);
          if (
            !text(b.title) ||
            !["planned", "in_progress", "completed"].includes(b.status) ||
            typeof (b.description ?? "") !== "string" ||
            (b.description || "").length > 10000
          )
            fail(400, "Некорректный этап");
          const id = Number(
            run(
              "INSERT INTO stages(projectId,title,status,description) VALUES(?,?,?,?)",
              Number(match[1]),
              b.title,
              b.status,
              b.description || "",
            ).lastInsertRowid,
          );
          return json(
            res,
            201,
            get(
              "SELECT id,title,status,description FROM stages WHERE id=?",
              id,
            ),
          );
        }
        match = path.match(/^\/api\/stages\/(\d+)$/);
        if (match && method === "PATCH") {
          admin();
          const old = get("SELECT * FROM stages WHERE id=?", Number(match[1]));
          if (!old) fail(404, "Этап не найден");
          const b = await body(req),
            title = b.title ?? old.title,
            status = b.status ?? old.status,
            description = b.description ?? old.description;
          if (
            !text(title) ||
            !["planned", "in_progress", "completed"].includes(status) ||
            typeof description !== "string" ||
            description.length > 10000
          )
            fail(400, "Некорректный этап");
          run(
            "UPDATE stages SET title=?,status=?,description=? WHERE id=?",
            title,
            status,
            description,
            old.id,
          );
          return json(res, 200, { id: old.id, title, status, description });
        }
        match = path.match(/^\/api\/projects\/(\d+)\/files$/);
        if (match && method === "POST") {
          admin();
          const p = project(Number(match[1])),
            b = await body(req);
          const types = {
            pdf: "application/pdf",
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            webp: "image/webp",
            txt: "text/plain",
            docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            zip: "application/zip",
          };
          if (
            !text(b.name, 180) ||
            /[\x00-\x1f\/\\]/.test(b.name) ||
            !["result", "document"].includes(b.category)
          )
            fail(400, "Некорректное имя или категория файла");
          const ext = b.name.split(".").pop().toLowerCase();
          if (!types[ext] || b.contentType !== types[ext])
            fail(400, "Тип файла не поддерживается");
          if (
            typeof b.data !== "string" ||
            b.data.length > 13981016 ||
            b.data.length % 4 !== 0 ||
            /[^A-Za-z0-9+/=]/.test(b.data)
          )
            fail(400, "Некорректные данные файла");
          const bytes = Buffer.from(b.data, "base64");
          if (bytes.toString("base64") !== b.data)
            fail(400, "Некорректные данные файла");
          if (!bytes.length || bytes.length > 10 * 1024 * 1024)
            fail(413, "Максимальный размер файла — 10 МБ");
          if (
            b.stageId != null &&
            (!Number.isSafeInteger(b.stageId) ||
              !get(
                "SELECT id FROM stages WHERE id=? AND projectId=?",
                b.stageId,
                p.id,
              ))
          )
            fail(400, "Этап не принадлежит проекту");
          const storage = randomBytes(24).toString("hex");
          writeFileSync(join(dataDir, "files", storage), bytes, {
            mode: 0o600,
            flag: "wx",
          });
          try {
            const id = Number(
              run(
                "INSERT INTO files(projectId,stageId,name,contentType,category,path,size) VALUES(?,?,?,?,?,?,?)",
                p.id,
                b.stageId ?? null,
                b.name,
                b.contentType,
                b.category,
                storage,
                bytes.length,
              ).lastInsertRowid,
            );
            return json(res, 201, {
              id,
              name: b.name,
              contentType: b.contentType,
              category: b.category,
              stageId: b.stageId ?? null,
              size: bytes.length,
            });
          } catch (e) {
            unlinkSync(join(dataDir, "files", storage));
            throw e;
          }
        }
        match = path.match(/^\/api\/files\/(\d+)(\/download|\/preview)?$/);
        if (match) {
          const f = get("SELECT * FROM files WHERE id=?", Number(match[1]));
          if (!f) fail(404, "Файл не найден");
          project(f.projectId);
          if (method === "GET" && match[2]) {
            const bytes = readFileSync(join(dataDir, "files", f.path));
            const preview = match[2] === "/preview";
            const contentType = preview ? previewType(f, bytes) : f.contentType;
            if (preview) {
              res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox; frame-ancestors 'self'");
              res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
              res.setHeader("Referrer-Policy", "no-referrer");
            }
            res.writeHead(200, {
              "Content-Type": contentType,
              "Content-Disposition": `${preview ? "inline" : "attachment"}; filename="download.${f.name.split(".").pop()}"; filename*=UTF-8''${encodeURIComponent(f.name).replace(/'/g, "%27")}`,
              "Cache-Control": "no-store",
              "Content-Length": bytes.length,
            });
            return res.end(bytes);
          }
          if (method === "DELETE" && !match[2]) {
            admin();
            run("DELETE FROM files WHERE id=?", f.id);
            try {
              unlinkSync(join(dataDir, "files", f.path));
            } catch (e) {
              if (e.code !== "ENOENT") throw e;
            }
            return json(res, 200, { ok: true });
          }
        }
        fail(404, "Маршрут не найден");
      }
      const routes = {
        "/": "tilda-home-connected-fixed.html",
        "/anketa": "tilda-anketa-connected-fixed.html",
        "/anketa/": "tilda-anketa-connected-fixed.html",
        "/reset-password": "reset-password.html",
        "/reset-password/": "reset-password.html",
        "/recovery.js": "recovery.js",
        "/cabinet": "cabinet.html",
        "/cabinet/": "cabinet.html",
        "/cabinet.js": "cabinet.js",
        "/file-viewer.js": "file-viewer.js",
        "/cabinet.css": "cabinet.css",
      };
      const asset = path.startsWith("/vendor/pdfjs/") ? path.slice("/vendor/pdfjs/".length) : null;
      const file = routes[path] || (PDF_ASSETS.has(asset) ? `vendor/pdfjs/${asset}` : null);
      if (!file || !["GET", "HEAD"].includes(method))
        fail(404, "Страница не найдена");
      let bytes;
      try {
        bytes = readFileSync(join(ROOT, file));
      } catch (e) {
        if (e.code === "ENOENT") fail(404, "Страница не найдена");
        throw e;
      }
      if (file === "reset-password.html" || file === "recovery.js") {
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      }
      if (file === "cabinet.html")
        res.setHeader(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' blob:; worker-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        );
      res.writeHead(200, {
        "Content-Type": /\.m?js$/.test(file)
          ? "text/javascript; charset=utf-8"
          : file.endsWith(".css")
            ? "text/css; charset=utf-8"
            : file.endsWith(".wasm") ? "application/wasm"
            : file.endsWith(".ttf") ? "font/ttf"
            : asset ? "application/octet-stream" : "text/html; charset=utf-8",
        "Content-Length": bytes.length,
        "Cache-Control": file === "reset-password.html" || file === "recovery.js" ? "no-store" : "no-cache",
      });
      res.end(method === "HEAD" ? undefined : bytes);
    } catch (e) {
      if (!res.headersSent)
        json(res, e.status || 500, {
          error: e.status ? e.message : "Внутренняя ошибка сервера",
        });
      else res.destroy();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  return {
    server,
    dataDir,
    close: () =>
      new Promise((resolveClose, reject) => {
        if (!server.listening) {
          db.close();
          store?.release();
          return resolveClose();
        }
        server.close((error) => {
          db.close();
          store?.release();
          error ? reject(error) : resolveClose();
        });
        server.closeIdleConnections();
      }),
  };
  } catch (error) {
    db?.close();
    store?.release();
    throw error;
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
  const app = createApp({
    secureCookies: process.env.ITD_SECURE_COOKIES === "1",
  });
  app.server.listen(
    Number(process.env.PORT || 8000),
    process.env.HOST || "127.0.0.1",
    () => console.log(`Приложение запущено. Данные: ${app.dataDir}\nКабинет: http://127.0.0.1:${app.server.address().port}/cabinet`),
  );
  app.server.once("error", (error) => {
    console.error(`Не удалось запустить приложение: ${error.message}`);
    app.close().finally(() => { process.exitCode = 1; });
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => app.close().then(() => process.exit(0)));
  } catch (error) {
    console.error(`Запуск остановлен: ${error.message}`);
    process.exitCode = 1;
  }
}

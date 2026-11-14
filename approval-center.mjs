import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import PDFKit from "pdfkit";
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const text = (s, max = 4000) =>
  typeof s === "string" && s.trim().length > 0 && s.length <= max;
const int = (n) => Number.isSafeInteger(n) && n > 0;
const strict = (b, keys) => {
  if (!b || typeof b !== "object" || Array.isArray(b))
    fail(400, "Ожидается объект данных");
  if (Object.keys(b).some((k) => !keys.includes(k)))
    fail(400, "Недопустимые поля");
};
const parse = (s) => JSON.parse(s);
export function initApprovalCenter({
  db,
  review,
  readFile,
  previewCheck,
  fontPath,
  now = Date.now,
}) {
  const get = (s, ...a) => db.prepare(s).get(...a),
    all = (s, ...a) => db.prepare(s).all(...a),
    run = (s, ...a) => db.prepare(s).run(...a);
  review.transaction(() =>
    db.exec(`
    CREATE TABLE IF NOT EXISTS approval_metadata(materialId INTEGER PRIMARY KEY REFERENCES review_materials(id), room TEXT NOT NULL DEFAULT '', required INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS approval_drafts(userId INTEGER NOT NULL REFERENCES users(id),projectId INTEGER NOT NULL REFERENCES projects(id),scope INTEGER NOT NULL,revision INTEGER NOT NULL DEFAULT 0,payload TEXT NOT NULL,updatedAt INTEGER NOT NULL,PRIMARY KEY(userId,projectId,scope));
    CREATE TABLE IF NOT EXISTS approval_view_pages(versionId INTEGER NOT NULL REFERENCES review_versions(id),userId INTEGER NOT NULL REFERENCES users(id),page INTEGER NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(versionId,userId,page));
    CREATE TABLE IF NOT EXISTS approval_view_confirmations(versionId INTEGER NOT NULL REFERENCES review_versions(id),userId INTEGER NOT NULL REFERENCES users(id),pageCount INTEGER NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(versionId,userId));
    CREATE TABLE IF NOT EXISTS approval_preview_metadata(versionId INTEGER PRIMARY KEY REFERENCES review_versions(id),pageCount INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS approval_packages(id INTEGER PRIMARY KEY,projectId INTEGER NOT NULL REFERENCES projects(id),scope INTEGER NOT NULL,userId INTEGER NOT NULL REFERENCES users(id),operationId TEXT NOT NULL,requestHash TEXT NOT NULL,roundNumber INTEGER NOT NULL,snapshot TEXT NOT NULL,createdAt INTEGER NOT NULL,UNIQUE(userId,operationId));
    CREATE TABLE IF NOT EXISTS approval_notes(id INTEGER PRIMARY KEY,materialId INTEGER NOT NULL REFERENCES review_materials(id),versionId INTEGER NOT NULL REFERENCES review_versions(id),packageId INTEGER NOT NULL REFERENCES approval_packages(id),number INTEGER NOT NULL,page INTEGER NOT NULL,x REAL NOT NULL,y REAL NOT NULL,body TEXT NOT NULL,authorId INTEGER NOT NULL REFERENCES users(id),createdAt INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',revision INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS approval_note_events(id INTEGER PRIMARY KEY,noteId INTEGER NOT NULL REFERENCES approval_notes(id),actorId INTEGER NOT NULL REFERENCES users(id),type TEXT NOT NULL,body TEXT NOT NULL,versionId INTEGER REFERENCES review_versions(id),createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS approval_corrections(versionId INTEGER PRIMARY KEY REFERENCES review_versions(id),actorId INTEGER NOT NULL REFERENCES users(id),report TEXT NOT NULL,createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS approval_publications(id INTEGER PRIMARY KEY,projectId INTEGER NOT NULL REFERENCES projects(id),scope INTEGER NOT NULL,actorId INTEGER NOT NULL REFERENCES users(id),operationId TEXT NOT NULL,requestHash TEXT NOT NULL,result TEXT NOT NULL,createdAt INTEGER NOT NULL,UNIQUE(actorId,operationId));
    CREATE TABLE IF NOT EXISTS approval_stage_events(id INTEGER PRIMARY KEY,stageId INTEGER NOT NULL REFERENCES stages(id),actorId INTEGER NOT NULL REFERENCES users(id),operationId TEXT NOT NULL,snapshot TEXT NOT NULL,createdAt INTEGER NOT NULL,UNIQUE(actorId,operationId));
    CREATE INDEX IF NOT EXISTS approval_notes_material ON approval_notes(materialId,id);
    CREATE INDEX IF NOT EXISTS approval_packages_scope ON approval_packages(projectId,scope,id);
    CREATE INDEX IF NOT EXISTS approval_note_history ON approval_note_events(noteId,id);
    CREATE TRIGGER IF NOT EXISTS approval_note_content_immutable BEFORE UPDATE ON approval_notes WHEN NEW.materialId IS NOT OLD.materialId OR NEW.versionId IS NOT OLD.versionId OR NEW.packageId IS NOT OLD.packageId OR NEW.number IS NOT OLD.number OR NEW.page IS NOT OLD.page OR NEW.x IS NOT OLD.x OR NEW.y IS NOT OLD.y OR NEW.body IS NOT OLD.body OR NEW.authorId IS NOT OLD.authorId OR NEW.createdAt IS NOT OLD.createdAt BEGIN SELECT RAISE(ABORT,'Annotation content is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS approval_notes_no_delete BEFORE DELETE ON approval_notes BEGIN SELECT RAISE(ABORT,'Annotations are immutable'); END;
  `),
  );
  for (const table of [
    "approval_packages",
    "approval_note_events",
    "approval_corrections",
    "approval_stage_events",
    "approval_publications",
  ]) {
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'Approval history is immutable'); END; CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'Approval history is immutable'); END;`,
    );
  }
  function scopeAccess(pid, scope, user) {
    const p = review.access(pid, user, fail);
    if (!Number.isSafeInteger(scope) || scope < 0)
      fail(400, "Некорректный этап");
    if (
      scope &&
      !get("SELECT id FROM stages WHERE id=? AND projectId=?", scope, pid)
    )
      fail(404, "Этап не принадлежит проекту");
    return p;
  }
  const materialAccess = (id, user) => {
    const m = get("SELECT * FROM review_materials WHERE id=?", id);
    if (!m) fail(404, "Материал не найден");
    review.access(m.projectId, user, fail);
    return m;
  };
  const versionAccess = (id, user) => {
    const v = get("SELECT * FROM review_versions WHERE id=?", id);
    if (!v) fail(404, "Версия не найдена");
    return { v, m: materialAccess(v.materialId, user) };
  };
  function notes(mid) {
    return all(
      "SELECT n.*,u.name AS authorName,v.versionNumber FROM approval_notes n JOIN users u ON u.id=n.authorId JOIN review_versions v ON v.id=n.versionId WHERE n.materialId=? ORDER BY n.id",
      mid,
    ).map((n) => ({
      ...n,
      history: all(
        "SELECT e.*,u.name AS actorName,u.role AS actorRole FROM approval_note_events e JOIN users u ON u.id=e.actorId WHERE noteId=? ORDER BY e.id",
        n.id,
      ),
    }));
  }
  function list(pid, scope, user) {
    const p = review.access(pid, user, fail);
    return all(
      "SELECT id FROM review_materials WHERE projectId=? AND stageId IS ? ORDER BY id",
      pid,
      scope || null,
    ).map(({ id }) => {
      const m = review.material(id, user),
        meta = get("SELECT * FROM approval_metadata WHERE materialId=?", id);
      return {
        ...m,
        room: meta?.room || "",
        required: meta?.required !== 0,
        metadataRevision: meta?.revision || 0,
        notes: notes(id),
        versions: m.versions.map((v) => ({
          ...v,
          correction: get(
            "SELECT report FROM approval_corrections WHERE versionId=?",
            v.id,
          )?.report,
          confirmedView: !!get(
            "SELECT 1 FROM approval_view_confirmations WHERE versionId=? AND userId=?",
            v.id,
            p.clientId,
          ),
        })),
      };
    });
  }
  const emptyDraft = () => ({ entries: [], position: {} });
  function draft(pid, scope, user) {
    const row = get(
      "SELECT * FROM approval_drafts WHERE userId=? AND projectId=? AND scope=?",
      user.id,
      pid,
      scope,
    );
    return row
      ? {
          revision: row.revision,
          updatedAt: row.updatedAt,
          ...parse(row.payload),
        }
      : { revision: 0, ...emptyDraft() };
  }
  function stageState(pid, scope, user) {
    const materials = list(pid, scope, user),
      blockers = [];
    if (!scope) blockers.push("Выберите конкретный этап");
    if (!materials.some((m) => m.required))
      blockers.push("Нет обязательных материалов");
    for (const m of materials.filter((m) => m.required)) {
      if (m.currentVersion.status !== "approved")
        blockers.push(`${m.title}: текущая версия не согласована`);
      if (m.notes.some((n) => n.status !== "confirmed"))
        blockers.push(`${m.title}: есть неподтверждённые замечания`);
    }
    const stage = scope ? get("SELECT * FROM stages WHERE id=?", scope) : null;
    return {
      blockers,
      approved: stage?.status === "approved" || stage?.status === "completed",
      token: hash([
        stage,
        materials.map((m) => [
          m.id,
          m.currentVersion.id,
          m.currentVersion.revision,
          m.required,
          m.metadataRevision,
          m.notes.map((n) => [n.id, n.revision, n.status]),
        ]),
      ]),
    };
  }
  function validateDraft(b, pid, scope, user) {
    strict(b, ["expectedRevision", "entries", "position"]);
    if (
      !Number.isSafeInteger(b.expectedRevision) ||
      b.expectedRevision < 0 ||
      !Array.isArray(b.entries) ||
      b.entries.length > 1000
    )
      fail(400, "Некорректный черновик");
    const ids = new Set();
    for (const e of b.entries) {
      if (!e || typeof e !== "object" || Array.isArray(e))
        fail(400, "Некорректное решение");
      strict(e, [
        "materialId",
        "versionId",
        "expectedRevision",
        "decision",
        "comment",
        "markers",
      ]);
      if (
        !int(e.materialId) ||
        !int(e.versionId) ||
        !Number.isSafeInteger(e.expectedRevision) ||
        e.expectedRevision < 0 ||
        ids.has(e.materialId)
      )
        fail(400, "Некорректный или повторный материал");
      ids.add(e.materialId);
      const { m, v } = versionAccess(e.versionId, user);
      if (
        m.id !== e.materialId ||
        m.projectId !== pid ||
        (m.stageId || 0) !== scope
      )
        fail(400, "Материал относится к другому проекту или этапу");
      if (
        ![null, "approved", "changes_requested"].includes(e.decision) ||
        typeof e.comment !== "string" ||
        e.comment.length > 4000
      )
        fail(400, "Некорректное решение или комментарий");
      if (!Array.isArray(e.markers) || e.markers.length > 100)
        fail(400, "Не более 100 замечаний к материалу");
      const count =
        get(
          "SELECT pageCount FROM approval_preview_metadata WHERE versionId=?",
          v.id,
        )?.pageCount || 1;
      const file = get("SELECT contentType FROM files WHERE id=?", v.fileId);
      if (
        e.markers.length &&
        !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(
          file.contentType,
        )
      )
        fail(400, "Маркеры доступны только на изображениях и PDF");
      for (const n of e.markers) {
        if (!n || typeof n !== "object") fail(400, "Некорректный маркер");
        strict(n, ["page", "x", "y", "body"]);
        if (
          !int(n.page) ||
          n.page > count ||
          ![n.x, n.y].every(
            (x) =>
              typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1,
          ) ||
          !text(n.body)
        )
          fail(400, "Проверьте страницу, координаты и текст замечания");
      }
    }
    const pos = b.position;
    if (!pos || typeof pos !== "object" || Array.isArray(pos))
      fail(400, "Некорректная позиция просмотра");
    strict(pos, [
      "materialId",
      "versionId",
      "page",
      "zoom",
      "scrollX",
      "scrollY",
    ]);
    if (pos.materialId !== undefined) {
      const m = materialAccess(pos.materialId, user);
      if (m.projectId !== pid || (m.stageId || 0) !== scope)
        fail(400, "Позиция вне выбранного этапа");
      if (
        pos.versionId !== undefined &&
        versionAccess(pos.versionId, user).m.id !== m.id
      )
        fail(400, "Позиция другой версии");
    }
    for (const k of ["page", "zoom", "scrollX", "scrollY"])
      if (
        pos[k] !== undefined &&
        (!Number.isFinite(pos[k]) || pos[k] < 0 || pos[k] > 100000)
      )
        fail(400, "Некорректная позиция");
    return { entries: b.entries, position: pos };
  }
  function reportValidation(b, mid) {
    const open = notes(mid).filter((n) => n.status !== "confirmed");
    if (!open.length && !b.correctionReport) return;
    const r = b.correctionReport;
    if (
      !r ||
      !text(r.description) ||
      !Array.isArray(r.resolutions) ||
      r.resolutions.length > 1000
    )
      fail(400, "Опишите исправления и судьбу каждого открытого замечания");
    strict(r, ["description", "resolutions"]);
    const seen = new Set();
    for (const item of r.resolutions) {
      strict(item, ["noteId", "fixed", "explanation"]);
      if (
        !int(item.noteId) ||
        seen.has(item.noteId) ||
        typeof item.fixed !== "boolean" ||
        !text(item.explanation) ||
        !open.some((n) => n.id === item.noteId)
      )
        fail(400, "Проверьте отчёт по замечаниям");
      seen.add(item.noteId);
    }
    if (open.some((n) => !seen.has(n.id)))
      fail(400, "Укажите результат по каждому открытому замечанию");
  }
  function attachCorrection(b, vid, user) {
    if (!b.correctionReport) return;
    const { v, m } = versionAccess(vid, user);
    reportValidation(b, m.id);
    const r = b.correctionReport;
    run(
      "INSERT INTO approval_corrections VALUES(?,?,?,?)",
      vid,
      user.id,
      JSON.stringify(r),
      now(),
    );
    for (const item of r.resolutions) {
      const state = item.fixed ? "fixed" : "open";
      run(
        "UPDATE approval_notes SET status=?,revision=revision+1 WHERE id=?",
        state,
        item.noteId,
      );
      run(
        "INSERT INTO approval_note_events(noteId,actorId,type,body,versionId,createdAt) VALUES(?,?,?,?,?,?)",
        item.noteId,
        user.id,
        state,
        item.explanation,
        vid,
        now(),
      );
    }
    review.addEvent(m, v, user, "corrections_ready", r.description, "client");
  }
  async function countPages(v) {
    const cached = get(
      "SELECT pageCount FROM approval_preview_metadata WHERE versionId=?",
      v.id,
    );
    if (cached) return cached.pageCount;
    const f = get("SELECT * FROM files WHERE id=?", v.fileId);
    let count = 1;
    if (
      ["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(
        f.contentType,
      )
    )
      previewCheck(f);
    if (f.contentType === "application/pdf") {
      try {
        const pdf = await PDFDocument.load(readFile(f), {
          updateMetadata: false,
        });
        count = pdf.getPageCount();
      } catch {
        fail(
          415,
          "Не удалось проверить страницы PDF. Используйте корректный PDF",
        );
      }
      if (count < 1 || count > 5000)
        fail(415, "PDF должен содержать от 1 до 5000 страниц");
    }
    run(
      "INSERT OR IGNORE INTO approval_preview_metadata VALUES(?,?)",
      v.id,
      count,
    );
    return count;
  }
  function snapshot(pid, scope, user, roundNumber, materials, entries) {
    const p = review.access(pid, user, fail),
      stage = scope ? get("SELECT title FROM stages WHERE id=?", scope) : null;
    return {
      studio: "ITD Studio",
      projectId: pid,
      projectTitle: p.title,
      scope,
      stageTitle: stage?.title || "Материалы проекта без этапа",
      roundNumber,
      createdAt: now(),
      actorId: user.id,
      actorName: user.name,
      materials: materials.map((m) => {
        const e = entries.find((e) => e.materialId === m.id);
        return {
          materialId: m.id,
          title: m.title,
          room: m.room,
          required: m.required,
          fileId: m.currentVersion.file.id,
          fileName: m.currentVersion.file.name,
          versionId: m.currentVersion.id,
          versionNumber: m.currentVersion.versionNumber,
          decision: e?.decision || null,
          existingStatus: m.currentVersion.status,
          comment: e?.comment || "",
          notes: notes(m.id),
          markers: (e?.markers || []).map((n, i) => ({
            ...n,
            number:
              get(
                "SELECT COALESCE(MAX(number),0) AS n FROM approval_notes WHERE versionId=?",
                m.currentVersion.id,
              ).n +
              i +
              1,
          })),
        };
      }),
    };
  }
  function pdfReport(res, s) {
    const doc = new PDFKit({
      size: "A4",
      margin: 44,
      bufferPages: true,
      info: { Title: `ITD Studio — ведомость, раунд ${s.roundNumber}` },
    });
    res.writeHead(200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="approval-statement.pdf"',
      "Cache-Control": "no-store",
    });
    doc.pipe(res);
    doc.font(fontPath).fontSize(20).text("ITD Studio · Ведомость согласования");
    doc
      .fontSize(11)
      .text(
        `${s.projectTitle}\n${s.stageTitle}\nРаунд ${s.roundNumber} · ${new Date(s.createdAt).toLocaleString("ru-RU", { timeZone: "Europe/Moscow" })} (Москва)\n${s.actorName}`,
      )
      .moveDown();
    const labels = {
      approved: "Согласовано",
      changes_requested: "На доработку",
    };
    const counts = { approved: 0, changes_requested: 0, undecided: 0 };
    s.materials.forEach((m) => counts[m.decision || "undecided"]++);
    doc
      .text(
        `Согласовано: ${counts.approved} · На доработку: ${counts.changes_requested} · Без решения в пакете: ${counts.undecided}`,
      )
      .moveDown();
    for (const m of s.materials) {
      if (doc.y > 680) doc.addPage();
      const title = `${m.title} · v${m.versionNumber}\n${m.fileName}`,
        decision = labels[m.decision] || "Без решения в этом пакете";
      doc.fontSize(10);
      const height =
        Math.max(
          doc.heightOfString(title, { width: 300 }),
          doc.heightOfString(decision, { width: 160 }),
        ) + 14;
      if (doc.y + height > doc.page.height - 50) doc.addPage();
      const y = doc.y;
      doc.text(title, 44, y, { width: 300 });
      doc.text(decision, 360, y, { width: 190 });
      doc.y = y + height;
      doc
        .moveTo(44, doc.y - 6)
        .lineTo(550, doc.y - 6)
        .strokeColor("#d8d2c8")
        .stroke();
      if (m.comment) doc.text(m.comment, 44, doc.y, { width: 507 });
      for (const n of m.markers || [])
        doc.text(
          `Маркер ${n.number || m.markers.indexOf(n) + 1} · стр. ${n.page} · (${n.x.toFixed(3)}, ${n.y.toFixed(3)}): ${n.body}`,
        );
      for (const n of m.notes || []) {
        doc.text(
          `Замечание №${n.id}, v${n.versionNumber}, стр. ${n.page}: ${n.body} [${n.status}]`,
        );
        for (const e of n.history)
          doc.text(`${e.actorName}: ${e.type} — ${e.body}`);
      }
      doc.moveDown();
    }
    doc
      .fontSize(9)
      .text(
        "Внутренняя фиксация действий в системе. Не является электронной подписью.",
      );
    doc.end();
  }
  async function handle({ req, res, path, method, url, user, body, json }) {
    if (!path.startsWith("/api/approval-center/")) return false;
    if (!user) fail(401, "Войдите в кабинет");
    let match = path.match(
      /^\/api\/approval-center\/projects\/(\d+)\/stages\/(\d+)(?:\/(draft|submit|approve-stage|publish))?$/,
    );
    if (match) {
      const pid = +match[1],
        scope = +match[2],
        action = match[3];
      scopeAccess(pid, scope, user);
      if (!action && method === "GET") {
        const materials = list(pid, scope, user),
          d = draft(pid, scope, user);
        const conflicts = d.entries
          .filter(
            (e) =>
              !materials.some(
                (m) =>
                  m.id === e.materialId &&
                  m.currentVersion.id === e.versionId &&
                  m.currentVersion.revision === e.expectedRevision,
              ),
          )
          .map((e) => e.materialId);
        json(res, 200, {
          materials,
          draft: d,
          conflicts,
          stage: stageState(pid, scope, user),
          packages: all(
            "SELECT id,roundNumber,createdAt,userId FROM approval_packages WHERE projectId=? AND scope=? ORDER BY id DESC",
            pid,
            scope,
          ),
        });
        return true;
      }
      const b = await body(req);
      scopeAccess(pid, scope, user);
      if (action === "publish" && method === "POST") {
        if (user.role !== "admin") fail(403, "Пакет направляет студия");
        strict(b, ["fileIds", "operationId", "confirm"]);
        if (
          !text(b.operationId, 100) ||
          b.confirm !== true ||
          !Array.isArray(b.fileIds) ||
          b.fileIds.length < 1 ||
          b.fileIds.length > 100 ||
          b.fileIds.some((id) => !int(id)) ||
          new Set(b.fileIds).size !== b.fileIds.length
        )
          fail(
            400,
            "Выберите от 1 до 100 разных файлов и подтвердите отправку",
          );
        const requestHash = hash([pid, scope, b]);
        const result = review.transaction(() => {
          const old = get(
            "SELECT * FROM approval_publications WHERE actorId=? AND operationId=?",
            user.id,
            b.operationId,
          );
          if (old) {
            if (old.requestHash !== requestHash)
              fail(409, "Операция уже использована");
            return parse(old.result);
          }
          const files = b.fileIds.map((id) =>
            get("SELECT * FROM files WHERE id=?", id),
          );
          if (
            files.some(
              (f) =>
                !f ||
                f.projectId !== pid ||
                (f.stageId || 0) !== scope ||
                f.category !== "result" ||
                review.isLinked(f.id),
            )
          )
            fail(
              409,
              "Один из файлов перемещён, уже направлен или не относится к выбранному разделу. Пакет не отправлен",
            );
          const materials = files.map((f) =>
            review.attachFile(
              f.id,
              { review: true, category: "result", stageId: f.stageId },
              pid,
              user,
              fail,
              { notify: false },
            ),
          );
          const first = review.material(materials[0].materialId, user);
          review.addEvent(
            first,
            first.currentVersion,
            user,
            "package_published",
            `Студия направила на согласование ${materials.length} материалов`,
            "client",
          );
          const result = { materials };
          run(
            "INSERT INTO approval_publications(projectId,scope,actorId,operationId,requestHash,result,createdAt) VALUES(?,?,?,?,?,?,?)",
            pid,
            scope,
            user.id,
            b.operationId,
            requestHash,
            JSON.stringify(result),
            now(),
          );
          return result;
        });
        json(res, 200, result);
        return true;
      }
      if (user.role !== "client") fail(403, "Решение принимает клиент проекта");
      if (action === "draft" && method === "PUT") {
        const payload = validateDraft(b, pid, scope, user);
        const result = review.transaction(() => {
          const old = draft(pid, scope, user);
          if (old.revision !== b.expectedRevision)
            fail(
              409,
              "Черновик изменён в другой вкладке. Обновите данные; ваши изменения пока не отправлены",
            );
          run(
            "INSERT INTO approval_drafts VALUES(?,?,?,?,?,?) ON CONFLICT(userId,projectId,scope) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updatedAt=excluded.updatedAt",
            user.id,
            pid,
            scope,
            old.revision + 1,
            JSON.stringify(payload),
            now(),
          );
          return draft(pid, scope, user);
        });
        json(res, 200, result);
        return true;
      }
      if (action === "submit" && method === "POST") {
        strict(b, ["operationId", "expectedRevision", "confirm"]);
        if (
          !text(b.operationId, 100) ||
          !Number.isSafeInteger(b.expectedRevision) ||
          b.confirm !== true
        )
          fail(400, "Подтвердите отправку пакета");
        const requestHash = hash([pid, scope, b]);
        const result = review.transaction(() => {
          const old = get(
            "SELECT * FROM approval_packages WHERE userId=? AND operationId=?",
            user.id,
            b.operationId,
          );
          if (old) {
            if (old.requestHash !== requestHash)
              fail(409, "Идентификатор уже использован для другой операции");
            return {
              packageId: old.id,
              roundNumber: old.roundNumber,
              replayed: true,
            };
          }
          const d = draft(pid, scope, user);
          if (d.revision !== b.expectedRevision)
            fail(409, "Черновик изменился. Проверьте сводку заново");
          const entries = d.entries.filter(
            (e) => e.decision || e.markers.length || e.comment.trim(),
          );
          if (!entries.length)
            fail(400, "Нет подготовленных решений или замечаний");
          validateDraft(
            { expectedRevision: d.revision, entries, position: d.position },
            pid,
            scope,
            user,
          );
          const materials = list(pid, scope, user);
          for (const e of entries) {
            const m = materials.find((m) => m.id === e.materialId),
              v = m?.currentVersion;
            if (
              !v ||
              v.id !== e.versionId ||
              v.revision !== e.expectedRevision ||
              v.status !== "pending_approval"
            )
              fail(
                409,
                `Материал №${e.materialId}: версия или решение изменились. Пакет целиком не отправлен`,
              );
            if (
              e.decision === "approved" &&
              !get(
                "SELECT 1 FROM approval_view_confirmations WHERE versionId=? AND userId=?",
                v.id,
                user.id,
              )
            )
              fail(
                409,
                `Материал №${e.materialId}: подтвердите просмотр всех страниц`,
              );
            if (e.decision === "changes_requested" && !text(e.comment))
              fail(400, `Материал №${e.materialId}: требуется пояснение`);
          }
          const previous = get(
            "SELECT * FROM approval_packages WHERE projectId=? AND scope=? ORDER BY id DESC LIMIT 1",
            pid,
            scope,
          );
          const prev = previous ? parse(previous.snapshot) : null;
          const changed =
            prev &&
            materials.some(
              (m) =>
                !prev.materials.some(
                  (p) =>
                    p.materialId === m.id &&
                    p.versionId === m.currentVersion.id,
                ),
            );
          const roundNumber = previous
            ? previous.roundNumber + (changed ? 1 : 0)
            : 1;
          const s = snapshot(pid, scope, user, roundNumber, materials, entries);
          const id = Number(
            run(
              "INSERT INTO approval_packages(projectId,scope,userId,operationId,requestHash,roundNumber,snapshot,createdAt) VALUES(?,?,?,?,?,?,?,?)",
              pid,
              scope,
              user.id,
              b.operationId,
              requestHash,
              roundNumber,
              JSON.stringify(s),
              now(),
            ).lastInsertRowid,
          );
          for (const e of entries) {
            const m = materials.find((m) => m.id === e.materialId),
              v = m.currentVersion;
            if (e.decision) {
              run(
                "UPDATE review_versions SET status=?,revision=revision+1,decisionAt=?,decisionBy=? WHERE id=?",
                e.decision,
                now(),
                user.id,
                v.id,
              );
              review.addEvent(m, v, user, e.decision, e.comment);
            } else if (e.comment.trim())
              review.addEvent(m, v, user, "comment", e.comment);
            for (const n of e.markers) {
              const nid = Number(
                run(
                  "INSERT INTO approval_notes(materialId,versionId,packageId,number,page,x,y,body,authorId,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)",
                  m.id,
                  v.id,
                  id,
                  get(
                    "SELECT COALESCE(MAX(number),0)+1 AS n FROM approval_notes WHERE versionId=?",
                    v.id,
                  ).n,
                  n.page,
                  n.x,
                  n.y,
                  n.body,
                  user.id,
                  now(),
                ).lastInsertRowid,
              );
              run(
                "INSERT INTO approval_note_events(noteId,actorId,type,body,versionId,createdAt) VALUES(?,?,?,?,?,?)",
                nid,
                user.id,
                "open",
                n.body,
                v.id,
                now(),
              );
              review.addEvent(m, v, user, "annotation", n.body);
            }
          }
          const first = materials.find((m) => m.id === entries[0].materialId);
          review.addEvent(
            first,
            first.currentVersion,
            user,
            "package_submitted",
            `Ведомость №${id}, раунд ${roundNumber}: ${entries.length} материалов`,
            "admin",
          );
          review.deriveStage(scope || null);
          run(
            "UPDATE approval_drafts SET revision=revision+1,payload=?,updatedAt=? WHERE userId=? AND projectId=? AND scope=?",
            JSON.stringify({ entries: [], position: d.position }),
            now(),
            user.id,
            pid,
            scope,
          );
          return {
            packageId: id,
            roundNumber,
            accepted: entries.map((e) => e.materialId),
          };
        });
        json(res, 200, result);
        return true;
      }
      if (action === "approve-stage" && method === "POST") {
        strict(b, ["operationId", "token", "confirm"]);
        if (
          !text(b.operationId, 100) ||
          b.confirm !== true ||
          !text(b.token, 100)
        )
          fail(400, "Подтвердите отдельное согласование этапа");
        const result = review.transaction(() => {
          const old = get(
            "SELECT * FROM approval_stage_events WHERE actorId=? AND operationId=?",
            user.id,
            b.operationId,
          );
          if (old) {
            if (old.stageId !== scope || parse(old.snapshot).token !== b.token)
              fail(409, "Операция уже использована");
            return { ok: true, replayed: true };
          }
          const state = stageState(pid, scope, user);
          if (
            state.token !== b.token ||
            state.blockers.length ||
            state.approved
          )
            fail(
              409,
              state.blockers.join("; ") || "Состояние этапа изменилось",
            );
          run(
            "INSERT INTO approval_stage_events(stageId,actorId,operationId,snapshot,createdAt) VALUES(?,?,?,?,?)",
            scope,
            user.id,
            b.operationId,
            JSON.stringify({ ...state, projectId: pid }),
            now(),
          );
          run("UPDATE stages SET status='approved' WHERE id=?", scope);
          const m = list(pid, scope, user)[0];
          review.addEvent(
            m,
            m.currentVersion,
            user,
            "stage_approved",
            "Этап согласован отдельно от файлов",
            "admin",
          );
          return { ok: true };
        });
        json(res, 200, result);
        return true;
      }
      fail(405, "Метод не поддерживается");
    }
    match = path.match(/^\/api\/approval-center\/versions\/(\d+)\/view$/);
    if (match && method === "POST") {
      const b = await body(req);
      strict(b, ["page", "confirm", "downloaded"]);
      if (user.role !== "client") fail(403, "Просмотр подтверждает клиент");
      const { v, m } = versionAccess(+match[1], user);
      const file = get("SELECT contentType FROM files WHERE id=?", v.fileId);
      if (
        b.page !== undefined &&
        !["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(
          file.contentType,
        ) &&
        b.downloaded !== true
      )
        fail(400, "Подтвердите проверку скачанного оригинала");
      const count = await countPages(v);
      req.itdRecheckSession?.();
      review.access(m.projectId, user, fail);
      const result = review.transaction(() => {
        if (b.page !== undefined) {
          if (!int(b.page) || b.page > count)
            fail(400, "Некорректная страница");
          run(
            "INSERT OR IGNORE INTO approval_view_pages VALUES(?,?,?,?)",
            v.id,
            user.id,
            b.page,
            now(),
          );
        }
        const seen = all(
          "SELECT page FROM approval_view_pages WHERE versionId=? AND userId=? ORDER BY page",
          v.id,
          user.id,
        ).map((x) => x.page);
        if (b.confirm === true) {
          if (seen.length !== count)
            fail(409, `Просмотрены ${seen.length} из ${count} страниц`);
          run(
            "INSERT OR IGNORE INTO approval_view_confirmations VALUES(?,?,?,?)",
            v.id,
            user.id,
            count,
            now(),
          );
          run(
            "INSERT INTO review_views VALUES(?,?,?,?,1) ON CONFLICT(versionId,userId) DO UPDATE SET lastViewedAt=excluded.lastViewedAt",
            v.id,
            user.id,
            now(),
            now(),
          );
        }
        return {
          pages: seen,
          pageCount: count,
          confirmed: !!get(
            "SELECT 1 FROM approval_view_confirmations WHERE versionId=? AND userId=?",
            v.id,
            user.id,
          ),
        };
      });
      json(res, 200, result);
      return true;
    }
    match = path.match(/^\/api\/approval-center\/materials\/(\d+)\/metadata$/);
    if (match && method === "PATCH") {
      const b = await body(req),
        m = materialAccess(+match[1], user);
      if (user.role !== "admin")
        fail(403, "Только студия меняет состав обязательных материалов");
      strict(b, ["room", "required", "expectedRevision"]);
      if (
        typeof b.room !== "string" ||
        b.room.length > 120 ||
        typeof b.required !== "boolean" ||
        !Number.isSafeInteger(b.expectedRevision)
      )
        fail(400, "Некорректные свойства материала");
      review.transaction(() => {
        const old = get(
          "SELECT * FROM approval_metadata WHERE materialId=?",
          m.id,
        );
        if ((old?.revision || 0) !== b.expectedRevision)
          fail(409, "Свойства изменились");
        run(
          "INSERT INTO approval_metadata VALUES(?,?,?,?) ON CONFLICT(materialId) DO UPDATE SET room=excluded.room,required=excluded.required,revision=excluded.revision",
          m.id,
          b.room.trim(),
          +b.required,
          b.expectedRevision + 1,
        );
        if (m.stageId && (old?.required ?? 1) !== +b.required)
          run(
            "UPDATE stages SET status='pending_approval' WHERE id=? AND status IN ('approved','completed')",
            m.stageId,
          );
        review.addEvent(
          m,
          review.latest(m.id),
          user,
          "metadata_changed",
          JSON.stringify({ room: b.room.trim(), required: b.required }),
        );
        review.deriveStage(m.stageId);
      });
      json(res, 200, { ok: true });
      return true;
    }
    match = path.match(/^\/api\/approval-center\/notes\/(\d+)\/events$/);
    if (match && method === "POST") {
      const b = await body(req);
      strict(b, ["type", "body", "expectedRevision", "versionId"]);
      if (
        !text(b.body) ||
        !Number.isSafeInteger(b.expectedRevision) ||
        !["reply", "fixed", "confirmed", "reopened", "open"].includes(b.type)
      )
        fail(400, "Укажите действие и пояснение");
      review.transaction(() => {
        const n = get("SELECT * FROM approval_notes WHERE id=?", +match[1]);
        if (!n) fail(404, "Замечание не найдено");
        const m = materialAccess(n.materialId, user);
        if (n.revision !== b.expectedRevision)
          fail(409, "Замечание изменилось. Обновите данные");
        if (
          (user.role === "admin" &&
            ["confirmed", "reopened"].includes(b.type)) ||
          (user.role !== "admin" && b.type === "fixed")
        )
          fail(403, "Это действие другой стороны");
        if (b.type === "confirmed" && n.status !== "fixed")
          fail(409, "Дизайнер ещё не отметил исправление");
        const v = b.versionId
          ? versionAccess(b.versionId, user).v
          : review.latest(m.id);
        if (v.materialId !== m.id) fail(400, "Версия другого материала");
        const status = b.type === "reply" ? n.status : b.type;
        run(
          "UPDATE approval_notes SET status=?,revision=revision+1 WHERE id=?",
          status,
          n.id,
        );
        if (
          ["open", "reopened"].includes(status) &&
          m.stageId &&
          get(
            "SELECT COALESCE((SELECT required FROM approval_metadata WHERE materialId=?),1) AS required",
            m.id,
          ).required
        )
          run(
            "UPDATE stages SET status='changes_requested' WHERE id=? AND status IN ('approved','completed')",
            m.stageId,
          );
        run(
          "INSERT INTO approval_note_events(noteId,actorId,type,body,versionId,createdAt) VALUES(?,?,?,?,?,?)",
          n.id,
          user.id,
          b.type,
          b.body,
          v.id,
          now(),
        );
        review.addEvent(
          m,
          v,
          user,
          "annotation_" + b.type,
          b.body,
          user.role === "admin" ? "client" : "admin",
        );
        review.deriveStage(m.stageId);
      });
      json(res, 200, { ok: true });
      return true;
    }
    match = path.match(/^\/api\/approval-center\/packages\/(\d+)(\/pdf)?$/);
    if (match && method === "GET") {
      const p = get("SELECT * FROM approval_packages WHERE id=?", +match[1]);
      if (!p) fail(404, "Ведомость не найдена");
      review.access(p.projectId, user, fail);
      const s = parse(p.snapshot);
      if (match[2]) pdfReport(res, s);
      else json(res, 200, { id: p.id, ...s });
      return true;
    }
    fail(404, "Маршрут не найден");
  }
  return { handle, reportValidation, attachCorrection };
}

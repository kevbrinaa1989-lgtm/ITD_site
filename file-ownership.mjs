import { projectFiles } from "./file-records.mjs";

export function initFileOwnership({ db, transaction, removeFile }) {
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  function validStage(stageId, projectId, fail) {
    if (
      stageId !== null &&
      (!Number.isSafeInteger(stageId) ||
        !get(
          "SELECT id FROM stages WHERE id=? AND projectId=?",
          stageId,
          projectId,
        ))
    )
      fail(400, "Этап не принадлежит проекту");
    return stageId;
  }
  async function handle({
    req,
    res,
    path,
    method,
    url,
    user,
    project,
    admin,
    body,
    json,
    fail,
  }) {
    let match = path.match(/^\/api\/projects\/(\d+)\/files$/);
    if (match && method === "GET") {
      const p = project(Number(match[1]));
      if (
        [...url.searchParams.keys()].some(
          (k) => !["stageId", "category"].includes(k),
        )
      )
        fail(400, "Неизвестный фильтр файлов");
      const raw = url.searchParams.get("stageId");
      const stageId = validStage(
        raw === null || raw === "none"
          ? null
          : /^\d+$/.test(raw)
            ? Number(raw)
            : NaN,
        p.id,
        fail,
      );
      const category = url.searchParams.get("category");
      if (category && !["result", "document"].includes(category))
        fail(400, "Неизвестный раздел файлов");
      return (
        json(res, 200, {
          projectId: p.id,
          stageId,
          files: projectFiles(db, p.id, stageId).filter(
            (f) => !category || f.category === category,
          ),
        }),
        true
      );
    }
    match = path.match(/^\/api\/projects\/(\d+)\/files\/(\d+)$/);
    if (!match || !["PATCH", "DELETE"].includes(method)) return false;
    admin();
    const b = await body(req);
    const result = transaction(() => {
      const p = project(Number(match[1]));
      const f = get(
        "SELECT * FROM files WHERE id=? AND projectId=?",
        Number(match[2]),
        p.id,
      );
      if (!f) fail(404, "Файл не найден в выбранном проекте");
      if (method === "DELETE") {
        if (
          Object.keys(b).some((k) => k !== "expectedStageId") ||
          !Object.hasOwn(b, "expectedStageId") ||
          b.expectedStageId !== f.stageId
        )
          fail(409, "Принадлежность файла изменилась. Обновите данные.");
        if (get("SELECT id FROM review_versions WHERE fileId=?", f.id))
          fail(
            409,
            "Файл входит в историю согласования и не может быть удалён",
          );
        db.prepare("DELETE FROM files WHERE id=?").run(f.id);
        return { ok: true, removedFile: f };
      }
      if (
        Object.keys(b).some(
          (k) =>
            !["stageId", "title", "expectedStageId", "expectedTitle"].includes(
              k,
            ),
        ) ||
        !("stageId" in b || "title" in b)
      )
        fail(400, "Недопустимые поля изменения файла");
      if (
        !Object.hasOwn(b, "expectedStageId") ||
        b.expectedStageId !== f.stageId
      )
        fail(409, "Принадлежность файла изменилась. Обновите данные.");
      const m = get(
        "SELECT m.* FROM review_materials m JOIN review_versions v ON v.materialId=m.id WHERE v.fileId=?",
        f.id,
      );
      const d = get("SELECT * FROM document_cards WHERE fileId=?", f.id);
      const oldTitle =
        m?.title ||
        d?.title ||
        (f.category === "document" ? f.name.replace(/\.[^.]+$/, "") : f.name);
      const stageId =
        "stageId" in b ? validStage(b.stageId, p.id, fail) : f.stageId;
      let title = oldTitle;
      if ("title" in b) {
        if (b.expectedTitle !== oldTitle)
          fail(409, "Название файла изменилось. Обновите данные.");
        if (
          typeof b.title !== "string" ||
          !b.title.trim() ||
          b.title.length > 160 ||
          /[\x00-\x1f\/\\]/.test(b.title)
        )
          fail(
            400,
            "Укажите название длиной до 160 символов без служебных знаков",
          );
        title = b.title.trim();
        if (
          !m &&
          f.category !== "document" &&
          title.split(".").pop().toLowerCase() !==
            f.name.split(".").pop().toLowerCase()
        )
          fail(400, "При переименовании сохраните расширение файла");
      }
      if (m)
        db.prepare(
          "UPDATE review_materials SET stageId=?,title=? WHERE id=?",
        ).run(stageId, title, m.id);
      else {
        db.prepare("UPDATE files SET stageId=? WHERE id=?").run(stageId, f.id);
        if ("title" in b) {
          if (f.category === "document")
            db.prepare(
              "INSERT INTO document_cards(fileId,title,kind) VALUES(?,?,?) ON CONFLICT(fileId) DO UPDATE SET title=excluded.title",
            ).run(f.id, title, d?.kind || "Документ");
          else
            db.prepare("UPDATE files SET name=? WHERE id=?").run(title, f.id);
        }
      }
      db.prepare(
        "INSERT INTO admin_management_events(type,actorId,clientId,projectId,payload,createdAt) VALUES(?,?,?,?,?,?)",
      ).run(
        "file.updated",
        user.id,
        p.clientId,
        p.id,
        JSON.stringify({
          fileId: f.id,
          materialId: m?.id ?? null,
          fromStageId: f.stageId,
          toStageId: stageId,
          fromTitle: oldTitle,
          toTitle: title,
        }),
        Date.now(),
      );
      return {
        projectId: p.id,
        stageId,
        files: projectFiles(db, p.id, stageId).filter((row) =>
          m ? row.review?.materialId === m.id : row.id === f.id,
        ),
      };
    });
    if (result.removedFile) {
      removeFile(result.removedFile);
      delete result.removedFile;
    }
    json(res, 200, result);
    return true;
  }
  return { handle };
}

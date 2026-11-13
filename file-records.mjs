import { decorateReviewFiles } from "./material-review.mjs";

// One projection for the project aggregate and the scoped file API.
export function projectFiles(db, projectId, scope) {
  const scoped = scope !== undefined;
  const rows = db
    .prepare(
      `SELECT f.id,f.projectId,f.name,f.contentType,f.category,f.stageId,f.size,
    d.title AS docTitle,d.kind AS docKind,d.docNumber,d.docDate
    FROM files f LEFT JOIN document_cards d ON d.fileId=f.id
    WHERE f.projectId=?${scoped ? " AND f.stageId IS ?" : ""} ORDER BY f.id`,
    )
    .all(projectId, ...(scoped ? [scope] : []));
  return decorateReviewFiles(
    db,
    rows.map(({ docTitle, docKind, docNumber, docDate, ...file }) => ({
      ...file,
      ...(file.category === "document"
        ? {
            document: {
              title: docTitle || file.name.replace(/\.[^.]+$/, ""),
              kind: docKind || "Документ",
              number: docNumber || "",
              date: docDate || "",
            },
          }
        : {}),
    })),
  );
}

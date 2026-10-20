import { randomBytes, createHash } from "node:crypto";
const TTL = 30 * 60 * 1000;
const CONTEXT_ERROR =
  "Контекст загрузки изменился или истёк. Повторно выберите проект и файл.";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
}
export function createUploadIntents({
  now = Date.now,
  maxEntries = 1000,
} = {}) {
  const entries = new Map();
  function prune() {
    const timestamp = now();
    for (const [key, entry] of entries)
      if (entry.expiresAt <= timestamp) entries.delete(key);
  }
  function issue({
    sessionHash,
    adminId,
    projectId,
    clientId,
    materialId = null,
    expectedVersionId = null,
    revision = null,
  }) {
    prune();
    if (entries.size >= maxEntries)
      fail(429, "Слишком много подготовленных загрузок. Повторите позже.");
    const ticket = randomBytes(32).toString("hex"),
      expiresAt = now() + TTL;
    entries.set(hash(ticket), {
      sessionHash,
      adminId,
      projectId,
      clientId,
      materialId,
      expectedVersionId,
      revision,
      expiresAt,
    });
    return {
      uploadIntent: ticket,
      projectId,
      clientId,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
  function validate({
    uploadIntent,
    sessionHash,
    adminId,
    projectId,
    clientId,
    payload,
    currentVersionId = null,
    currentRevision = null,
  }) {
    prune();
    if (
      typeof uploadIntent !== "string" ||
      !/^[a-f0-9]{64}$/.test(uploadIntent)
    )
      fail(409, CONTEXT_ERROR);
    const entry = entries.get(hash(uploadIntent));
    if (!entry) fail(409, CONTEXT_ERROR);
    if (entry.sessionHash !== sessionHash || entry.adminId !== adminId)
      fail(
        403,
        "Эта загрузка подготовлена в другой сессии. Подготовьте файл заново.",
      );
    if (
      entry.projectId !== projectId ||
      entry.clientId !== clientId ||
      entry.materialId !== (payload.materialId ?? null) ||
      entry.expectedVersionId !== (payload.expectedVersionId ?? null)
    )
      fail(409, CONTEXT_ERROR);
    const { uploadIntent: ignoredTicket, ...content } = payload;
    const digest = hash(canonical(content));
    if (entry.result) {
      if (entry.digest !== digest)
        fail(
          409,
          "Эта загрузка уже завершена с другим содержимым. Подготовьте файл заново.",
        );
      return { entry, digest, result: structuredClone(entry.result) };
    }
    if (
      entry.materialId !== null &&
      (entry.expectedVersionId !== currentVersionId ||
        entry.revision !== currentRevision)
    )
      fail(409, CONTEXT_ERROR);
    return { entry, digest, result: null };
  }
  function complete(check, result) {
    check.entry.digest = check.digest;
    check.entry.result = structuredClone(result);
  }
  return { issue, validate, complete };
}

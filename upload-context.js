"use strict";
(() => {
  const records = new Map();
  let h, pendingDialog;
  const contextOf = (project) =>
    project
      ? {
          projectId: project.id,
          clientId: project.clientId,
          projectTitle: project.title,
          clientLabel: project.clientId === null ? "Без клиента" : `${project.clientName} / ${project.clientEmail}`,
        }
      : null;
  const same = (a, b) =>
    !!a && !!b && a.projectId === b.projectId && a.clientId === b.clientId;
  const networkError = (error) => {
    if (error instanceof TypeError)
      return new Error(
        "Нет связи с сервером. Загрузка не подтверждена. Проверьте подключение и повторите отправку для этого же проекта.",
      );
    return error;
  };
  function clear(record) {
    record.draft = null;
    record.form.reset();
    showRecipient(record);
  }
  function prune() {
    for (const [form, record] of records)
      if (!form.isConnected && !record.busy) records.delete(form);
  }
  function showRecipient(record) {
    const context = record.draft?.context || record.context();
    record.projectLine.textContent = `Загрузка в проект: ${context?.projectTitle || "не выбран"}`;
    record.clientLine.textContent = `Клиент: ${context?.clientLabel || "не выбран"}`;
  }
  async function prepare(record, draft) {
    try {
      const context = draft.context;
      const result = await h.api(
        `/api/projects/${context.projectId}/upload-intents`,
        "POST",
        {
          ...(context.materialId
            ? {
                materialId: context.materialId,
                expectedVersionId: context.expectedVersionId,
              }
            : {}),
        },
      );
      if (record.draft !== draft || h.getUser() !== draft.user) return;
      if (
        result.projectId !== context.projectId ||
        result.clientId !== context.clientId
      )
        throw new Error(
          "Получатель проекта изменился. Выберите файл заново после проверки клиента.",
        );
      draft.ticket = result.uploadIntent;
      draft.error = null;
    } catch (error) {
      if (record.draft === draft) {
        draft.error = networkError(error);
        h.message(draft.error.message, true);
      }
    }
  }
  function register(form, { context, receiver }) {
    prune();
    if (records.has(form)) return;
    const box = receiver || document.createElement("div");
    box.classList.add("upload-recipient");
    if (!receiver) {
      box.setAttribute("aria-live", "polite");
      box.append(document.createElement("p"), document.createElement("p"));
      form.insertBefore(box, form.querySelector("button[type=submit]"));
    }
    const record = {
      form,
      context,
      input: form.querySelector('input[type="file"]'),
      projectLine: box.children[0],
      clientLine: box.children[1],
      draft: null,
      busy: false,
    };
    records.set(form, record);
    record.input.addEventListener("change", () => {
      const file = record.input.files[0],
        current = context();
      record.draft = null;
      if (file && current && h.getUser()?.role === "admin") {
        const draft = { context: { ...current }, file, user: h.getUser() };
        record.draft = draft;
        draft.ready = prepare(record, draft);
      }
      showRecipient(record);
    });
    showRecipient(record);
  }
  function check(record, draft) {
    if (
      !record.form.isConnected ||
      record.draft !== draft ||
      draft.user !== h.getUser() ||
      !same(draft.context, contextOf(h.getProject())) ||
      !same(draft.context, record.context()) ||
      record.input.files[0] !== draft.file
    )
      throw new Error(
        "Проект загрузки изменился. Отправка заблокирована. Выберите файл заново в нужном проекте.",
      );
  }
  async function send(form, extra) {
    const record = records.get(form),
      draft = record?.draft;
    if (!draft) throw new Error("Выберите файл для текущего проекта.");
    if (record.busy) return null;
    check(record, draft);
    record.busy = true;
    const controls = [
      ...form.querySelectorAll("button,input,select,textarea"),
    ].map((n) => [n, n.disabled]);
    controls.forEach(([n]) => (n.disabled = true));
    try {
      await draft.ready;
      check(record, draft);
      if (!draft.ticket) {
        // Retry preparation only for the originally captured recipient.
        draft.ready = prepare(record, draft);
        await draft.ready;
        check(record, draft);
        if (!draft.ticket)
          throw draft.error || new Error("Не удалось подготовить загрузку.");
      }
      if (!draft.payload) {
        const encoded = await h.encodeFile(draft.file);
        check(record, draft);
        draft.parameters = JSON.stringify(extra);
        draft.payload = { ...encoded, ...extra, uploadIntent: draft.ticket };
      }
      if (draft.parameters !== JSON.stringify(extra))
        throw new Error(
          "Параметры подготовленной загрузки изменились. Для другой загрузки выберите файл заново; для повтора верните прежние параметры.",
        );
      const result = await h.api(
        `/api/projects/${draft.context.projectId}/files`,
        "POST",
        draft.payload,
      );
      if (record.draft === draft) clear(record);
      return result;
    } catch (error) {
      throw networkError(error);
    } finally {
      record.busy = false;
      controls.forEach(([n, disabled]) => (n.disabled = disabled));
    }
  }
  function reset() {
    if (pendingDialog) pendingDialog(false);
    for (const record of records.values()) clear(record);
    prune();
  }
  function reconcile() {
    prune();
    const current = contextOf(h.getProject());
    for (const record of records.values()) {
      if (
        record.draft &&
        !same(record.draft.context, current) &&
        !record.busy
      ) {
        clear(record);
        h.message(
          "Получатель изменился. Подготовленная загрузка отменена; выберите файл заново.",
          true,
        );
      }
      showRecipient(record);
    }
  }
  async function allowSwitch(nextId) {
    prune();
    const affected = [...records.values()].filter(
      (r) => r.draft && r.draft.context.projectId !== nextId,
    );
    if (!affected.length) return true;
    if (affected.some((r) => r.busy)) {
      h.message(
        "Дождитесь завершения загрузки или сообщения об ошибке. Проект назначения остаётся прежним.",
        true,
      );
      return false;
    }
    if (pendingDialog) return false;
    const dialog = document.getElementById("upload-switch-dialog");
    document.getElementById("upload-switch-message").textContent =
      `У вас выбран файл для проекта «${affected[0].draft.context.projectTitle}». При переходе в другой проект подготовленная загрузка будет отменена. Продолжить?`;
    const approved = await new Promise((resolve) => {
      const finish = (value) => {
        pendingDialog = null;
        dialog.close();
        resolve(value);
      };
      pendingDialog = finish;
      document.getElementById("upload-stay").onclick = () => finish(false);
      document.getElementById("upload-discard").onclick = () => finish(true);
      dialog.oncancel = (event) => {
        event.preventDefault();
        finish(false);
      };
      dialog.showModal();
    });
    if (!approved) return false;
    if (affected.some((r) => r.busy)) return false;
    affected.forEach(clear);
    h.message("Подготовленная загрузка отменена. Файл не отправлялся.");
    return true;
  }
  window.ITDUploads = {
    init: (hooks) => {
      h = hooks;
    },
    register,
    send,
    allowSwitch,
    reconcile,
    reset,
    contextOf,
  };
})();

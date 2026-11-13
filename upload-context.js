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
          clientLabel:
            project.clientId === null
              ? "Без клиента"
              : `${project.clientName} / ${project.clientEmail}`,
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
    renderCards(record);
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
  const MAX_FILES = 20;
  const fileSize = (size) =>
    size >= 1048576
      ? (size / 1048576).toFixed(1) + " МБ"
      : Math.max(0.1, size / 1024).toFixed(1) + " КБ";
  function renderCards(record) {
    const host = record.cards;
    if (!host) return;
    host.replaceChildren();
    const draft = record.draft;
    const documents = record.form.elements.category?.value === "document";
    const review = record.form.elements.review;
    if (review) {
      review.disabled = documents;
      review.closest("label").hidden = documents;
      record.form.querySelector(".review-upload-help").hidden = documents;
    }
    host.hidden = !draft;
    if (!draft) {
      if (record.statusLine) record.statusLine.textContent = "";
      return;
    }
    for (const [index, item] of draft.items.entries()) {
      const card = document.createElement("section");
      card.className = "upload-document-card";
      const heading = document.createElement("div");
      heading.className = "upload-document-head";
      const name = document.createElement("strong");
      name.textContent = item.file.name;
      const meta = document.createElement("span");
      meta.textContent = fileSize(item.file.size);
      const state = document.createElement("span");
      state.className = "upload-document-state";
      state.textContent = item.result ? "Загружен" : "Ожидает загрузки";
      item.status = state;
      heading.append(name, meta, state);
      card.append(heading);
      if (documents) {
        const fields = document.createElement("div");
        fields.className = "upload-document-fields";
        const field = (text, key, kind, values = []) => {
          const label = document.createElement("label");
          label.textContent = text;
          const control = document.createElement(kind);
          control.dataset.documentField = key;
          control.dataset.documentIndex = String(index);
          if (kind === "select") {
            for (const title of values) {
              const option = document.createElement("option");
              option.value = title;
              option.textContent = title;
              control.append(option);
            }
          } else {
            control.type = kind === "input" && key === "date" ? "date" : "text";
            control.maxLength = key === "title" ? 160 : 64;
          }
          control.value = item.metadata[key];
          control.disabled = !!item.result;
          control.addEventListener("input", () => {
            item.metadata[key] = control.value;
          });
          label.append(control);
          fields.append(label);
        };
        field("Название", "title", "input");
        field("Вид", "kind", "select", [
          "Документ",
          "Договор",
          "Акт",
          "Смета",
          "План",
          "Чертёж",
          "Проектная документация",
          "Счёт",
          "Другое",
        ]);
        field("Номер", "number", "input");
        field("Дата", "date", "input");
        const details = document.createElement("details");
        details.className = "upload-document-requisites";
        details.open = draft.items.length === 1;
        const summary = document.createElement("summary");
        summary.textContent = "Реквизиты документа";
        details.append(summary, fields);
        card.append(details);
      }
      host.append(card);
    }
    if (record.statusLine)
      record.statusLine.textContent = `Выбрано файлов: ${draft.items.length}. Максимум ${MAX_FILES} файлов за один раз, до 10 МБ каждый.`;
  }
  async function prepare(record, draft, item) {
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
          "Получатель проекта изменился. Выберите файлы заново после проверки клиента.",
        );
      item.ticket = result.uploadIntent;
      item.error = null;
    } catch (error) {
      if (record.draft === draft) {
        item.error = networkError(error);
        h.message(item.error.message, true);
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
      cards: form.querySelector("#upload-file-cards"),
      statusLine: form.querySelector("#upload-batch-status"),
      draft: null,
      busy: false,
    };
    records.set(form, record);
    record.input.addEventListener("change", () => {
      const files = [...record.input.files],
        current = context();
      record.draft = null;
      if (files.length > MAX_FILES) {
        record.input.value = "";
        h.message(
          `За один раз можно выбрать не более ${MAX_FILES} файлов.`,
          true,
        );
      } else if (files.length && current && h.getUser()?.role === "admin") {
        const draft = {
          context: { ...current },
          user: h.getUser(),
          items: files.map((file) => ({
            file,
            metadata: {
              title: file.name.replace(/\.[^.]+$/, "").slice(0, 160),
              kind: "Документ",
              number: "",
              date: "",
            },
          })),
        };
        record.draft = draft;
        // Preserve the existing early intent preparation for the first file.
        draft.items[0].ready = prepare(record, draft, draft.items[0]);
      }
      renderCards(record);
      showRecipient(record);
    });
    form.elements.category?.addEventListener("change", () =>
      renderCards(record),
    );
    renderCards(record);
    showRecipient(record);
  }
  function check(record, draft) {
    if (
      !record.form.isConnected ||
      record.draft !== draft ||
      draft.user !== h.getUser() ||
      !same(draft.context, contextOf(h.getProject())) ||
      !same(draft.context, record.context()) ||
      record.input.files.length !== draft.items.length ||
      draft.items.some((item, index) => record.input.files[index] !== item.file)
    )
      throw new Error(
        "Проект загрузки изменился. Отправка заблокирована. Выберите файлы заново в нужном проекте.",
      );
  }
  async function send(form, extra) {
    const record = records.get(form),
      draft = record?.draft;
    if (!draft) throw new Error("Выберите файлы для текущего проекта.");
    if (record.busy) return null;
    check(record, draft);
    record.busy = true;
    const controls = [
      ...form.querySelectorAll("button,input,select,textarea"),
    ].map((n) => [n, n.disabled]);
    controls.forEach(([n]) => (n.disabled = true));
    try {
      const parameters = JSON.stringify(extra);
      if (draft.parameters && draft.parameters !== parameters)
        throw new Error(
          "Параметры загрузки изменились. Верните прежние или выберите файлы заново.",
        );
      draft.parameters = parameters;
      for (const [index, item] of draft.items.entries()) {
        if (item.result) continue;
        check(record, draft);
        if (!item.ready) item.ready = prepare(record, draft, item);
        await item.ready;
        check(record, draft);
        if (!item.ticket) {
          item.ready = prepare(record, draft, item);
          await item.ready;
          check(record, draft);
          if (!item.ticket)
            throw item.error || new Error("Не удалось подготовить загрузку.");
        }
        if (item.status) item.status.textContent = "Подготовка…";
        const document =
          extra.category === "document"
            ? { document: { ...item.metadata } }
            : {};
        const itemParameters = JSON.stringify({ ...extra, ...document });
        if (!item.payload) {
          const encoded = await h.encodeFile(item.file);
          check(record, draft);
          item.parameters = itemParameters;
          item.payload = {
            ...encoded,
            ...extra,
            ...document,
            uploadIntent: item.ticket,
          };
        }
        if (item.parameters !== itemParameters)
          throw new Error(
            "Реквизиты подготовленной загрузки изменились. Верните прежние данные для повтора или выберите файлы заново.",
          );
        if (record.statusLine)
          record.statusLine.textContent = `Загрузка файла ${index + 1} из ${draft.items.length}: ${item.file.name}`;
        if (item.status) item.status.textContent = "Загружается…";
        item.result = await h.api(
          `/api/projects/${draft.context.projectId}/files`,
          "POST",
          item.payload,
        );
        if (item.status) item.status.textContent = "Загружен";
      }
      const results = draft.items.map((item) => item.result);
      if (record.draft === draft) clear(record);
      return results.length === 1
        ? results[0]
        : {
            files: results,
            count: results.length,
          };
    } catch (error) {
      const saved = draft.items.filter((item) => item.result).length;
      if (record.statusLine)
        record.statusLine.textContent = saved
          ? `Загружено ${saved} из ${draft.items.length}. Повторная отправка продолжит оставшиеся файлы.`
          : "Отправка не завершена. Вы можете повторить её с теми же файлами.";
      const cause = networkError(error);
      const failed = draft.items.find((item) => !item.result);
      if (failed?.status)
        failed.status.textContent = `Ошибка: ${cause.message}`;
      if (saved)
        throw new Error(
          `Загружено ${saved} из ${draft.items.length}. ${cause.message}`,
        );
      throw cause;
    } finally {
      record.busy = false;
      controls.forEach(
        ([n, disabled]) =>
          (n.disabled =
            disabled ||
            (n.dataset.documentIndex !== undefined &&
              !!draft.items[Number(n.dataset.documentIndex)]?.result)),
      );
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
    h.message(
      "Оставшаяся загрузка отменена. Уже загруженные документы сохраняются.",
    );
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

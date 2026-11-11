# Общие компоненты

Исследовано по коду 99b7555fad5a5c9996391ca85e6f3ba0486c75e8, ветка feature/itd-superdesign-redesign. Это контекст существующей реализации, не утверждённый новый дизайн. Реальные данные и сервер не исследовались.

Стек: Node.js 24, SQLite, статический HTML, vanilla JavaScript (IIFE + window.ITD*), обычный CSS. React/Vue/Tailwind и сторонней UI-библиотеки нет. Большинство примитивов создаются локальными DOM-функциями, а не импортируемыми компонентами. Ниже приведены полные функции; их замыкания зависят от состояния модуля, это не автономные экспортируемые компоненты.

## DOM node
Источник: `cabinet.js`.
```js
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
```

## Button, Input, FormAction
Источник: `admin-management.js`.
```js
  function button(text, action, className = "text-button") {
    const el = node("button", text, className);
    el.type = "button";
    el.addEventListener("click", async () => {
      const generation = epoch;
      try {
        await action();
      } catch (error) {
        if (valid(generation))
          notice(active === "clients" ? "clients" : "projects", error.message);
      }
    });
    return el;
  }
  function input(form, label, name, value, type = "text") {
    const id = "admin-" + name + "-" + Math.random().toString(36).slice(2),
      caption = node("label", label),
      field = node("input");
    caption.htmlFor = id;
    field.id = id;
    field.name = name;
    field.type = type;
    field.value = value || "";
    field.required = true;
    field.maxLength = name === "name" ? 120 : 200;
    form.append(caption, field);
    return field;
  }
  function formAction(form, kind, action) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const generation = epoch;
      const values = Object.fromEntries(new FormData(form));
      const controls = [...form.querySelectorAll("input,select,textarea,button")];
      controls.forEach((el) => (el.disabled = true));
      try {
        await action(values);
      } catch (error) {
        if (valid(generation)) notice(kind, error.message);
      } finally {
        controls.forEach((el) => (el.disabled = false));
      }
    });
  }
```

## Download, FileRow, DeleteFileButton
Источник: `cabinet.js`.
```js
  function download(file, label = "Скачать") {
    const link = node("a", label, "file-download");
    link.href = `/api/files/${encodeURIComponent(file.id)}/download`;
    link.download = file.name;
    link.setAttribute("aria-label", `${label}: ${file.name}`);
    return link;
  }
  function fileRow(file, project, admin = false) {
    const item = node("div", undefined, "file-item");
    const ext = file.name.split(".").pop().toUpperCase();
    const icon = node("span", ext.length <= 5 ? ext : "FILE", "file-icon");
    icon.setAttribute("aria-hidden", "true");
    const info = node("div", undefined, "file-info");
    const stage = project.stages.find((s) => s.id === file.stageId);
    const size =
      file.size >= 1024 * 1024
        ? `${(file.size / (1024 * 1024)).toFixed(1)} МБ`
        : `${(file.size / 1024).toFixed(1)} КБ`;
    info.append(
      node("span", file.name, "file-name"),
      node(
        "span",
        `${size}${stage ? ` · ${stage.title}` : " · Без привязки к этапу"}`,
        "file-meta",
      ),
    );
    item.append(icon, info);
    if (window.ITDViewer?.supported(file))
      item.append(window.ITDViewer.control(file, project.files));
    item.append(download(file));
    if (file.review) item.append(window.ITDReview.reviewControl(file));
    if (admin)
      item.append(
        deleteFileButton(file, item),
        window.ITDReview.sendControl(file),
      );
    return item;
  }
  function deleteFileButton(file, container) {
    if (file.review) return document.createDocumentFragment();
    const button = node("button", "Удалить", "file-delete");
    button.type = "button";
    button.setAttribute("aria-label", `Удалить файл ${file.name}`);
    button.addEventListener("click", () => {
      if (window.confirm(`Удалить файл «${file.name}»?`))
        busy(container, async () => {
          await api(`/api/files/${file.id}`, "DELETE", {});
          await refresh();
          message("Файл удалён");
        });
    });
    return button;
  }
```

## Review buttons and controls
Источник: `material-review.js`.
```js
  function button(text, callback, cls = "text-button") {
    const n = el("button", text, cls);
    n.type = "button";
    n.addEventListener("click", async () => {
      const generation = epoch;
      try {
        await callback();
      } catch (error) {
        if (valid(generation)) notice(error.message);
      }
    });
    return n;
  }
```

Общий просмотрщик: масштаб/страницы/переходы/превью, API `window.ITDViewer`; полный модуль ниже. Его интерфейс нельзя отделять от разрешений на `/api/files/:id/preview`.

## file-viewer.js

```js
"use strict";
(() => {
  const el = (tag, text, className) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (className) n.className = className;
    return n;
  };
  const image = (f) =>
    ["image/jpeg", "image/png", "image/webp"].includes(f?.contentType);
  const supported = (f) => image(f) || f?.contentType === "application/pdf";
  const dialog = el("dialog", undefined, "file-viewer");
  dialog.setAttribute("aria-label", "Просмотр материала");
  const toolbar = el("div", undefined, "viewer-toolbar"),
    title = el("h2"),
    status = el("p", undefined, "viewer-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const button = (label, action) => {
    const b = el("button", label);
    b.type = "button";
    b.addEventListener("click", action);
    return b;
  };
  const viewport = el("div", undefined, "viewer-viewport"),
    content = el("div", undefined, "viewer-content");
  viewport.append(content);
  // Image zoom belongs to this viewing session, not to the stored file.
  const imageZoom = new Map();
  let epoch = 0,
    generation = 0,
    controllers = new Set(),
    urls = new Set(),
    thumbs = new Set(),
    controller,
    task,
    pdf,
    renderTask,
    current,
    collection = [],
    index = 0,
    zoom = 1,
    page = 1,
    pages = 1,
    source,
    opener,
    viewerUrl;
  let renderedCallback = null, reportedOpen = false;
  function reportRendered() {
    if (!dialog.open || !current || reportedOpen) return;
    reportedOpen = true;
    renderedCallback?.(current);
  }
  const abort = () => {
    clearTimeout(resizeTimer);
    generation++;
    controller?.abort();
    controller = null;
    renderTask?.cancel();
    renderTask = null;
    task?.destroy().catch(() => {});
    task = null;
    pdf = null;
    source = null;
    content.replaceChildren();
    if (viewerUrl) {
      URL.revokeObjectURL(viewerUrl);
      urls.delete(viewerUrl);
      viewerUrl = null;
    }
  };
  const close = () => {
    imageZoom.clear();
    abort();
    if (dialog.open) dialog.close();
    if (opener?.isConnected)
      opener.focus(image(current) ? { preventScroll: true } : undefined);
    opener = null;
  };
  const prev = button("← Предыдущий", () => navigate(-1)),
    next = button("Следующий →", () => navigate(1));
  const minus = button("Уменьшить", () => setZoom(zoom - 0.25)),
    reset = button("Сбросить масштаб", () => setZoom(1)),
    plus = button("Увеличить", () => setZoom(zoom + 0.25));
  const download = el("a", "Скачать оригинал");
  download.className = "viewer-download";
  toolbar.append(title, button("Закрыть", close));
  const controls = el("div", undefined, "viewer-controls");
  controls.append(prev, next, minus, reset, plus, download);
  dialog.append(toolbar, controls, status, viewport);
  document.body.append(dialog);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("close", () => {
    if (!dialog.open) {
      imageZoom.clear();
      abort();
    }
  });
  let touch;
  viewport.addEventListener(
    "touchstart",
    (e) => {
      touch =
        e.touches.length === 1
          ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
          : null;
    },
    { passive: true },
  );
  viewport.addEventListener(
    "touchend",
    (e) => {
      if (touch && zoom === 1 && image(current)) {
        const dx = e.changedTouches[0].clientX - touch.x,
          dy = e.changedTouches[0].clientY - touch.y;
        if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5)
          navigate(dx < 0 ? 1 : -1);
      }
      touch = null;
    },
    { passive: true },
  );
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "ArrowRight" && zoom === 1) {
      e.preventDefault();
      navigate(1);
    }
    if (e.key === "ArrowLeft" && zoom === 1) {
      e.preventDefault();
      navigate(-1);
    }
  });
  function update() {
    prev.disabled =
      current?.contentType === "application/pdf" ? page <= 1 : index <= 0;
    next.disabled =
      current?.contentType === "application/pdf"
        ? page >= pages
        : index >= collection.length - 1;
    minus.disabled = zoom <= 0.5;
    plus.disabled = zoom >= 3;
    reset.textContent = `Сбросить масштаб (${Math.round(zoom * 100)}%)`;
  }
  function showError(e) {
    if (e.name === "AbortError" || e.name === "RenderingCancelledException")
      return;
    status.textContent =
      e.message || "Не удалось открыть материал. Скачайте оригинал.";
  }
  async function renderPdf() {
    const token = ++generation;
    status.textContent = "Подготовка страницы…";
    renderTask?.cancel();
    try {
      const p = await pdf.getPage(page);
      if (token !== generation || !dialog.open) return;
      const base = p.getViewport({ scale: 1 }),
        width = Math.max(240, viewport.clientWidth - 32),
        scale = Math.min(width / base.width, 1.5) * zoom;
      let view = p.getViewport({ scale });
      if (view.width * view.height > 16000000) {
        view = p.getViewport({
          scale: scale * Math.sqrt(16000000 / (view.width * view.height)),
        });
      }
      const canvas = el("canvas");
      canvas.setAttribute(
        "aria-label",
        `${current.name}, страница ${page} из ${pages}`,
      );
      canvas.width = Math.ceil(view.width);
      canvas.height = Math.ceil(view.height);
      content.replaceChildren(canvas);
      renderTask = p.render({
        canvasContext: canvas.getContext("2d"),
        viewport: view,
      });
      await renderTask.promise;
      if (token !== generation || !dialog.open) return;
      reportRendered();
      status.textContent = `Страница ${page} из ${pages}`;
      update();
    } catch (e) {
      if (token === generation) showError(e);
    }
  }
  function setZoom(value) {
    zoom = Math.min(3, Math.max(0.5, value));
    if (image(current)) imageZoom.set(current.id, zoom);
    if (pdf) renderPdf();
    else if (source) {
      const style = getComputedStyle(viewport);
      const width = Math.max(
        1,
        viewport.clientWidth -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight),
      );
      const height = Math.max(
        1,
        viewport.clientHeight -
          parseFloat(style.paddingTop) -
          parseFloat(style.paddingBottom),
      );
      const fit = Math.min(
        width / source.naturalWidth,
        height / source.naturalHeight,
        1,
      );
      source.width = Math.max(1, Math.floor(source.naturalWidth * fit * zoom));
    }
    update();
  }
  function navigate(delta) {
    if (pdf) {
      page = Math.max(1, Math.min(pages, page + delta));
      renderPdf();
    } else if (collection[index + delta]) load(collection[index + delta]);
  }
  async function load(file) {
    abort();
    current = file;
    reportedOpen = false;
    dialog.classList.toggle("is-image-viewer", image(file));
    index = collection.findIndex((f) => f.id === file.id);
    zoom = image(file) ? (imageZoom.get(file.id) ?? 1) : 1;
    page = 1;
    pages = 1;
    const token = generation;
    controller = new AbortController();
    title.textContent = file.name;
    title.title = image(file) ? file.name : "";
    if (image(file)) viewport.scrollTo(0, 0);
    status.textContent = "Загрузка материала…";
    download.href = `/api/files/${file.id}/download`;
    download.download = file.name;
    update();
    try {
      const response = await fetch(`/api/files/${file.id}/preview`, {
        credentials: "same-origin",
        signal: controller.signal,
        cache: "no-store",
      });
      if (token !== generation || !dialog.open) return;
      if (response.status === 401) {
        window.dispatchEvent(new Event("itd-preview-session-expired"));
        throw new Error("Войдите в кабинет повторно");
      }
      if (!response.ok)
        throw new Error("Не удалось открыть материал. Скачайте оригинал.");
      const bytes = await response.arrayBuffer();
      if (token !== generation || !dialog.open) return;
      if (image(file)) {
        const url = URL.createObjectURL(
          new Blob([bytes], { type: file.contentType }),
        );
        urls.add(url);
        viewerUrl = url;
        const img = el("img");
        img.alt = file.name;
        img.hidden = true;
        img.onload = () => {
          if (token !== generation || !dialog.open || current !== file) return;
          source = img;
          setZoom(zoom);
          img.hidden = false;
          reportRendered();
          status.textContent = `Изображение ${index + 1} из ${collection.length}`;
        };
        img.onerror = () => {
          if (token === generation)
            status.textContent =
              "Изображение повреждено или не поддерживается. Скачайте оригинал.";
        };
        img.src = url;
        content.append(img);
      } else {
        const lib = await import("/vendor/pdfjs/pdf.mjs");
        if (token !== generation || !dialog.open) return;
        lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
        const loadingTask = lib.getDocument({
          data: new Uint8Array(bytes),
          isEvalSupported: false,
          cMapUrl: "/vendor/pdfjs/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
          wasmUrl: "/vendor/pdfjs/wasm/",
          iccUrl: "/vendor/pdfjs/iccs/",
          enableXfa: false,
        });
        task = loadingTask;
        const document = await loadingTask.promise;
        if (token !== generation || !dialog.open) {
          await loadingTask.destroy();
          return;
        }
        pdf = document;
        pages = pdf.numPages;
        await renderPdf();
      }
    } catch (e) {
      if (token === generation) showError(e);
    }
  }
  function open(file, files, trigger) {
    if (!dialog.open) imageZoom.clear();
    opener = trigger;
    collection = image(file) ? files.filter(image) : [file];
    if (!dialog.open) dialog.showModal();
    load(file);
  }
  function control(file, files, label = "Открыть") {
    const b = button(label, () => open(file, files, b));
    b.className = "file-preview";
    b.setAttribute("aria-label", `Открыть материал: ${file.name}`);
    return b;
  }
  const pendingThumbs = new Map();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          const start = pendingThumbs.get(entry.target);
          pendingThumbs.delete(entry.target);
          start?.();
        }
      }
    },
    { rootMargin: "120px" },
  );
  function thumbnail(file, files) {
    const card = el("div", undefined, "gallery-card"),
      b = control(file, files, "");
    b.className = "gallery-open";
    const img = el("img");
    img.alt = file.name;
    img.onerror = () => {
      img.remove();
      b.prepend(el("span", "Изображение недоступно", "thumbnail-error"));
    };
    const caption = el("span", file.name, "gallery-caption");
    caption.title = file.name;
    b.append(img, caption);
    card.append(b);
    const stamp = epoch;
    thumbs.add(img);
    pendingThumbs.set(card, () => {
      if (stamp !== epoch) return;
      const c = new AbortController();
      controllers.add(c);
      fetch(`/api/files/${file.id}/preview`, {
        credentials: "same-origin",
        signal: c.signal,
        cache: "no-store",
      })
        .then(async (r) => {
          if (stamp !== epoch) throw new DOMException("Aborted", "AbortError");
          if (r.status === 401)
            window.dispatchEvent(new Event("itd-preview-session-expired"));
          if (!r.ok) throw Error();
          return r.blob();
        })
        .then((blob) => {
          if (stamp !== epoch) return;
          const url = URL.createObjectURL(blob);
          urls.add(url);
          img.src = url;
        })
        .catch((e) => {
          if (e.name !== "AbortError" && stamp === epoch) {
            img.remove();
            b.prepend(el("span", "Изображение недоступно", "thumbnail-error"));
          }
        })
        .finally(() => controllers.delete(c));
    });
    observer.observe(card);
    return card;
  }
  let resizeTimer;
  const resizeObserver = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    if (dialog.open)
      resizeTimer = setTimeout(() => {
        if (dialog.open && (pdf || source)) setZoom(zoom);
      }, 150);
  });
  resizeObserver.observe(viewport);

  function invalidate() {
    epoch++;
    observer.disconnect();
    pendingThumbs.clear();
    clearTimeout(resizeTimer);
    close();
    controllers.forEach((c) => c.abort());
    controllers.clear();
    thumbs.forEach((img) => img.removeAttribute("src"));
    thumbs.clear();
    urls.forEach((url) => URL.revokeObjectURL(url));
    urls.clear();
    title.textContent = "";
    status.textContent = "";
    download.removeAttribute("href");
    current = null;
    collection = [];
  }
  window.ITDViewer = { supported, image, control, thumbnail, invalidate, onRendered: callback => {renderedCallback = callback;} };
})();

```

Общий безопасный загрузчик: файл привязан к проекту и клиенту до отправки; используется обычной загрузкой и загрузкой версии. Это функциональная часть общего Upload-компонента.

## upload-context.js

```js
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

```


"use strict";
(() => {
  const el = (t, text, cls) => {
    const n = document.createElement(t);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const labels = {
    pending_approval: "Ожидает решения",
    approved: "Согласовано",
    changes_requested: "На доработку",
    open: "Открыто",
    fixed: "Исправлено дизайнером",
    confirmed: "Подтверждено клиентом",
    reopened: "Повторная доработка",
  };
  const date = (n) => new Date(n).toLocaleString("ru-RU");
  let hooks,
    project,
    scope = 0,
    data,
    root,
    listHost,
    viewHost,
    rail,
    notice,
    saveStatus,
    footer,
    stagePicker,
    summaryHost,
    packageButton,
    bulk,
    bulkToggle,
    queueProgress,
    queueCount,
    selectionMode = false,
    busy = false,
    advanceAfterSave = null,
    pinRequest = null,
    filter = "all",
    query = "",
    selected = new Set(),
    mid,
    vid,
    viewer,
    comparison,
    epoch = 0,
    openSeq = 0,
    saveTimer,
    dirty = 0,
    saved = 0,
    saveChain = Promise.resolve(),
    saveError = null,
    operation = null,
    active = false,
    pendingOpen = null,
    localKey = null,
    returnToLibrary = null;
  const historyByMaterial = new Map();
  const admin = () => hooks?.getUser()?.role === "admin";
  function newOperationId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    // Local Wi-Fi previews have getRandomValues even on an HTTP origin.
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  }
  const route = (stage = scope) =>
    `/api/approval-center/projects/${project.id}/stages/${stage}`;
  const displayTitle = (m) =>
    window.ITDUI.materialLabel({
      title: m.title,
      file: { ...m.currentVersion.file, review: { materialId: m.id } },
      stage: project?.stages.find((s) => s.id === m.stageId),
    });
  const current = () => data?.materials.find((m) => m.id === mid);
  const version = () =>
    current()?.versions.find((v) => v.id === vid) || current()?.currentVersion;
  const say = (s) => {
    if (notice) notice.textContent = s;
  };
  function button(label, action, cls = "") {
    const b = el("button", label, cls);
    b.type = "button";
    b.addEventListener("click", async () => {
      try {
        await action();
      } catch (e) {
        say(e.message);
        const dialog = b.closest("dialog");
        if (dialog) {
          let msg = dialog.querySelector(".ac-dialog-error");
          if (!msg) {
            msg = el("p", undefined, "ac-dialog-error");
            msg.setAttribute("role", "alert");
            dialog.append(msg);
          }
          msg.textContent = e.message;
        }
      }
    });
    return b;
  }
  function input(label, type = "text", value = "") {
    const wrap = el("label", label),
      field = el(type === "textarea" ? "textarea" : "input");
    if (type !== "textarea") field.type = type;
    field.value = value;
    field.setAttribute("aria-label", label);
    wrap.append(field);
    return { wrap, field };
  }
  function select(label, items, value, onChange) {
    const l = el("label", label),
      s = el("select");
    s.setAttribute("aria-label", label);
    for (const [v, t] of items) {
      const o = el("option", t);
      o.value = v;
      s.append(o);
    }
    s.value = value;
    s.addEventListener("change", () => onChange(s.value));
    l.append(s);
    return l;
  }
  function modal(title, build) {
    const d = el("dialog", undefined, "ac-dialog"),
      top = el("div", undefined, "ac-dialog-top");
    top.append(
      el("h2", title),
      button("Закрыть", () => d.close()),
    );
    d.append(top);
    build(d);
    document.body.append(d);
    const opener = document.activeElement;
    d.addEventListener("close", () => {
      d.remove();
      opener?.focus();
    });
    d.showModal();
    return d;
  }
  function entry(create = false) {
    let e = data?.draft.entries.find((e) => e.materialId === mid);
    const v = version();
    if (!e && create && v) {
      e = {
        materialId: mid,
        versionId: v.id,
        expectedRevision: v.revision,
        decision: null,
        comment: "",
        markers: [],
      };
      data.draft.entries.push(e);
    }
    return e;
  }
  function change() {
    dirty++;
    try {
      localStorage.setItem(
        localKey,
        JSON.stringify({
          revision: data.draft.revision,
          entries: data.draft.entries,
          position: data.draft.position,
        }),
      );
    } catch {}
    saveStatus.textContent = "Сохраняем";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flush().catch((e) => say(e.message)), 500);
    updateFooter();
  }
  function flush() {
    clearTimeout(saveTimer);
    if (admin() || !data || dirty === saved) return saveChain;
    const generation = epoch;
    saveChain = saveChain
      .catch(() => {})
      .then(async () => {
        if (generation !== epoch || dirty === saved) return;
        const seq = dirty,
          payload = {
            expectedRevision: data.draft.revision,
            entries: structuredClone(data.draft.entries),
            position: structuredClone(data.draft.position),
          };
        try {
          const result = await hooks.api(route() + "/draft", "PUT", payload);
          if (generation !== epoch) return;
          data.draft.revision = result.revision;
          saved = seq;
          saveError = null;
          if (dirty === seq) {
            try {
              localStorage.removeItem(localKey);
            } catch {}
          }
          saveStatus.textContent = dirty === saved ? "Сохранено" : "Сохраняем";
          updateFooter();
        } catch (e) {
          if (generation !== epoch) return;
          saveError = e;
          saveStatus.textContent = "Не удалось сохранить";
          updateFooter();
          throw e;
        }
      });
    return saveChain;
  }
  function recoverDraft() {
    modal("Восстановление черновика", (d) => {
      let backup;
      try {
        backup = localStorage.getItem(localKey + ":recovery");
      } catch {}
      const text = backup || JSON.stringify(data.draft, null, 2);
      const box = el("textarea");
      box.value = text;
      box.readOnly = true;
      box.setAttribute("aria-label", "Сохранённый черновик для копирования");
      d.append(
        el(
          "p",
          "Скопируйте локальные изменения перед загрузкой серверного черновика. При конфликте версия сервера не перезаписывается автоматически.",
        ),
        box,
        button("Загрузить серверный черновик", async () => {
          if (
            !window.confirm(
              "Локальные несохранённые изменения заменятся серверным черновиком. Вы сохранили нужный текст?",
            )
          )
            return;
          try {
            localStorage.removeItem(localKey);
            localStorage.removeItem(localKey + ":recovery");
          } catch {}
          dirty = saved;
          saveError = null;
          d.close();
          await loadScope(scope);
        }),
      );
      for (const e of data.draft.entries.filter(
        (e) => !data.materials.some((m) => m.id === e.materialId),
      ))
        d.append(
          button(
            `Убрать черновик перемещённого материала №${e.materialId}`,
            () => {
              data.draft.entries = data.draft.entries.filter((x) => x !== e);
              change();
              d.close();
            },
          ),
        );
    });
  }
  function stopPreview() {
    viewer?.dispose();
    comparison?.dispose();
    viewer = comparison = null;
  }
  function reset() {
    historyByMaterial.clear();
    window.ITDApprovalThumbnails?.clear(root || document.createElement("div"));
    window.ITDApprovalViewer.clearPrefetch();
    epoch++;
    openSeq++;
    clearTimeout(saveTimer);
    stopPreview();
    window.ITDViewer.releaseWithin(root || document.createElement("div"));
    document.getElementById("app-view").inert = false;
    root?.remove();
    root = null;
    project = null;
    busy = selectionMode = false;
    advanceAfterSave = pinRequest = null;
    filter = "all";
    query = "";
    data = null;
    active = false;
    pendingOpen = null;
    returnToLibrary = null;
    dirty = saved = 0;
    selected.clear();
    saveChain = Promise.resolve();
    saveError = null;
    operation = null;
  }
  function setProject(p) {
    if (project?.id !== p?.id) {
      reset();
      project = p;
    } else project = p;
  }
  function iconButton(label, glyph, action) {
    const b = button(glyph, action, "ac-icon");
    b.title = label;
    b.setAttribute("aria-label", label);
    return b;
  }
  function panel(name) {
    root.dataset.mobile = name;
    root.querySelector(".ac-menu")?.removeAttribute("open");
    if (name === "notes")
      rail.querySelector("button")?.focus({ preventScroll: true });
    if (name === "list")
      listHost
        .querySelector(".is-selected button")
        ?.focus({ preventScroll: true });
  }
  async function leave() {
    await flush();
    if (returnToLibrary) {
      const back = returnToLibrary;
      returnToLibrary = null;
      back();
    } else hooks.selectTab("overview");
  }
  function build() {
    if (root) return;
    root = el("section", undefined, "approval-center");
    root.id = "approval-center";
    root.setAttribute("aria-label", "Центр согласования");
    const parent = document.getElementById("panel-review");
    parent.classList.add("ac-enabled");
    document.body.append(root);
    document.getElementById("app-view").inert = true;
    const head = el("header", undefined, "ac-head"),
      brand = button("", leave, "ac-brand"),
      logo = el("img"),
      intro = el("div", undefined, "ac-intro"),
      context = el("div", undefined, "ac-head-tools");
    logo.src = "/assets/brand/itd-logo.svg";
    logo.alt = "ITD Studio";
    brand.setAttribute("aria-label", "Личный кабинет");
    brand.append(logo, el("span", "Личный кабинет"));
    stagePicker = select(
      "Этап",
      [[0, "Без этапа"], ...project.stages.map((s) => [s.id, s.title])],
      scope,
      async (s) => {
        try {
          await flush();
          await loadScope(+s);
        } catch (e) {
          say(e.message);
          stagePicker.querySelector("select").value = scope;
        }
      },
    );
    stagePicker.className = "ac-stage";
    stagePicker.append(el("span", "", "ac-stage-name"));
    context.append(el("span", project.title), el("span", "·"), stagePicker);
    intro.append(el("h2", "Центр согласования"), context);
    packageButton = button(
      admin() ? "Ведомости" : "К отправке",
      admin() ? showPackages : submit,
      "ac-package",
    );
    packageButton.disabled = true;
    head.append(brand, intro, packageButton);
    notice = el("p", "", "ac-notice");
    notice.setAttribute("role", "status");
    saveStatus = el("strong", admin() ? "Режим студии" : "Сохранено");
    saveStatus.setAttribute("role", "status");
    const work = el("div", undefined, "ac-work"),
      left = el("aside", undefined, "ac-list-pane"),
      top = el("div", undefined, "ac-list-top"),
      title = el("h3", "Материалы");
    queueCount = el("span");
    title.append(queueCount);
    top.append(
      title,
      iconButton("Закрыть очередь", "×", () => panel("viewer")),
    );
    summaryHost = el("span");
    queueProgress = el("progress");
    const search = input("Найти материал", "search");
    search.field.placeholder = "Найти материал";
    search.wrap.className = "ac-search";
    search.field.oninput = () => {
      query = search.field.value.trim().toLocaleLowerCase("ru-RU");
      renderList();
    };
    const filters = el("div", undefined, "ac-filters");
    filters.append(
      select(
        "Показывать",
        [
          ["all", "Все материалы"],
          ["pending_approval", "Ожидают решения"],
          ["draft", "К отправке"],
          ["approved", "Согласованы"],
          ["changes_requested", "На доработке"],
          ["new", "Проверить исправления"],
          ["notes", "С замечаниями"],
          ["fixed", "Исправлено дизайнером"],
          ["open", "Открытые замечания"],
        ],
        filter,
        (value) => {
          filter = value;
          renderList();
        },
      ),
    );
    bulk = el("div", undefined, "ac-bulk");
    bulkToggle = button("Выбрать", () => {
      selectionMode = !selectionMode;
      selected.clear();
      renderList();
    });
    if (!admin()) {
      filters.append(bulkToggle);
      bulk.append(
        button("Выбрать показанные", () => {
          visible().forEach((m) => selected.add(m.id));
          renderList();
        }),
        button("Снять выбор", () => {
          selected.clear();
          renderList();
        }),
        button("Согласовать выбранные", bulkApprove),
      );
    }
    listHost = el("div", undefined, "ac-list");
    left.append(
      top,
      summaryHost,
      queueProgress,
      search.wrap,
      filters,
      bulk,
      listHost,
    );
    viewHost = el("section", undefined, "ac-view-pane");
    let touch;
    viewHost.addEventListener(
      "touchstart",
      (event) => {
        touch =
          event.touches.length === 1 &&
          !pinRequest &&
          event.target.closest(".ac-viewport")
            ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
            : null;
      },
      { passive: true },
    );
    viewHost.addEventListener(
      "touchend",
      (event) => {
        if (
          touch &&
          !event.touches.length &&
          viewer?.zoom === 1 &&
          !comparison &&
          !pinRequest
        ) {
          const dx = event.changedTouches[0].clientX - touch.x,
            dy = event.changedTouches[0].clientY - touch.y;
          if (Math.abs(dx) > 80 && Math.abs(dx) > 2 * Math.abs(dy))
            navigate(dx < 0 ? 1 : -1);
        }
        touch = null;
      },
      { passive: true },
    );
    viewHost.addEventListener(
      "touchcancel",
      () => {
        touch = null;
      },
      { passive: true },
    );
    rail = el("aside", undefined, "ac-rail");
    rail.setAttribute("aria-label", "Замечания и история");
    footer = el("footer", undefined, "ac-footer");
    work.append(left, viewHost, rail, footer);
    root.append(head, notice, work);
    root.dataset.mobile = "viewer";
    root.addEventListener("click", (event) => {
      if (
        !event.target.closest(".ac-menu") ||
        event.target.closest(".ac-menu button,.ac-menu a")
      )
        root.querySelector(".ac-menu")?.removeAttribute("open");
    });
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (root.querySelector(".ac-menu[open]"))
          root.querySelector(".ac-menu").open = false;
        else if (pinRequest) cancelPin();
        else panel("viewer");
        return;
      }
      if (
        e.target.closest("input,textarea,select,dialog,button,summary") ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey
      )
        return;
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        navigate(e.key === "ArrowRight" ? 1 : -1);
      }
    });
  }
  async function loadScope(s, target) {
    const pid = project.id,
      generation = ++epoch;
    build();
    const work = root.querySelector(".ac-work");
    work.inert = true;
    packageButton.disabled = true;
    let result;
    try {
      result = await hooks.api(route(s));
    } catch (error) {
      if (generation === epoch) {
        stagePicker.querySelector("select").value = scope;
        if (data) await showMaterial(mid, vid);
        else
          viewHost.replaceChildren(
            button("Повторить загрузку", () => loadScope(s, target)),
          );
        say(error.message);
      }
      return;
    } finally {
      if (generation === epoch) {
        work.inert = false;
        packageButton.disabled = !data;
      }
    }
    if (generation !== epoch || project?.id !== pid || !active) return;
    scope = s;
    dirty = saved = 0;
    saveError = null;
    operation = null;
    selected.clear();
    selectionMode = busy = false;
    advanceAfterSave = pinRequest = null;
    stopPreview();
    stagePicker.querySelector("select").value = scope;
    stagePicker.querySelector(".ac-stage-name").textContent =
      stagePicker.querySelector("select").selectedOptions[0]?.textContent;
    saveStatus.textContent = admin() ? "Режим студии" : "Загрузка черновика…";
    data = result;
    packageButton.disabled = false;
    localKey = `itd.approval.draft:${hooks.getUser().id}:${pid}:${scope}`;
    try {
      const local = JSON.parse(localStorage.getItem(localKey) || "null");
      if (local && !admin()) {
        if (local.revision === data.draft.revision) {
          data.draft.entries = local.entries;
          data.draft.position = local.position;
          change();
        } else if (
          JSON.stringify(local.entries) !== JSON.stringify(data.draft.entries)
        ) {
          localStorage.setItem(localKey + ":recovery", JSON.stringify(local));
        }
      }
    } catch {}
    data.materials.forEach((m) => {
      m.currentVersion = m.versions.find((v) => v.id === m.currentVersion.id);
    });
    mid =
      target?.mid || data.draft.position.materialId || data.materials[0]?.id;
    vid = target?.vid || data.draft.position.versionId;
    if (!data.materials.some((m) => m.id === mid)) {
      mid = data.materials[0]?.id;
      vid = null;
    }
    saveStatus.textContent = admin()
      ? "Режим студии"
      : dirty === saved
        ? "Сохранено"
        : "Сохраняем";
    renderList();
    await showMaterial(mid, vid);
    if (generation !== epoch) return;
    if (result.conflicts.length)
      say(
        "Есть черновики по изменённым версиям. Откройте замечания и проверьте новую версию.",
      );
    updateFooter();
  }
  const visible = () =>
    !data
      ? []
      : data.materials.filter((m) => {
          const d = data.draft.entries.find((e) => e.materialId === m.id),
            v = m.currentVersion;
          return (
            (!query ||
              [m.title, m.room, ...m.versions.map((v) => v.file.name)]
                .join(" ")
                .toLocaleLowerCase("ru-RU")
                .includes(query)) &&
            (filter === "all" ||
              (filter === v.status &&
                (filter !== "pending_approval" ||
                  !d?.decision ||
                  data.conflicts.includes(m.id))) ||
              (filter === "draft" && !!d?.decision) ||
              (filter === "new" &&
                v.versionNumber > 1 &&
                v.status === "pending_approval") ||
              (filter === "notes" && m.notes.length > 0) ||
              (filter === "fixed" &&
                m.notes.some((n) => n.status === "fixed")) ||
              (filter === "open" &&
                m.notes.some((n) => ["open", "reopened"].includes(n.status))))
          );
        });
  function renderSummary() {
    if (!data || !summaryHost) return;
    const count = data.draft.entries.filter((e) => e.decision).length,
      total = data.materials.length;
    queueCount.textContent = total;
    if (!admin()) packageButton.textContent = `К отправке · ${count}`;
    const progress = admin()
      ? data.materials.filter(
          (m) => m.currentVersion.status !== "pending_approval",
        ).length
      : count;
    summaryHost.textContent = `${admin() ? "Решений получено" : "Подготовлено"} ${progress} из ${total}`;
    queueProgress.max = total || 1;
    queueProgress.value = progress;
    queueProgress.setAttribute("aria-label", summaryHost.textContent);
  }
  function renderList() {
    if (!data || !listHost) return;
    renderSummary();
    bulk.hidden = !selectionMode;
    bulkToggle.textContent = selectionMode ? "Отмена" : "Выбрать";
    const materials = visible(),
      ids = new Set(materials.map((m) => m.id));
    const rows = new Map();
    for (const row of Array.from(listHost.children)) {
      const id = Number(row.dataset.materialId);
      if (!ids.has(id)) {
        window.ITDApprovalThumbnails.clear(row);
        row.remove();
      } else rows.set(id, row);
    }
    for (const [i, m] of materials.entries()) {
      const v = m.currentVersion,
        draft = data.draft.entries.find((e) => e.materialId === m.id);
      let row = rows.get(m.id);
      if (!row || row.dataset.version !== String(v.id)) {
        if (row) {
          window.ITDApprovalThumbnails.clear(row);
          row.remove();
        }
        row = el("article", undefined, "ac-material");
        row.dataset.materialId = m.id;
        row.dataset.version = v.id;
        const check = el("input");
        check.type = "checkbox";
        check.setAttribute("aria-label", `Выбрать ${displayTitle(m)}`);
        check.onchange = () =>
          check.checked ? selected.add(m.id) : selected.delete(m.id);
        const open = button("", () => showMaterial(m.id), "ac-material-open"),
          copy = el("span", undefined, "ac-row-copy");
        copy.append(el("strong"), el("span", "", "ac-row-status"));
        open.append(window.ITDApprovalThumbnails.mount(v.file), copy);
        row.append(check, open);
      }
      row.querySelector("input").hidden = !selectionMode;
      row.querySelector("input").checked = selected.has(m.id);
      row.classList.toggle("is-selected", m.id === mid);
      row
        .querySelector("button")
        .setAttribute("aria-current", m.id === mid ? "true" : "false");
      row.querySelector("strong").textContent =
        `${data.materials.indexOf(m) + 1}. ${displayTitle(m)}`;
      const status = row.querySelector(".ac-row-status");
      status.classList.toggle(
        "is-ready",
        !!draft?.decision && !data.conflicts.includes(m.id),
      );
      status.textContent = data.conflicts.includes(m.id)
        ? "Проверьте новую версию"
        : draft?.decision
          ? "К отправке"
          : v.status === "pending_approval" && v.versionNumber > 1
            ? "Проверить исправления"
            : labels[v.status];
      if (listHost.children[i] !== row)
        listHost.insertBefore(row, listHost.children[i] || null);
    }
    if (!materials.length)
      listHost.append(el("p", "Материалов в этой выборке нет."));
  }
  async function showMaterial(id, requested) {
    if (!id) {
      viewHost.replaceChildren(
        el("p", "В этом разделе ещё нет материалов для согласования."),
      );
      rail.replaceChildren();
      viewHost.append(
        button("История и ведомости", showPackages),
        button("Готовность этапа", showStage),
      );
      if (admin())
        viewHost.append(
          button("Направить материалы на согласование", publishFiles),
        );
      return;
    }
    if (busy) return;
    pinRequest = advanceAfterSave = null;
    say("");
    mid = id;
    const m = current();
    if (!m) return;
    vid = m.versions.find((v) => v.id === requested)?.id || m.currentVersion.id;
    const seq = ++openSeq,
      generation = epoch;
    stopPreview();
    viewHost.replaceChildren();
    rail.replaceChildren();
    renderList();
    root.dataset.mobile = "viewer";
    const v = version(),
      heading = el("div", undefined, "ac-view-heading"),
      title = el("div", undefined, "ac-title"),
      nav = el("div", undefined, "ac-material-nav");
    const format =
      v.file.contentType === "application/pdf"
        ? "PDF"
        : v.file.name.split(".").pop().toUpperCase();
    const meta = el(
      "p",
      `Материал ${data.materials.indexOf(m) + 1} из ${data.materials.length} · ${format} · v${v.versionNumber}`,
    );
    meta.title = v.file.name;
    title.append(el("h3", displayTitle(m)), meta);
    const mobile = button("Материалы", () => panel("list"), "ac-mobile-queue");
    mobile.setAttribute("aria-label", "Материалы");
    title.prepend(mobile);
    const prev = iconButton("Предыдущий материал", "‹", () => navigate(-1)),
      next = iconButton("Следующий материал", "›", () => navigate(1)),
      items = visible(),
      index = items.findIndex((x) => x.id === mid);
    prev.disabled = index <= 0;
    next.disabled = index < 0 || index >= items.length - 1;
    const menu = el("details", undefined, "ac-menu"),
      trigger = el("summary", "•••"),
      tools = el("div", undefined, "ac-menu-items");
    trigger.setAttribute("aria-label", "Действия с материалом");
    trigger.title = "Действия с материалом";
    if (returnToLibrary) {
      const back = button("← Файлы проекта", leave, "review-library-back");
      back.dataset.libraryReturn = "true";
      title.prepend(back);
    }
    const download = el("a", "Скачать оригинал");
    download.href = `/api/files/${v.file.id}/download`;
    download.download = v.file.name;
    tools.append(
      button("Замечания и история", () => panel("notes")),
      download,
      select(
        "Версия",
        m.versions.map((x) => [
          x.id,
          `v${x.versionNumber} · ${date(x.createdAt)}`,
        ]),
        vid,
        (value) => showMaterial(mid, +value),
      ),
    );
    if (v.versionNumber > 1) tools.append(button("Было / Стало", compare));
    tools.append(
      button("Сетка / список очереди", () => {
        listHost.classList.toggle("ac-grid");
        if (matchMedia("(max-width: 767px)").matches) panel("list");
      }),
      button("История и ведомости", showPackages),
      button("Готовность этапа", showStage),
      button("Обновить данные", async () => {
        if (saveError?.status === 409) return recoverDraft();
        await flush();
        await loadScope(scope, { mid });
      }),
    );
    if (admin())
      tools.append(
        button("Очередь замечаний", showNoteQueue),
        button("Направить материалы на согласование", publishFiles),
      );
    else tools.append(button("Восстановление черновиков", recoverDraft));
    menu.append(trigger, tools);
    nav.append(prev, next, menu);
    heading.append(title, nav);
    viewHost.append(heading);
    const selectedRow = listHost.querySelector(".is-selected");
    if (selectedRow) selectedRow.scrollIntoView({ block: "nearest" });
    const host = el("div", undefined, "ac-media-host");
    viewHost.append(host);
    const ownEntry = entry(),
      markers = m.notes
        .filter((n) => n.versionId === vid)
        .concat(
          ownEntry?.versionId === vid
            ? ownEntry.markers.map((n, i) => ({ ...n, draft: true, index: i }))
            : [],
        );
    let position =
      data.draft.position.materialId === mid &&
      data.draft.position.versionId === vid
        ? data.draft.position
        : {};
    viewer = window.ITDApprovalViewer.mount(host, v, {
      markers,
      position,
      showProgress: !admin(),
      onDisplay: updateFooter,
      onPage: (page) => recordView(v, page),
      onMarker: (n) => {
        if (n.id) {
          focusNote(n, true);
          return;
        }
        if (!canDecide()) return;
        if (n.draft) {
          compose(n.index);
          return;
        }
        if (!pinRequest) return;
        const request = pinRequest;
        cancelPin();
        compose(request.index, n);
      },
      onPosition: (pos) => {
        if (generation !== epoch || seq !== openSeq || admin()) return;
        const updated = { materialId: mid, versionId: vid, ...pos };
        if (
          Object.keys(updated).some(
            (key) => updated[key] !== data.draft.position[key],
          )
        ) {
          data.draft.position = updated;
          change();
        }
      },
    });
    if (
      !admin() &&
      (data.draft.position.materialId !== mid ||
        data.draft.position.versionId !== vid)
    ) {
      data.draft.position = { materialId: mid, versionId: vid, ...position };
      change();
    }
    renderRail();
    updateFooter();
    viewer.ready.then(() => {
      if (seq === openSeq) {
        const items = visible(),
          idx = items.findIndex((x) => x.id === mid);
        window.ITDApprovalViewer.prefetch(items[idx + 1]?.currentVersion.file);
      }
    });
    const detail = await hooks.api(`/api/materials/${mid}`);
    if (seq !== openSeq || generation !== epoch) return;
    historyByMaterial.set(mid, detail.events);
    renderHistory();
  }
  function renderHistory() {
    rail.querySelector(".ac-history")?.remove();
    const events = historyByMaterial.get(mid);
    if (!events) return;
    const history = el("details", undefined, "ac-history");
    history.append(el("summary", "Комментарии и история решений"));
    for (const e of events) {
      const p = el(
        "p",
        `${date(e.createdAt)} · ${e.actorName} · v${e.versionNumber}: ${labels[e.type] || e.type}\n${e.body}`,
      );
      history.append(p);
    }
    rail.append(history);
  }
  function navigate(delta) {
    const items = visible(),
      index = items.findIndex((m) => m.id === mid);
    if (items[index + delta])
      showMaterial(items[index + delta].id).catch((e) => say(e.message));
  }
  async function recordView(v, page) {
    if (admin()) return;
    const res = await hooks.api(
      `/api/approval-center/versions/${v.id}/view`,
      "POST",
      { page },
    );
    v.viewedPages = Math.max(v.viewedPages || 0, res.pages.length);
    v.pageCount = res.pageCount;
  }
  function canDecide() {
    const v = version(),
      d = entry();
    return (
      !admin() &&
      v &&
      current().currentVersion.id === vid &&
      v.status === "pending_approval" &&
      (!d || (d.versionId === vid && d.expectedRevision === v.revision)) &&
      !data.conflicts.includes(mid)
    );
  }
  async function confirmView(v) {
    if (!window.ITDViewer.supported(v.file) && !v.confirmedView) {
      if (!window.confirm("Вы скачали оригинал и проверили его содержание?"))
        return false;
      await hooks.api(`/api/approval-center/versions/${v.id}/view`, "POST", {
        page: 1,
        downloaded: true,
      });
    }
    await hooks.api(`/api/approval-center/versions/${v.id}/view`, "POST", {
      confirm: true,
    });
    v.confirmedView = true;
    return true;
  }
  function renderRail() {
    const m = current(),
      v = version();
    if (!m) return;
    const top = el("div", undefined, "ac-rail-top");
    top.append(
      el("h3", admin() ? "Работа с материалом" : "Замечания и история"),
      iconButton("Закрыть панель", "×", () => panel("viewer")),
    );
    rail.replaceChildren(top);
    if (v.correction) {
      const r = JSON.parse(v.correction);
      rail.append(el("h3", "Что исправлено"), el("p", r.description));
      for (const n of r.resolutions)
        rail.append(
          el(
            "p",
            `№${n.noteId}: ${n.fixed ? "исправлено" : "осталось открытым"} — ${n.explanation}`,
          ),
        );
    }
    if (vid !== m.currentVersion.id)
      rail.append(
        el(
          "p",
          "Историческая версия — только просмотр. Решение по ней сохранено.",
          "ac-warning",
        ),
        button("К текущей версии", () => showMaterial(mid)),
      );
    if (
      !admin() &&
      vid === m.currentVersion.id &&
      v.status === "pending_approval"
    ) {
      const d = entry(),
        conflict =
          d && (d.versionId !== vid || d.expectedRevision !== v.revision);
      if (conflict) {
        rail.append(
          el(
            "p",
            "Черновик относится к прежней версии. Его текст сохранён. Проверьте новую версию; старые маркеры не переносятся.",
            "ac-warning",
          ),
          el("p", d.comment),
          button("Убрать старый черновик после проверки", () => {
            if (
              window.confirm(
                "Удалить только этот неотправленный черновик? Скопируйте нужный текст перед удалением.",
              )
            ) {
              data.draft.entries = data.draft.entries.filter(
                (e) => e.materialId !== mid,
              );
              data.conflicts = data.conflicts.filter((id) => id !== mid);
              change();
              renderRail();
              renderList();
            }
          }),
        );
      } else if (d?.decision) {
        rail.append(
          button("Убрать черновое решение", () => removeDecision(mid)),
        );
      }
    }
    if (admin()) {
      rail.append(
        el("h3", "Работа студии"),
        el(
          "p",
          v.confirmedView
            ? "Клиент подтвердил просмотр этой версии"
            : "Просмотр ещё не подтверждён",
        ),
      );
      if (v.view?.viewed)
        rail.append(
          el(
            "p",
            `Первый просмотр: ${date(v.view.firstViewedAt)} · Последний: ${date(v.view.lastViewedAt)} · Открытий: ${v.view.viewCount}`,
          ),
        );
      if (vid === m.currentVersion.id && v.status === "approved")
        rail.append(
          button("Отменить согласование версии", () =>
            modal("Отмена согласования версии", (d) => {
              const reason = input("Причина отмены", "textarea");
              d.append(
                reason.wrap,
                el(
                  "p",
                  "История прежнего решения сохраняется. Версия снова потребует решения клиента.",
                ),
                button("Подтверждаю отмену", async () => {
                  await hooks.api(
                    `/api/material-versions/${vid}/cancel`,
                    "POST",
                    {
                      confirm: true,
                      reason: reason.field.value,
                      expectedRevision: v.revision,
                    },
                  );
                  d.close();
                  await loadScope(scope, { mid, vid });
                }),
              );
            }),
          ),
        );
      const room = input("Помещение", "text", m.room),
        required = el("label", "Обязателен для завершения этапа"),
        check = el("input");
      check.type = "checkbox";
      check.checked = m.required;
      required.prepend(check);
      rail.append(
        room.wrap,
        required,
        button("Сохранить свойства", async () => {
          await hooks.api(
            `/api/approval-center/materials/${mid}/metadata`,
            "PATCH",
            {
              room: room.field.value,
              required: check.checked,
              expectedRevision: m.metadataRevision,
            },
          );
          await loadScope(scope, { mid, vid });
        }),
        button("Загрузить исправленную версию", uploadVersion),
      );
    }
    const noteSection = el("section", undefined, "ac-notes");
    noteSection.id = "ac-notes";
    noteSection.append(el("h3", `Замечания (${m.notes.length})`));
    const noteList = el("div");
    const fill = (state) => {
      noteList.replaceChildren();
      for (const n of m.notes.filter((n) => !state || n.status === state))
        noteList.append(noteCard(n));
    };
    noteSection.append(
      select(
        "Статус замечания",
        [
          ["", "Все"],
          ...["open", "fixed", "confirmed", "reopened"].map((v) => [
            v,
            labels[v],
          ]),
        ],
        "",
        fill,
      ),
      noteList,
    );
    fill("");
    rail.append(noteSection);
    const d = entry();
    if (d?.versionId === vid)
      d.markers.forEach((n, i) =>
        rail.append(
          button(`Черновик маркера ${i + 1} · стр. ${n.page}: ${n.body}`, () =>
            compose(i),
          ),
        ),
      );
    if (canDecide() && d?.markers.length)
      rail.append(
        button("Добавить ещё одну отметку", () => {
          panel("viewer");
          pinRequest = { index: -1 };
          viewer.setPinMode(true);
          say("Выберите место для новой отметки.");
          updateFooter();
        }),
      );
    const comment = input("Комментарий к версии", "textarea");
    comment.field.maxLength = 4000;
    const discussion = el("details", undefined, "ac-discussion");
    discussion.append(
      el("summary", "Написать комментарий к версии"),
      comment.wrap,
      button("Отправить комментарий сейчас", async () => {
        if (!comment.field.value.trim()) throw Error("Напишите комментарий");
        const materialId = mid,
          generation = epoch;
        await hooks.api(`/api/material-versions/${vid}/comments`, "POST", {
          text: comment.field.value,
        });
        say("Комментарий отправлен и сохранён в истории");
        comment.field.value = "";
        const detail = await hooks.api(`/api/materials/${materialId}`);
        if (generation === epoch) {
          historyByMaterial.set(materialId, detail.events);
          if (materialId === mid) renderHistory();
        }
      }),
    );
    rail.append(discussion);
    renderHistory();
  }
  function removeDecision(id) {
    const e = data.draft.entries.find((x) => x.materialId === id);
    if (e) {
      e.decision = null;
      change();
      renderRail();
      renderList();
    }
  }
  async function nextUndecided() {
    const items = data.materials,
      start = items.findIndex((m) => m.id === mid);
    for (let offset = 1; offset < items.length; offset++) {
      const m = items[(start + offset) % items.length];
      if (
        m.currentVersion.status === "pending_approval" &&
        !data.draft.entries.some(
          (e) =>
            e.materialId === m.id &&
            e.decision &&
            !data.conflicts.includes(m.id),
        )
      ) {
        if (!visible().some((x) => x.id === m.id)) {
          query = "";
          filter = "all";
          root.querySelector(".ac-search input").value = "";
          root.querySelector(".ac-filters select").value = "all";
        }
        await showMaterial(m.id);
        return;
      }
    }
    say("Других материалов без решения нет. Проверьте подготовленный пакет.");
  }
  async function finishSave() {
    const target = advanceAfterSave,
      generation = epoch;
    await flush();
    if (generation !== epoch) return;
    if (
      target &&
      advanceAfterSave === target &&
      mid === target.mid &&
      vid === target.vid
    ) {
      advanceAfterSave = null;
      busy = false;
      await nextUndecided();
    }
  }
  async function decide(decision) {
    if (busy || !canDecide()) return;
    const v = version(),
      generation = epoch;
    busy = true;
    updateFooter();
    try {
      if (decision === "approved") {
        await viewer.confirmReady();
        if (generation !== epoch || !(await confirmView(v))) return;
      }
      if (generation !== epoch || v.id !== vid) return;
      const e = entry(true);
      if (decision === "changes_requested" && !e.comment.trim())
        throw Error("Напишите замечание");
      e.decision = decision;
      advanceAfterSave = { mid, vid };
      change();
      renderList();
      renderRail();
      await finishSave();
    } finally {
      if (generation === epoch) {
        busy = false;
        updateFooter();
      }
    }
  }
  async function bulkApprove() {
    const items = data.materials.filter((m) => selected.has(m.id));
    if (!items.length) throw Error("Выберите материалы");
    if (
      items.some((m) => {
        const v = m.currentVersion;
        return (
          (!v.confirmedView &&
            !(v.pageCount && v.viewedPages === v.pageCount)) ||
          v.status !== "pending_approval" ||
          data.conflicts.includes(m.id)
        );
      })
    )
      throw Error(
        "Проверьте все выбранные материалы. Для группового согласования откройте каждую страницу актуальной версии.",
      );
    modal("Подготовить групповое согласование", (d) => {
      d.append(
        el(
          "p",
          `Подтвердите просмотр всех страниц выбранных материалов. Решений к подготовке — ${items.length}.`,
        ),
      );
      const apply = button(
        "Подготовить решения",
        async () => {
          apply.disabled = true;
          try {
            for (const m of items) await confirmView(m.currentVersion);
            for (const m of items) {
              let e = data.draft.entries.find((e) => e.materialId === m.id);
              if (!e) {
                e = {
                  materialId: m.id,
                  versionId: m.currentVersion.id,
                  expectedRevision: m.currentVersion.revision,
                  comment: "",
                  markers: [],
                };
                data.draft.entries.push(e);
              }
              e.decision = "approved";
            }
            change();
            await flush();
            selected.clear();
            selectionMode = false;
            renderList();
            renderRail();
            d.close();
          } finally {
            apply.disabled = false;
          }
        },
        "primary",
      );
      d.append(apply);
    });
  }
  function cancelPin() {
    pinRequest = null;
    viewer?.setPinMode(false);
    say("");
    updateFooter();
  }
  function compose(index, point) {
    if (!canDecide()) return;
    const e = entry(true);
    // An existing one-marker return uses the same text field for its note and pin.
    if (
      index === undefined &&
      e.markers.length === 1 &&
      e.markers[0].body === e.comment
    )
      index = 0;
    let marker = e.markers[index],
      location = point || marker;
    modal("Нужны правки", (d) => {
      const note = input(
        "Текст замечания",
        "textarea",
        index === -1 ? "" : (marker?.body ?? e.comment),
      );
      note.field.maxLength = 4000;
      note.field.placeholder = "Что нужно изменить?";
      d.append(el("p", displayTitle(current()), "ac-subtitle"), note.wrap);
      const write = () => {
        const body = note.field.value;
        if (
          (index !== -1 && !marker) ||
          e.comment === marker?.body ||
          !e.comment.trim()
        )
          e.comment = body;
        if (location && body.trim()) {
          const value = {
            x: location.x,
            y: location.y,
            page: location.page,
            body,
          };
          if (!marker) index = e.markers.push(value) - 1;
          else e.markers[index] = value;
          marker = value;
        } else if (marker) {
          e.markers.splice(index, 1);
          marker = undefined;
          index = undefined;
        }
        if (e.decision === "approved" || !e.comment.trim()) e.decision = null;
        change();
        refreshMarkers();
        renderList();
      };
      if (point && note.field.value.trim()) write();
      note.field.oninput = write;
      if (window.ITDViewer.supported(version().file)) {
        const pin = button(
          location
            ? `Переместить отметку · стр. ${location.page}`
            : "Поставить отметку на документе",
          () => {
            d.close();
            panel("viewer");
            pinRequest = { index };
            viewer.setPinMode(true);
            say(
              "Выберите место на документе. Клавиша Enter ставит отметку в центре страницы.",
            );
            updateFooter();
          },
        );
        d.append(pin);
        if (marker)
          d.append(
            button("Убрать отметку", () => {
              e.markers.splice(index, 1);
              change();
              refreshMarkers();
              d.close();
              compose();
            }),
          );
      }
      d.append(
        button(
          "Подготовить и далее",
          async () => {
            if (!note.field.value.trim()) throw Error("Напишите замечание");
            if (!e.comment.trim()) e.comment = note.field.value;
            d.close();
            await decide("changes_requested");
          },
          "primary",
        ),
      );
      d.addEventListener(
        "close",
        () => {
          if (current()) renderRail();
        },
        { once: true },
      );
    });
  }
  function refreshMarkers() {
    const m = current(),
      d = entry();
    viewer?.setMarkers(
      m.notes
        .filter((n) => n.versionId === vid)
        .concat(
          d?.versionId === vid
            ? d.markers.map((n, i) => ({ ...n, draft: true, index: i }))
            : [],
        ),
    );
  }
  function noteCard(n) {
    const card = el("article", undefined, "ac-note");
    card.id = `ac-note-${n.id}`;
    card.append(
      button(
        `Маркер ${n.number} · v${n.versionNumber} · ${labels[n.status]} · страница ${n.page}`,
        () => focusNote(n),
      ),
      el("p", n.body),
      el("small", `${n.authorName} · ${date(n.createdAt)}`),
    );
    const history = el("details");
    history.append(el("summary", "История замечания"));
    for (const e of n.history)
      history.append(
        el(
          "p",
          `${date(e.createdAt)} · ${e.actorName}: ${labels[e.type] || e.type} — ${e.body}`,
        ),
      );
    card.append(history);
    const actions = admin()
      ? [
          ["reply", "Ответить"],
          ["fixed", "Отметить исправленным"],
        ]
      : [
          ["reply", "Дополнить"],
          ...(n.status === "fixed"
            ? [["confirmed", "Подтвердить исправление"]]
            : []),
          ["open", "Оставить открытым"],
          ["reopened", "Повторная доработка"],
        ];
    for (const [type, label] of actions)
      card.append(
        button(label, () =>
          modal(label, (d) => {
            const text = input("Пояснение", "textarea");
            d.append(
              text.wrap,
              button("Сохранить в истории", async () => {
                await hooks.api(
                  `/api/approval-center/notes/${n.id}/events`,
                  "POST",
                  {
                    type,
                    body: text.field.value,
                    expectedRevision: n.revision,
                    versionId: current().currentVersion.id,
                  },
                );
                await flush();
                d.close();
                await loadScope(scope, { mid, vid });
                panel("notes");
              }),
            );
          }),
        ),
      );
    return card;
  }
  function showNoteQueue() {
    modal("Очередь замечаний", (dialog) => {
      let status = "active",
        materialId = 0;
      const rows = el("div");
      const render = () => {
        rows.replaceChildren();
        for (const m of data.materials) {
          if (materialId && m.id !== materialId) continue;
          for (const n of m.notes) {
            if (
              status === "active"
                ? n.status === "confirmed"
                : status && n.status !== status
            )
              continue;
            const card = el("article", undefined, "ac-note");
            card.append(
              el("h3", `${displayTitle(m)} · v${n.versionNumber}`),
              el("p", n.body),
              el(
                "small",
                `${labels[n.status]} · ${n.authorName} · ${date(n.createdAt)} · стр. ${n.page} · ${Math.round(n.x * 100)}%, ${Math.round(n.y * 100)}%`,
              ),
              button("Открыть замечание", async () => {
                dialog.close();
                await showMaterial(m.id, n.versionId);
                await viewer?.ready;
                await focusNote(n);
                root.dataset.mobile = "notes";
              }),
            );
            rows.append(card);
          }
        }
        if (!rows.children.length)
          rows.append(el("p", "В этой выборке замечаний нет."));
      };
      dialog.append(
        el(
          "p",
          `${project.title} / ${project.stages.find((s) => s.id === scope)?.title || "Без этапа"}. Проект и этап выбираются в кабинете.`,
        ),
        select(
          "Материал в очереди",
          [
            [0, "Все материалы"],
            ...data.materials.map((m) => [m.id, displayTitle(m)]),
          ],
          0,
          (v) => {
            materialId = +v;
            render();
          },
        ),
        select(
          "Статус в очереди",
          [
            ["active", "Требуют действий"],
            ["", "Все статусы"],
            ...["open", "fixed", "confirmed", "reopened"].map((s) => [
              s,
              labels[s],
            ]),
          ],
          status,
          (v) => {
            status = v;
            render();
          },
        ),
        rows,
      );
      render();
    });
  }
  async function focusNote(n, details = false) {
    if (n.versionId !== vid) {
      await showMaterial(mid, n.versionId);
    }
    panel(details ? "notes" : "viewer");
    await viewer?.focusMarker(n);
    if (details)
      document
        .getElementById(`ac-note-${n.id}`)
        ?.scrollIntoView({ block: "nearest" });
  }
  function updateFooter() {
    if (!footer || !data) return;
    renderSummary();
    footer.replaceChildren();
    const state = el("div", undefined, "ac-save");
    state.dataset.state = saveError
      ? "error"
      : dirty === saved
        ? "saved"
        : "saving";
    state.append(saveStatus);
    if (!admin())
      state.append(
        el(
          "small",
          saveError ? saveError.message : "Решения сохраняются автоматически",
        ),
      );
    footer.append(state);
    if (saveError)
      footer.append(
        button(
          saveError.status === 409
            ? "Разобрать конфликт"
            : "Повторить сохранение",
          saveError.status === 409
            ? recoverDraft
            : async () => {
                await finishSave();
                say("");
              },
        ),
      );
    if (!current()) return;
    const actions = el("div", undefined, "ac-actions");
    if (pinRequest) actions.append(button("Отменить отметку", cancelPin));
    else if (comparison)
      actions.append(
        button("К просмотру материала", () => showMaterial(mid, vid)),
        button("Замечания и история", () => panel("notes")),
      );
    else if (canDecide()) {
      actions.classList.add("ac-decisions");
      const later = button("Позже", nextUndecided, "ac-later"),
        revise = button("Нужны правки", () => compose()),
        approve = button(
          "Согласовать и далее",
          () => decide("approved"),
          "primary ac-approve",
        );
      approve.setAttribute("aria-label", "Согласовать и далее");
      approve.title =
        "Подтвердить просмотр всех страниц и сохранить черновое решение";
      later.disabled = revise.disabled = busy;
      approve.disabled =
        busy ||
        (window.ITDViewer.supported(version().file) && !viewer?.dimensions);
      actions.append(later, revise, approve);
    } else {
      const v = version(),
        m = current();
      actions.append(
        el(
          "span",
          vid !== m.currentVersion.id ? "Архивная версия" : labels[v.status],
        ),
      );
      actions.append(
        button(admin() ? "Работа с материалом" : "Замечания и история", () =>
          panel("notes"),
        ),
      );
    }
    footer.append(actions);
  }
  async function submit() {
    await flush();
    const entries = data.draft.entries.filter((e) => e.decision);
    const a = entries.filter((e) => e.decision === "approved").length,
      c = entries.length - a;
    modal("К отправке", (d) => {
      if (!entries.length) {
        d.append(el("p", "Подготовленных решений пока нет."));
        return;
      }
      d.append(el("p", `Подготовлено: ${a} согласований · ${c} на доработку`));
      const list = el("div", undefined, "ac-package-list");
      d.append(list);
      for (const e of entries) {
        const m = data.materials.find((x) => x.id === e.materialId);
        const row = el("article"),
          copy = el("div");
        const v = m?.versions.find((v) => v.id === e.versionId);
        copy.append(
          el(
            "strong",
            m
              ? `${displayTitle(m)} · v${v?.versionNumber || "?"}`
              : `Материал №${e.materialId}`,
          ),
          el(
            "p",
            e.decision === "approved" ? "К согласованию" : "Нужны правки",
          ),
        );
        if (data.conflicts.includes(e.materialId))
          copy.append(
            el("p", "Версия изменилась. Проверьте материал.", "ac-warning"),
          );
        if (e.comment) copy.append(el("p", e.comment));
        for (const [i, n] of e.markers.entries())
          copy.append(
            el("small", `Отметка ${i + 1} · стр. ${n.page} · ${n.body}`),
          );
        row.append(
          copy,
          button("Изменить", async () => {
            d.close();
            if (m) await showMaterial(m.id);
            else recoverDraft();
          }),
          button("Убрать из пакета", async () => {
            removeDecision(e.materialId);
            d.close();
            await submit();
          }),
        );
        list.append(row);
      }
      const send = button(
        "Подтверждаю отправку",
        async () => {
          send.disabled = true;
          try {
            await flush();
            if (
              !operation ||
              operation.expectedRevision !== data.draft.revision
            )
              operation = {
                operationId: newOperationId(),
                expectedRevision: data.draft.revision,
                confirm: true,
                decisionsOnly: true,
              };
            const result = await hooks.api(
              route() + "/submit",
              "POST",
              operation,
            );
            operation = null;
            d.close();
            await loadScope(scope, { mid, vid });
            say(
              `Пакет принят. Ведомость №${result.packageId}, раунд ${result.roundNumber}.`,
            );
          } finally {
            send.disabled = false;
          }
        },
        "primary",
      );
      d.append(send);
    });
  }
  function showStage() {
    modal("Отдельное согласование этапа", (d) => {
      const state = data.stage;
      d.append(
        el(
          "p",
          state.approved
            ? "Этап уже согласован или завершён."
            : "Согласование файлов само по себе не завершает этап.",
        ),
      );
      for (const b of state.blockers) d.append(el("p", b));
      if (!admin() && !state.approved && !state.blockers.length)
        d.append(
          button(
            "Подтверждаю согласование этапа",
            async () => {
              await hooks.api(route() + "/approve-stage", "POST", {
                operationId: newOperationId(),
                token: state.token,
                confirm: true,
              });
              d.close();
              await loadScope(scope, { mid, vid });
              await hooks.refresh();
              say("Этап согласован отдельным действием");
            },
            "primary",
          ),
        );
    });
  }
  function showPackages() {
    modal("Раунды и ведомости", (d) => {
      if (!data.packages.length)
        d.append(el("p", "Пакеты ещё не отправлялись."));
      for (const p of data.packages)
        d.append(
          button(
            `Раунд ${p.roundNumber} · Ведомость №${p.id} · ${date(p.createdAt)}`,
            () => {
              d.close();
              return showPackage(p.id);
            },
          ),
        );
    });
  }
  async function showPackage(id) {
    const p = await hooks.api(`/api/approval-center/packages/${id}`);
    modal(`Ведомость №${id} · раунд ${p.roundNumber}`, (d) => {
      d.append(
        el(
          "p",
          `${p.projectTitle} / ${p.stageTitle} · ${p.actorName} · ${date(p.createdAt)}`,
        ),
      );
      const download = el("a", "Скачать ведомость в PDF");
      download.href = `/api/approval-center/packages/${id}/pdf`;
      d.append(download);
      for (const m of p.materials) {
        const row = el("article", undefined, "ac-note");
        row.append(
          button(`${m.title} · v${m.versionNumber}`, async () => {
            d.close();
            await showMaterial(m.materialId, m.versionId);
          }),
          el(
            "p",
            `${labels[m.decision] || "Без решения в этом пакете"} · ${m.comment}`,
          ),
        );
        for (const [i, n] of m.markers.entries())
          row.append(
            button(
              `Маркер ${n.number || i + 1} · стр. ${n.page}: ${n.body}`,
              async () => {
                d.close();
                await showMaterial(m.materialId, m.versionId);
                await viewer.ready;
                viewer.focusMarker(n);
              },
            ),
          );
        d.append(row);
      }
      d.append(
        el("p", "Исторический снимок. Не является электронной подписью."),
      );
    });
  }
  async function compare() {
    const m = current(),
      v = version(),
      previous = m.versions
        .filter((x) => x.versionNumber < v.versionNumber)
        .at(-1);
    if (!previous) throw Error("Выберите версию, у которой есть предыдущая");
    stopPreview();
    panel("viewer");
    viewHost.replaceChildren();
    const tools = el("div", undefined, "ac-compare-tools"),
      pair = el("div", undefined, "ac-compare"),
      left = el("div", undefined, "ac-compare-side"),
      right = el("div", undefined, "ac-compare-side");
    left.append(el("h3", `Было · v${previous.versionNumber}`));
    right.append(el("h3", `Стало · v${v.versionNumber}`));
    const lh = el("div", undefined, "ac-media-host"),
      rh = el("div", undefined, "ac-media-host");
    left.append(lh);
    right.append(rh);
    pair.append(left, right);
    viewHost.append(tools, pair);
    const warning = el("p");
    viewHost.append(warning);
    let sync = true,
      syncing = false;
    const syncPos = (target, pos) => {
      if (sync && !syncing && target) {
        syncing = true;
        target.setZoom(pos.zoom);
        target.viewport.scrollTo(pos.scrollX, pos.scrollY);
        if (
          previous.file.contentType === "application/pdf" &&
          v.file.contentType === "application/pdf"
        )
          target.go(pos.page);
        syncing = false;
      }
    };
    comparison = window.ITDApprovalViewer.mount(lh, previous, {
      markers: m.notes.filter((n) => n.versionId === previous.id),
      onMarker: (n) => focusNote(n, true),
      onPosition: (p) => syncPos(viewer, p),
    });
    viewer = window.ITDApprovalViewer.mount(rh, v, {
      markers: m.notes.filter((n) => n.versionId === v.id),
      onMarker: focusNote,
      onPosition: (p) => syncPos(comparison, p),
      showProgress: !admin(),
      onPage: (p) => recordView(v, p),
      onMarker: (n) => focusNote(n, true),
    });
    tools.append(
      button("К материалу", () => showMaterial(mid, vid)),
      button("Синхронизация вкл/выкл", () => {
        sync = !sync;
        warning.textContent = sync
          ? "Синхронизация включена"
          : "Просмотры независимы";
      }),
      button("Рядом", () => {
        pair.classList.remove("ac-slider");
        right.style.clipPath = "";
      }),
    );
    await Promise.all([viewer.ready, comparison.ready]);
    const a = comparison.dimensions,
      b = viewer.dimensions;
    if (
      window.ITDViewer.image(previous.file) &&
      window.ITDViewer.image(v.file) &&
      a &&
      b &&
      a.width === b.width &&
      a.height === b.height
    ) {
      warning.textContent =
        "Совмещение по размеру изображения. Проверьте соответствие ракурса самостоятельно.";
      const slider = input("Разделитель «Было / Стало»", "range", 50);
      slider.field.min = 0;
      slider.field.max = 100;
      slider.field.oninput = () => {
        pair.classList.add("ac-slider");
        right.style.clipPath = `inset(0 0 0 ${slider.field.value}%)`;
      };
      tools.append(slider.wrap);
    } else
      warning.textContent =
        "Размеры, пропорции или форматы различаются: используйте просмотр рядом. Точное совмещение не гарантировано.";
    if (viewer.pageCount !== comparison.pageCount) {
      sync = false;
      warning.textContent +=
        " Количество страниц различается; сопоставляйте страницы вручную.";
    }
    renderRail();
    updateFooter();
  }
  async function publishFiles() {
    const result = await hooks.api(
      `/api/projects/${project.id}/files?stageId=${scope || "none"}&category=result`,
    );
    const files = result.files.filter((f) => !f.review),
      chosen = new Set(),
      operationId = newOperationId();
    modal("Направить материалы на согласование", (d) => {
      d.append(
        el(
          "p",
          "Выберите результаты работы в этом разделе. Документы не включаются автоматически.",
        ),
      );
      if (!files.length)
        d.append(
          el(
            "p",
            "Нет ненаправленных материалов. Загрузите результаты через «Файлы проекта», затем вернитесь сюда.",
          ),
        );
      for (const f of files) {
        const label = el("label", f.name),
          check = el("input");
        check.type = "checkbox";
        check.onchange = () =>
          check.checked ? chosen.add(f.id) : chosen.delete(f.id);
        label.prepend(check);
        d.append(label);
      }
      d.append(
        button("Подтверждаю отправку выбранных", async () => {
          await hooks.api(route() + "/publish", "POST", {
            operationId,
            fileIds: [...chosen],
            confirm: true,
          });
          d.close();
          await hooks.refresh();
          await loadScope(scope);
          say("Пакет отправлен клиенту одним уведомлением.");
        }),
      );
    });
  }
  function uploadVersion() {
    const m = current();
    modal("Исправленная версия", (d) => {
      const form = el("form"),
        file = input("Файл новой версии", "file"),
        description = input("Что изменено", "textarea");
      file.field.name = "file";
      file.field.required = true;
      description.field.required = true;
      form.append(file.wrap, description.wrap);
      const rows = [];
      for (const n of m.notes.filter((n) => n.status !== "confirmed")) {
        const row = el("div", undefined, "ac-note"),
          fixed = el("input");
        fixed.type = "checkbox";
        const label = el("label", `Исправлено замечание №${n.id}: ${n.body}`);
        label.prepend(fixed);
        const explanation = input(
          "Результат или причина, почему не исправлено",
          "textarea",
        );
        row.append(label, explanation.wrap);
        form.append(row);
        rows.push({ n, fixed, explanation: explanation.field });
      }
      const status = el("p");
      status.setAttribute("role", "status");
      form.append(status);
      const send = button("Отправить новую версию", async () => {
        if (!description.field.value.trim()) throw Error("Опишите изменения");
        const correctionReport = {
          description: description.field.value,
          resolutions: rows.map((r) => ({
            noteId: r.n.id,
            fixed: r.fixed.checked,
            explanation: r.explanation.value,
          })),
        };
        if (correctionReport.resolutions.some((r) => !r.explanation.trim()))
          throw Error("Поясните результат каждого замечания");
        send.disabled = true;
        try {
          const result = await window.ITDUploads.send(form, {
            category: "result",
            stageId: m.stageId,
            materialId: m.id,
            expectedVersionId: m.currentVersion.id,
            correctionReport,
          });
          if (result) {
            d.close();
            await hooks.refresh();
            await loadScope(scope, { mid });
            say("Исправленная версия отправлена клиенту.");
          }
        } finally {
          send.disabled = false;
        }
      });
      form.append(send);
      d.append(form);
      window.ITDUploads.register(form, {
        context: () => ({
          ...window.ITDUploads.contextOf(project),
          stageId: m.stageId,
          materialId: m.id,
          expectedVersionId: m.currentVersion.id,
        }),
      });
    });
  }
  async function open(id, requested, back) {
    if (!project) return false;
    id = Number(id);
    requested = requested == null ? undefined : Number(requested);
    const pid = project.id,
      token = {};
    pendingOpen = token;
    try {
      const detail = await hooks.api(`/api/materials/${id}`);
      if (pendingOpen !== token || project?.id !== pid) return false;
      if (detail.material.projectId !== pid)
        throw Error("Материал относится к другому проекту.");
      await flush();
      if (pendingOpen !== token || project?.id !== pid) return false;
      returnToLibrary = back || null;
      active = true;
      if (root) root.hidden = false;
      document.getElementById("app-view").inert = true;
      hooks.selectTab("review");
      build();
      await loadScope(detail.material.stageId || 0, {
        mid: id,
        vid: requested,
      });
      return true;
    } finally {
      if (pendingOpen === token) pendingOpen = null;
    }
  }
  async function onTab(tab) {
    if (pendingOpen) return;
    active = tab === "review";
    if (root) root.hidden = !active;
    document.getElementById("app-view").inert = active && !!root;
    if (!active) {
      await flush();
      stopPreview();
      return;
    }
    if (!project) return;
    if (root && data) {
      await showMaterial(mid, vid);
      return;
    }
    const pid = project.id,
      generation = epoch;
    const mats = await hooks.api(`/api/projects/${pid}/materials`);
    if (pendingOpen || !active || project?.id !== pid || generation !== epoch)
      return;
    scope = mats.materials[0]?.stageId || 0;
    build();
    await loadScope(scope);
  }
  function init(h) {
    hooks = h;
    const viewport = window.visualViewport;
    const resize = () => {
      const visible = viewport && viewport.scale === 1;
      const style = document.documentElement.style;
      style.setProperty(
        "--ac-visible-height",
        (visible ? viewport.height : window.innerHeight) + "px",
      );
      style.setProperty(
        "--ac-visible-top",
        (visible ? viewport.offsetTop : 0) + "px",
      );
    };
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    resize();
    window.addEventListener("beforeunload", (e) => {
      if (
        dirty !== saved ||
        data?.draft.entries.some(
          (e) => e.decision || e.comment || e.markers.length,
        )
      ) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }
  window.ITDApprovalCenter = {
    init,
    setProject,
    reset,
    open,
    onTab,
    showPackage,
    openDiscussion: () => {
      if (root && active) panel("notes");
    },
  };
})();

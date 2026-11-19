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
  const draftLabels = {
    approved: "К отправке: согласование",
    changes_requested: "К отправке: правки",
  };
  const revisionSaved = "Правки сохранены в черновик. Дизайнер увидит их после отправки пакета";
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
    stageApproval,
    summaryHost,
    packageButton,
    bulk,
    bulkToggle,
    selectAll, selectionCount, clearSelection, approveSelected, selectionNotice,
    incompleteVersion = null,
    confirmationError = null,
    lastViewContext = null,
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
      file: { ...(m.versions[0]?.file || m.currentVersion.file), review: { materialId: m.id } },
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
    lastViewContext = incompleteVersion = confirmationError = null;
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
    root.querySelectorAll("[data-open-notes]").forEach(syncNotesButton);
    if (name === "notes")
      rail.querySelector("button")?.focus({ preventScroll: true });
    if (name === "list")
      listHost
        .querySelector(".is-selected button")
        ?.focus({ preventScroll: true });
  }
  function syncNotesButton(b) {
    const open = root.dataset.mobile === "notes";
    b.textContent = open ? "Закрыть замечания" : b.dataset.openNotes;
    b.setAttribute("aria-expanded", String(open));
  }
  function notesButton(label, cls) {
    const b = button(label, () => panel(root.dataset.mobile === "notes" ? "viewer" : "notes"), cls);
    b.dataset.openNotes = label;
    b.setAttribute("aria-controls", rail.id);
    syncNotesButton(b);
    return b;
  }
  async function leave() {
    await flush();
    if (returnToLibrary) {
      const back = returnToLibrary;
      returnToLibrary = null;
      back();
    } else hooks.backToStage(scope);
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
      (s) => changeScope(+s),
    );
    stagePicker.className = "ac-stage";
    stagePicker.append(el("span", "", "ac-stage-name"));
    stageApproval = el("span", "", "ac-stage-approved");
    stageApproval.hidden = true;
    stageApproval.setAttribute("role", "status");
    context.append(el("span", project.title), el("span", "·"), stagePicker, stageApproval);
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
      const value = search.field.value.trim().toLocaleLowerCase("ru-RU");
      if (query !== value) {
        query = value;
        resetFilteredSelection();
      }
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
          resetFilteredSelection();
        },
      ),
    );
    bulk = el("div", undefined, "ac-bulk");
    bulkToggle = button("Выбрать", () => {
      selectionMode = !selectionMode;
      selectionNotice.textContent = "";
      selected.clear();
      renderList();
    });
    selectionNotice = el("small", "", "ac-selection-notice");
    selectionNotice.setAttribute("role", "status");
    if (!admin()) {
      filters.append(bulkToggle);
      selectAll = button("", () => {
        selected = new Set(visible().map((m) => m.id));
        selectionNotice.textContent = "";
        renderList();
      });
      clearSelection = button("Снять выбор", () => {
        selected.clear();
        renderList();
      });
      selectionCount = el("strong");
      selectionCount.setAttribute("role", "status");
      approveSelected = button("", bulkApprove, "ac-group-approve");
      bulk.append(selectAll, selectionCount, clearSelection, approveSelected, selectionNotice);
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
    rail.id = "ac-material-notes";
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
  function showStageName(id) {
    const picker = stagePicker.querySelector("select");
    picker.value = String(id);
    stagePicker.querySelector(".ac-stage-name").textContent = picker.selectedOptions[0]?.textContent || "";
  }
  function beginScope(s) {
    if ((data && s === scope) || root.dataset.openingStage === String(s)) return;
    root.dataset.openingStage = String(s);
    showStageName(s);
    say("Открываем материалы выбранного раздела…");
  }
  function finishScope(s, displayed) {
    if (root?.dataset.openingStage !== String(s)) return;
    delete root.dataset.openingStage;
    showStageName(displayed);
    say("");
  }
  async function changeScope(s) {
    build();
    const center = root;
    if (data && s === scope) {
      if (center.hasAttribute("data-opening-stage")) finishScope(center.dataset.openingStage, scope);
      return;
    }
    beginScope(s);
    try {
      await flush();
      if (active && !pendingOpen && root === center && center.dataset.openingStage === String(s))
        await loadScope(s);
    } catch (error) {
      if (root !== center || !active) return;
      if (center.dataset.openingStage === String(s)) finishScope(s, data ? scope : s);
      else if (scope !== s || center.hasAttribute("data-opening-stage")) return;
      say(error.message);
    }
  }
  async function loadScope(s, target) {
    const pid = project.id,
      generation = ++epoch;
    const context = target?.context;
    const changing = !data || s !== scope;
    build();
    beginScope(s);
    const work = root.querySelector(".ac-work");
    work.inert = true;
    packageButton.disabled = true;
    let result;
    try {
      result = await hooks.api(route(s));
    } catch (error) {
      if (generation === epoch && (!changing || root?.dataset.openingStage === String(s))) {
        finishScope(s, data ? scope : s);
        if (data) await showMaterial(mid, vid);
        else
          viewHost.replaceChildren(
            button("Повторить загрузку", () => loadScope(s, target)),
          );
        say(context ? `Не удалось обновить данные. Показано предыдущее состояние. ${error.message}` : error.message);
      }
      return;
    } finally {
      if (generation === epoch) {
        work.inert = false;
        packageButton.disabled = !data;
      }
    }
    if (generation !== epoch || project?.id !== pid || !active ||
        (changing && root.dataset.openingStage !== String(s))) return;
    scope = s;
    dirty = saved = 0;
    saveError = null;
    operation = null;
    if (!context) {
      selected.clear();
      selectionMode = false;
      selectionNotice.textContent = "";
    }
    busy = false;
    advanceAfterSave = pinRequest = null;
    stopPreview();
    finishScope(s, scope);
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
    vid = target?.mid ? target.vid : data.draft.position.versionId;
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
    const viewContext = target?.panel === "notes" && target.mid === mid
      ? { ...context, panel: "notes" }
      : context;
    await showMaterial(mid, vid, viewContext);
    if (generation !== epoch) return;
    if (context && active) {
      if (context.versionId === vid) {
        const filter = rail.querySelector(".ac-notes select");
        if (filter && context.noteFilter) {
          filter.closest("details").open = true;
          filter.value = context.noteFilter;
          filter.dispatchEvent(new Event("change"));
        }
        const discussion = rail.querySelector(".ac-discussion");
        if (discussion) {
          discussion.open = context.discussionOpen;
          discussion.querySelector("textarea").value = context.comment;
        }
        for (const cls of context.openSections || []) {
          const section = rail.querySelector("." + cls);
          if (section) section.open = true;
        }
        const history = rail.querySelector(".ac-history");
        if (history) history.open = context.historyOpen;
      }
      if (context.properties && target.mid === mid) {
        const room = rail.querySelector('input[aria-label="Помещение"]');
        const required = rail.querySelector('input[type="checkbox"]');
        if (room && required) {
          room.value = context.properties.room;
          required.checked = context.properties.required;
          room.dataset.revision = context.properties.revision;
        }
      }
      listHost.scrollTop = context.scroll;
      const body = rail.querySelector(".ac-rail-body");
      if (body) body.scrollTop = context.railScroll;
    }
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
              (filter === "notes" && (m.notes.length > 0 || m.returnComments?.length)) ||
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
    const stageStatus = data.stage.acceptedSeparately ? "Этап согласован отдельным действием" :
      data.stage.approved ? (data.stage.status === "completed" ? "Этап завершён" : "Этап согласован") : "";
    if (stageApproval.textContent !== stageStatus) stageApproval.textContent = stageStatus;
    stageApproval.hidden = !stageStatus;
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
  function resetFilteredSelection() {
    if (selected.size) {
      selected.clear();
      selectionNotice.textContent = "Выбор снят после изменения поиска или фильтра.";
    }
    renderList();
  }
  function updateSelection(total) {
    if (admin() || !selectionMode) return;
    selectAll.textContent = `Выбрать все · ${total}`;
    selectAll.disabled = !total;
    selectionCount.textContent = `Выбрано: ${selected.size}`;
    clearSelection.disabled = approveSelected.disabled = !selected.size;
    approveSelected.textContent = `Согласовать выбранные · ${selected.size}`;
  }
  function renderList() {
    if (!data || !listHost) return;
    renderSummary();
    bulk.hidden = !selectionMode;
    bulkToggle.textContent = selectionMode ? "Отмена" : "Выбрать";
    const materials = visible(),
      ids = new Set(materials.map((m) => m.id));
    // A draft or status filter can change membership as decisions are edited.
    for (const id of selected) if (!ids.has(id)) selected.delete(id);
    updateSelection(materials.length);
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
        check.onchange = () => {
          if (check.checked) selected.add(m.id);
          else selected.delete(m.id);
          selectionNotice.textContent = "";
          updateSelection(visible().length);
        };
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
          ? draftLabels[draft.decision]
          : v.status === "pending_approval" && v.versionNumber > 1
            ? "Проверить исправления"
            : labels[v.status];
      if (listHost.children[i] !== row)
        listHost.insertBefore(row, listHost.children[i] || null);
    }
    if (!materials.length)
      listHost.append(el("p", "Материалов в этой выборке нет."));
  }
  async function showMaterial(id, requested, context) {
    if (!id) {
      panel("viewer");
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
    incompleteVersion = confirmationError = null;
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
      const back = button(window.ITDLibrary?.stageId() ? "← Файлы этапа" : "← Файлы проекта", leave, "review-library-back");
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
        await refreshView();
      }),
    );
    if (admin()) {
      tools.append(button("Очередь замечаний", showNoteQueue));
      if (vid === m.currentVersion.id) tools.append(button("Направить материалы на согласование", publishFiles));
    }
    else tools.append(button("Восстановление черновиков", recoverDraft));
    menu.append(trigger, tools);
    if (canDecide() && (m.notes.length || m.returnComments?.length))
      nav.append(notesButton("Замечания", "ac-remarks-link"));
    nav.append(prev, next, menu);
    heading.append(title, nav);
    viewHost.append(heading);
    const selectedRow = listHost.querySelector(".is-selected");
    if (selectedRow) selectedRow.scrollIntoView({ block: "nearest" });
    const host = el("div", undefined, "ac-media-host");
    viewHost.append(host);
    lastViewContext = null;
    const ownEntry = entry(),
      markers = m.notes
        .filter((n) => n.versionId === vid)
        .concat(
          ownEntry?.versionId === vid
            ? ownEntry.markers.map((n, i) => ({ ...n, draft: true, index: i }))
            : [],
        );
    const position = context?.versionId === vid ? context.position :
      data.draft.position.materialId === mid &&
      data.draft.position.versionId === vid
        ? data.draft.position
        : {};
    viewer = window.ITDApprovalViewer.mount(host, v, {
      markers,
      position,
      showProgress: !admin(),
      onDisplay: () => {
        if (seq !== openSeq || generation !== epoch) return;
        updateFooter();
        updateCorrectionChecks(v);
      },
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
    if (context?.panel) panel(context.panel);
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
    const body = rail.querySelector(".ac-rail-body");
    if (!events || !body) return;
    const history = el("details", undefined, "ac-history");
    history.append(el("summary", "Комментарии и история решений"));
    for (const e of events) {
      const item = el("article", undefined, "ac-history-event");
      item.append(el("strong", window.ITDReview.eventName(e.type)),
        el("small", `${e.actorName} · ${date(e.createdAt)} · v${e.versionNumber}`));
      if (e.body) item.append(el("p", e.body));
      history.append(item);
    }
    body.insertBefore(history, body.querySelector(".ac-properties"));
  }
  function navigate(delta) {
    const items = visible(),
      index = items.findIndex((m) => m.id === mid);
    if (items[index + delta])
      showMaterial(items[index + delta].id).catch((e) => say(e.message));
  }
  async function recordView(v, page, downloaded = false) {
    if (admin()) return;
    const res = await hooks.api(
      `/api/approval-center/versions/${v.id}/view`,
      "POST",
      downloaded ? { page, downloaded: true } : { page },
    );
    v.viewedPageNumbers = [...new Set([...(v.viewedPageNumbers || []), ...res.pages])];
    v.viewedPages = v.viewedPageNumbers.length;
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
  function disclosure(title, cls) {
    const details = el("details", undefined, cls);
    details.append(el("summary", title));
    return details;
  }
  function feedbackFor(m, v) {
    const applies = (n) => n.versionId === v.id ||
      (v.id === m.currentVersion.id && n.versionNumber < v.versionNumber) ||
      n.history?.some((e) => e.versionId === v.id && e.type === "fixed");
    return {
      markers: m.notes.filter(applies),
      comments: (m.returnComments || []).filter(applies),
    };
  }
  function generalNote(c) {
    const card = el("article", undefined, "ac-note ac-feedback-card");
    card.append(el("strong", "Замечание к версии"), el("p", c.body, "ac-note-body"),
      el("small", `${c.authorName} · ${date(c.createdAt)}`),
      el("small", `v${c.versionNumber} · Без отметки на листе`));
    return card;
  }
  function renderRail() {
    const m = current(),
      v = version();
    if (!m) return;
    const { markers, comments } = feedbackFor(m, v);
    const archived = vid !== m.currentVersion.id;
    const top = el("div", undefined, "ac-rail-top"), heading = el("div"),
      body = el("div", undefined, "ac-rail-body");
    const total = markers.length + comments.length;
    heading.append(el("h3", total ? `Замечания · ${total}` : "Замечания"),
      el("p", `${displayTitle(m)} · v${v.versionNumber}`, "ac-rail-context"));
    top.append(heading, iconButton("Закрыть панель", "×", () => panel("viewer")));
    if (admin() && !archived)
      top.append(button("Загрузить исправленную версию", uploadVersion,
        v.status === "changes_requested" ? "primary ac-upload-version" : "ac-upload-version"));
    rail.replaceChildren(top, body);
    if (archived)
      body.append(
        el(
          "p",
          "Историческая версия — только просмотр. Решение по ней сохранено.",
          "ac-warning",
        ),
        button("К текущей версии", () => showMaterial(mid)),
      );
    const noteSection = el("section", undefined, "ac-notes");
    noteSection.setAttribute("aria-label", "Замечания клиента");
    const noteList = el("div", undefined, "ac-feedback-list");
    const fill = (state) => {
      noteList.replaceChildren();
      const matchingMarkers = markers.filter(n => !state || n.status === state);
      const visibleComments = state ? [] : comments;
      const versions = [...new Set([...matchingMarkers, ...visibleComments].map(n => n.versionNumber))].sort((a, b) => b - a);
      for (const number of versions) {
        if (number !== v.versionNumber)
          noteList.append(el("h4", `Замечания к версии ${number}`, "ac-previous-feedback"));
        for (const c of visibleComments.filter(n => n.versionNumber === number)) {
          const card = generalNote(c);
          card.id = `ac-return-${c.id}`;
          if (v.id !== c.versionId) card.append(button(`Исходное замечание · версия ${c.versionNumber}`, async () => {
            await showMaterial(m.id, c.versionId);
            panel("notes");
            rail.querySelector(`#ac-return-${c.id}`)?.scrollIntoView({ block: "nearest" });
          }));
          noteList.append(card);
        }
        for (const n of matchingMarkers.filter(n => n.versionNumber === number)) noteList.append(noteCard(n));
      }
      if (!noteList.children.length)
        noteList.append(el("p", total ? "Нет замечаний с таким статусом." : "Отправленных замечаний пока нет.", "ac-rail-context"));
    };
    noteSection.append(noteList);
    if (markers.length) {
      const filters = disclosure("Фильтр по статусу отметок", "ac-note-filter");
      filters.append(select("Статус замечания", [["", "Все"],
        ...["open", "fixed", "confirmed", "reopened"].map((s) => [s, labels[s]])], "", fill));
      noteSection.append(filters);
    }
    fill("");
    body.append(noteSection);
    if (v.correction) {
      const report = JSON.parse(v.correction);
      const changes = disclosure(`Что исправлено в v${v.versionNumber}`, "ac-correction-report");
      if (report.resolutions.length !== 1 || report.description !== report.resolutions[0].explanation)
        changes.append(el("p", report.description));
      for (const item of report.resolutions) {
        const n = m.notes.find((n) => n.id === item.noteId);
        changes.append(el("p", `${n ? "Отметка " + n.number + " · v" + n.versionNumber : "Замечание"} · ${item.fixed ? "Исправлено" : "Осталось исправить"}`),
          el("p", item.explanation));
      }
      body.append(changes);
    }
    if (
      !admin() &&
      vid === m.currentVersion.id &&
      v.status === "pending_approval"
    ) {
      const d = entry(),
        conflict =
          d && (d.versionId !== vid || d.expectedRevision !== v.revision);
      if (conflict) {
        body.append(
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
      } else if (d?.comment || d?.markers.length || d?.decision) {
        const draft = el("section", undefined, "ac-draft-feedback");
        draft.append(el("strong", d.decision ? draftLabels[d.decision] : "Черновик замечания"));
        if (d.comment) draft.append(el("p", d.comment, "ac-note-body"));
        draft.append(el("small", "До отправки пакета этот черновик видите только вы."));
        if (d.comment || d.markers.length)
          draft.append(button("Изменить замечание", () => compose()));
        body.append(draft);
        if (d.decision) draft.append(
          button("Убрать черновое решение", () => removeDecision(mid)),
        );
      }
    }
    if (admin()) {
      const views = disclosure("Просмотр клиентом", "ac-view-history");
      views.append(
        el(
          "p",
          v.confirmedView
            ? "Клиент подтвердил просмотр этой версии"
            : "Просмотр ещё не подтверждён",
        ),
      );
      if (v.view?.viewed)
        views.append(
          el(
            "p",
            `Первый просмотр: ${date(v.view.firstViewedAt)} · Последний: ${date(v.view.lastViewedAt)} · Открытий: ${v.view.viewCount}`,
          ),
        );
      body.append(views);
    }
    if (admin() && !archived) {
      const properties = disclosure("Свойства материала", "ac-properties");
      if (v.status === "approved")
        properties.append(
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
      room.field.dataset.revision = m.metadataRevision;
      required.prepend(check);
      properties.append(
        room.wrap,
        required,
        button("Сохранить свойства", async () => {
          await hooks.api(
            `/api/approval-center/materials/${mid}/metadata`,
            "PATCH",
            {
              room: room.field.value,
              required: check.checked,
              expectedRevision: Number(room.field.dataset.revision),
            },
          );
          await loadScope(scope, { mid, vid });
        }),
      );
      body.insertBefore(properties, body.querySelector(".ac-view-history"));
    }
    if (archived) {
      renderHistory();
      return;
    }
    const d = entry();
    if (d?.versionId === vid)
      d.markers.forEach((n, i) =>
        body.append(
          button(`Черновик маркера ${i + 1} · стр. ${n.page}: ${n.body}`, () =>
            compose(i),
          ),
        ),
      );
    if (canDecide() && d?.markers.length)
      body.append(
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
    // Keep the discussion and history together, ahead of administrative settings.
    body.insertBefore(discussion, body.querySelector(".ac-properties"));
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
          resetFilteredSelection();
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
      if (generation === epoch && target.decision === "changes_requested") say(revisionSaved);
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
        if (!active || generation !== epoch || v.id !== vid || !viewer || viewer.failedPages.length) return;
        if (missingPage(v)) {
          incompleteVersion = v.id;
          return;
        }
        const draft = entry();
        if (hasDraftRemarks(draft)) {
          const question = draft.decision === "changes_requested"
            ? `Заменить решение «Нужны правки» на согласование для «${displayTitle(current())}»?`
            : `Согласовать «${displayTitle(current())}» вместе с черновыми замечаниями?`;
          if (!window.confirm(question + " Замечания и отметки сохранятся в пакете.")) return;
        }
        try {
          if (!(await confirmView(v))) return;
          confirmationError = null;
        } catch (error) {
          if (generation !== epoch || v.id !== vid) return;
          if (error.status && error.status < 500) throw error;
          confirmationError = v.id;
          return;
        }
      }
      if (!active || generation !== epoch || v.id !== vid) return;
      const e = entry(true);
      if (decision === "changes_requested" && !e.comment.trim())
        throw Error("Напишите замечание");
      e.decision = decision;
      advanceAfterSave = { mid, vid, decision };
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
  function missingPage(v) {
    if (v.file.contentType !== "application/pdf" || v.confirmedView) return 0;
    return firstUnseenPage(v, v.pageCount || viewer?.pageCount || 0);
  }
  function firstUnseenPage(v, count) {
    const seen = new Set(v.viewedPageNumbers);
    for (let page = 1; page <= count; page++) if (!seen.has(page)) return page;
    return 0;
  }
  function hasDraftRemarks(e) {
    return !!(e && (e.decision === "changes_requested" || e.comment.trim() || e.markers.length));
  }
  function bulkBlocker(m) {
    const v = m.currentVersion, e = data.draft.entries.find((e) => e.materialId === m.id);
    if (hasDraftRemarks(e)) return e.decision === "changes_requested"
      ? draftLabels.changes_requested : "Есть черновик замечания или отметки";
    if (data.conflicts.includes(m.id) || (e && (e.versionId !== v.id || e.expectedRevision !== v.revision)))
      return "Версия материала изменилась";
    if (v.status !== "pending_approval") return labels[v.status];
    if (!v.confirmedView && !(v.pageCount && v.viewedPages === v.pageCount))
      return "Просмотрены не все страницы";
    return "";
  }
  function bulkApprove() {
    const items = data.materials.filter((m) => selected.has(m.id));
    if (!items.length) return;
    const generation = epoch;
    const blocked = items.filter(bulkBlocker);
    if (blocked.length) {
      modal("Проверьте состав выбора", (d) => {
        d.append(el("p", "Эти материалы требуют отдельного решения. Их решения, замечания и отметки сохранятся."));
        const list = el("ul");
        for (const m of blocked) list.append(el("li", `${displayTitle(m)} · ${bulkBlocker(m)}`));
        d.append(list);
        if (blocked.length < items.length)
          d.append(button("Исключить перечисленные", () => {
            if (generation !== epoch) { d.close(); return; }
            for (const m of blocked) selected.delete(m.id);
            renderList();
            d.close();
            bulkApprove();
          }));
      });
      return;
    }
    modal("Подготовить групповое согласование", (d) => {
      d.append(el("p", `Подтвердите просмотр всех страниц и состав группы. Материалов: ${items.length}.`));
      const list = el("ul");
      for (const m of items)
        list.append(el("li", `${displayTitle(m)} · v${m.currentVersion.versionNumber}`));
      d.append(list);
      const apply = button("Подготовить решения", async () => {
        apply.disabled = true;
        try {
          const checkGroup = () => {
            if (generation !== epoch || items.length !== selected.size ||
                items.some((m) => !selected.has(m.id) || bulkBlocker(m)))
              throw Error("Состав группы или черновик изменился. Закройте сводку и проверьте выбор.");
          };
          checkGroup();
          for (const m of items) if (!(await confirmView(m.currentVersion))) return;
          checkGroup();
          for (const m of items) {
            const existing = data.draft.entries.find((e) => e.materialId === m.id);
            if (existing) existing.decision = "approved";
            else data.draft.entries.push({
              materialId: m.id, versionId: m.currentVersion.id,
              expectedRevision: m.currentVersion.revision, decision: "approved",
              comment: "", markers: [],
            });
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
      }, "primary");
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
  async function checkCorrection(m, fixedVersion) {
    // A pin locates a point only on the original drawing. Pages in a replacement
    // can have a different order, so start with its first unregistered page.
    const page = firstUnseenPage(fixedVersion, fixedVersion.pageCount || 1) || 1;
    if (vid !== fixedVersion.id || comparison || viewer?.displayError) {
      await showMaterial(m.id, fixedVersion.id, { versionId: fixedVersion.id, position: { page } });
    } else {
      if (matchMedia("(max-width: 767px)").matches) panel("viewer");
      await viewer?.ready;
      if (mid !== m.id || vid !== fixedVersion.id) return;
      viewer?.go(page);
    }
    if (mid !== m.id || vid !== fixedVersion.id) return;
    const target = matchMedia("(max-width: 767px)").matches ? "viewer" : "notes";
    if (root.dataset.mobile !== target) panel(target);
  }
  function updateCorrectionCheck(box, v) {
    const total = v.pageCount || viewer?.pageCount || 0;
    const missing = firstUnseenPage(v, total);
    // Only the server registration supplies pageCount and the accepted page numbers.
    const complete = !!v.pageCount && !missing;
    const failed = !complete && !!viewer?.failedPages.length;
    const supported = window.ITDViewer.supported(v.file);
    const pdf = v.file.contentType === "application/pdf";
    const status = box.querySelector(".ac-correction-progress");
    let message;
    if (complete) {
      message = `Просмотр исправленной версии ${v.versionNumber} сохранён.`;
    } else if (failed) {
      message = `Не удалось сохранить просмотр версии ${v.versionNumber}. Повторите сохранение.`;
    } else if (viewer?.displayError) {
      message = "Не удалось отобразить исправленный файл. Нажмите «Проверить исправление», чтобы открыть его заново.";
    } else if (pdf) {
      message = `Для подтверждения просмотрите все страницы исправленной версии ${v.versionNumber}.`;
      if (total) message += ` Просмотрено ${v.viewedPageNumbers?.length || 0} из ${total}.`;
      if (missing) message += ` Следующий лист — ${missing}.`;
    } else {
      message = supported ? "Откройте исправленное изображение и дождитесь сохранения просмотра."
        : "Скачайте исправленный оригинал и сообщите, когда проверите его.";
    }
    if (status.textContent !== message) status.textContent = message;
    box.querySelector(".ac-confirm-note").disabled = !complete;
    box.querySelector(".ac-retry-note-view").hidden = !failed;
    const original = box.querySelector(".ac-check-original");
    if (original) original.hidden = complete;
  }
  function updateCorrectionChecks(v) {
    if (v.id !== vid || admin()) return;
    rail?.querySelectorAll(".ac-correction-check").forEach(box => updateCorrectionCheck(box, v));
  }
  function noteAction(n, type, label) {
    const m = current(), v = version();
    if (!m || !v || v.id !== m.currentVersion.id) return;
    const confirm = type === "confirmed";
    if (confirm && (admin() || n.status !== "fixed" || n.correctionVersionId !== v.id ||
        !v.pageCount || firstUnseenPage(v, v.pageCount))) return;
    const pid = project.id, stageId = scope, materialId = m.id, versionId = v.id,
      noteId = n.id, expectedRevision = n.revision;
    modal(label, (dialog) => {
      if (confirm) dialog.append(
        el("p", `Замечание №${n.number} · ${displayTitle(m)} · исправленная версия ${v.versionNumber}`),
        el("p", n.body, "ac-note-body"),
        el("p", `Ответ студии: ${n.correctionExplanation}`),
        el("p", "Вы подтверждаете исправление этого замечания. Решение по материалу принимается отдельно."),
      );
      const text = input("Пояснение", "textarea");
      const errorMessage = el("p", "", "ac-dialog-error");
      errorMessage.setAttribute("role", "alert");
      errorMessage.hidden = true;
      const reload = button("Открыть актуальное исправление", async () => {
        if (!active || project?.id !== pid || scope !== stageId) {
          dialog.close();
          return;
        }
        await flush();
        dialog.close();
        await loadScope(stageId, { mid: materialId, panel: "notes" });
        rail?.querySelector(`#ac-note-${noteId}`)?.scrollIntoView({ block: "nearest" });
      });
      reload.hidden = true;
      const save = button("Сохранить в истории", async () => {
        if (save.disabled) return;
        save.disabled = true;
        errorMessage.hidden = true;
        try {
          const currentNote = current()?.notes.find(item => item.id === noteId);
          if (!active || project?.id !== pid || mid !== materialId || vid !== versionId ||
              current()?.currentVersion.id !== versionId || currentNote?.revision !== expectedRevision) {
            errorMessage.textContent = "Версия или замечание изменились. Откройте актуальное исправление.";
            errorMessage.hidden = false;
            reload.hidden = false;
            return;
          }
          await hooks.api(`/api/approval-center/notes/${noteId}/events`, "POST",
            { type, body: text.field.value, expectedRevision, versionId });
          dialog.close();
          if (active && project?.id === pid && scope === stageId && mid === materialId) {
            await flush();
            await loadScope(stageId, { mid: materialId, vid: versionId, panel: "notes" });
          }
        } catch (error) {
          errorMessage.textContent = error.message;
          errorMessage.hidden = false;
          reload.hidden = error.status !== 409;
        } finally {
          save.disabled = !reload.hidden;
        }
      });
      dialog.append(text.wrap, save, errorMessage, reload);
    });
  }
  function noteCard(n) {
    const m = current(), v = version(), archived = v.id !== m.currentVersion.id;
    const corrected = m.versions.find(item => item.id === n.correctionVersionId);
    const card = el("article", undefined, "ac-note ac-feedback-card");
    card.id = `ac-note-${n.id}`;
    card.tabIndex = -1;
    const heading = el("div", undefined, "ac-note-heading");
    const state = el("span", labels[n.status], "ac-note-state");
    state.dataset.status = n.status;
    heading.append(el("strong", `Замечание клиента №${n.number}`), state);
    card.append(heading, el("p", n.body, "ac-note-body"),
      el("small", `${n.authorName} · ${date(n.createdAt)}`));
    if (corrected) {
      card.append(el("small", `Исходная отметка: лист ${n.page} · версия ${n.versionNumber}`),
        button(`Проверить исправление · версия ${corrected.versionNumber}`, () => checkCorrection(m, corrected), "ac-check-fix"),
        button(`Исходное замечание · версия ${n.versionNumber}`, () => focusNote(n), "ac-locate-note"));
    } else {
      card.append(button(`Показать на листе ${n.page} · v${n.versionNumber}`, () => focusNote(n), "ac-locate-note"));
    }
    const lastReply = n.history.filter((e) => e.type !== "open" || e.body !== n.body).at(-1);
    if (corrected) {
      const fix = el("div", undefined, "ac-note-reply");
      fix.append(el("strong", `Исправление студии · версия ${corrected.versionNumber}`), el("p", n.correctionExplanation));
      card.append(fix);
    }
    if (lastReply && !(corrected && lastReply.type === "fixed" && lastReply.versionId === corrected.id)) {
      const reply = el("div", undefined, "ac-note-reply");
      const author = lastReply.actorRole === "admin" ? "Ответ студии" : "Ответ клиента";
      reply.append(el("strong", lastReply.versionNumber ? `${author} · версия ${lastReply.versionNumber}` : author),
        el("p", lastReply.body));
      card.append(reply);
    }
    const history = el("details");
    history.append(el("summary", "История замечания"));
    for (const e of n.history)
      history.append(
        el(
          "p",
          `${date(e.createdAt)} · ${e.actorName} · ${window.ITDReview.eventName("annotation_" + e.type)}\n${e.body}`,
        ),
      );
    if (archived) {
      card.append(history);
      return card;
    }
    const controls = el("div", undefined, "ac-note-actions");
    if (!admin() && n.status === "fixed" && corrected?.id === v.id) {
      const box = el("div", undefined, "ac-correction-check");
      const progress = el("p", "", "ac-correction-progress");
      progress.setAttribute("role", "status");
      box.append(progress);
      if (!window.ITDViewer.supported(v.file)) {
        const original = el("div", undefined, "ac-check-original");
        const download = el("a", "Скачать исправленный оригинал");
        download.href = `/api/files/${v.file.id}/download`;
        download.download = v.file.name;
        original.append(download, button("Я проверил скачанный оригинал", async () => {
          await recordView(v, 1, true);
          updateCorrectionChecks(v);
        }));
        box.append(original);
      }
      box.append(button("Повторить сохранение", () => viewer?.retryViews(), "ac-retry-note-view"),
        button("Подтвердить исправление", () => noteAction(n, "confirmed", "Подтвердить исправление"), "primary ac-confirm-note"));
      updateCorrectionCheck(box, v);
      card.append(box);
    } else if (!admin() && n.status === "fixed") {
      card.append(el("p", "Для подтверждения нужен ответ студии об исправлении в актуальной версии."));
    }
    const actions = admin()
      ? [
          ["reply", "Ответить"],
          ...(["open", "reopened"].includes(n.status) ? [["fixed", "Отметить исправленным"]] : []),
        ]
      : [
          ["reply", "Дополнить"],
          ...(n.status !== "open" ? [["open", "Оставить открытым"]] : []),
          ...(n.status !== "reopened" ? [["reopened", "Повторная доработка"]] : []),
        ];
    for (const [type, label] of actions)
      controls.append(button(label, () => noteAction(n, type, label)));
    card.append(controls, history);
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
          for (const c of m.returnComments || []) {
            const activeReturn = c.versionId === m.currentVersion.id && m.currentVersion.status === "changes_requested";
            if (status && !(status === "active" && activeReturn)) continue;
            const card = generalNote(c);
            card.prepend(el("h3", displayTitle(m)));
            card.append(button("Открыть замечание", async () => {
              dialog.close();
              await showMaterial(m.id, c.versionId);
              panel("notes");
              rail.querySelector(`#ac-return-${c.id}`)?.scrollIntoView({ block: "nearest" });
            }));
            rows.append(card);
          }
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
                await focusNote(n, true);
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
    if (details) {
      const filter = rail.querySelector(".ac-notes select");
      if (filter?.value && filter.value !== n.status) {
        filter.value = "";
        filter.dispatchEvent(new Event("change"));
      }
      rail.querySelector(".ac-feedback-card.is-focused")?.classList.remove("is-focused");
      const card = rail.querySelector(`#ac-note-${n.id}`);
      card?.classList.add("is-focused");
      card?.focus({ preventScroll: true });
      card?.scrollIntoView({ block: "nearest" });
    }
  }
  function appendViewFeedback() {
    const v = version();
    if (!v || admin() || !viewer) return;
    const failed = viewer.failedPages;
    const missing = incompleteVersion === v.id && missingPage(v);
    if (!failed.length && confirmationError !== v.id && !missing) return;
    const box = el("div", undefined, "ac-view-feedback");
    box.setAttribute("role", "status");
    if (failed.length || confirmationError === v.id) {
      const text = failed.length
        ? `Не удалось сохранить просмотр. Страницы: ${failed.join(", ")}.`
        : "Не удалось сохранить подтверждение просмотра.";
      box.append(el("strong", text), button("Повторить сохранение просмотра", () =>
        failed.length ? viewer.retryViews() : decide("approved"),
      ));
    } else {
      const count = v.pageCount || viewer.pageCount;
      box.append(
        el("strong", `Чтобы согласовать материал, просмотрите все страницы. Просмотрено ${v.viewedPages} из ${count}. Осталось ${count - v.viewedPages}`),
        button("Открыть непросмотренную страницу", () => viewer.go(missing)),
      );
    }
    footer.append(box);
  }
  function updateFooter() {
    if (!footer || !data) return;
    renderSummary();
    footer.replaceChildren();
    appendViewFeedback();
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
                say("");
                await finishSave();
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
        notesButton(v.status === "changes_requested" || m.notes.length || m.returnComments?.length
          ? "Открыть замечания" : admin() ? "Работа с материалом" : "Замечания и история"),
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
            draftLabels[e.decision],
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
            await hooks.refresh();
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
      const state = data.stage, stageRoute = route(), operationId = newOperationId();
      d.append(
        el(
          "p",
          state.approved
            ? "Этап уже согласован или завершён."
            : "Согласование файлов само по себе не завершает этап.",
        ),
      );
      for (const b of state.blockers) d.append(el("p", b));
      if (!admin() && !state.approved && !state.blockers.length && (!current() || vid === current().currentVersion.id)) {
        const accept = button("Подтверждаю согласование этапа", async () => {
          if (accept.disabled) return;
          accept.disabled = true;
          try {
            await hooks.api(stageRoute + "/approve-stage", "POST", {
              operationId, token: state.token, confirm: true,
            });
            d.close();
            await hooks.refresh();
          } finally {
            accept.disabled = false;
          }
        }, "primary");
        d.append(accept);
      }
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
      onPosition: (p) => syncPos(comparison, p),
      showProgress: !admin(),
      onDisplay: () => {
        if (!active || v.id !== vid) return;
        updateFooter();
        updateCorrectionChecks(v);
      },
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
    const rightPreview = viewer, leftPreview = comparison;
    await Promise.all([rightPreview.ready, leftPreview.ready]);
    if (rightPreview !== viewer || leftPreview !== comparison) return;
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
    const m = current(), v = m.currentVersion;
    if (!admin() || vid !== v.id) return;
    const destination = {
      ...window.ITDUploads.contextOf(project),
      stageId: m.stageId, materialId: m.id, expectedVersionId: v.id,
    };
    const pending = m.notes.filter((n) => n.status !== "confirmed");
    modal("Отправить исправленную версию", (dialog) => {
      dialog.classList.add("ac-version-dialog");
      const form = el("form", undefined, "ac-version-form");
      const fields = el("div", undefined, "ac-version-fields");
      const stage = project.stages.find((s) => s.id === m.stageId);
      const context = el("div", undefined, "ac-version-context");
      context.append(el("h3", displayTitle(m)), el("p",
        `${stage ? "Этап «" + stage.title + "»" : "Без этапа"} · Версия ${v.versionNumber} → ${v.versionNumber + 1}`));
      const receiver = el("div");
      receiver.append(el("p"), el("p"));
      context.append(receiver);
      const file = input("Файл новой версии", "file");
      file.field.name = "file";
      file.field.required = true;
      fields.append(context, file.wrap);
      const general = (m.returnComments || []).filter((c) => c.versionId === v.id);
      if (general.length || pending.length) fields.append(el("h3", "Замечания клиента"));
      for (const c of general) fields.append(generalNote(c));
      const rows = pending.map((n) => {
        const group = el("fieldset", undefined, "ac-resolution");
        group.append(el("legend", `Отметка ${n.number} · лист ${n.page} · v${n.versionNumber}`),
          el("p", n.body, "ac-note-body"));
        const choices = el("div", undefined, "ac-resolution-options");
        const fixed = input("Исправлено", "radio");
        const open = input("Осталось исправить", "radio");
        fixed.field.value = "fixed";
        open.field.value = "open";
        const explanation = input("Ответ по замечанию", "textarea");
        explanation.field.maxLength = 4000;
        explanation.field.required = true;
        explanation.field.rows = 2;
        for (const [choice, prompt] of [[fixed, "Что исправлено"], [open, "Почему замечание остаётся открытым"]]) {
          choice.field.name = `resolution-${n.id}`;
          choice.field.required = true;
          choice.wrap.prepend(choice.field);
          choice.field.addEventListener("change", () => {
            explanation.wrap.firstChild.textContent = prompt;
            explanation.field.setAttribute("aria-label", prompt);
          });
          choices.append(choice.wrap);
        }
        group.append(choices, explanation.wrap);
        fields.append(group);
        return { n, fixed: fixed.field, explanation: explanation.field };
      });
      const description = input(rows.length ? "Другие изменения в файле (необязательно)" : "Что изменено", "textarea");
      description.field.maxLength = 4000;
      description.field.rows = 2;
      description.field.required = !rows.length;
      if (rows.length) {
        const otherChanges = disclosure("Добавить другие изменения", "ac-additional-changes");
        otherChanges.append(description.wrap);
        fields.append(otherChanges);
      } else fields.append(description.wrap);
      const actions = el("div", undefined, "ac-version-actions");
      const status = el("p", `Клиент получит версию ${v.versionNumber + 1} для повторной проверки.`, "ac-version-status");
      status.setAttribute("role", "status");
      const send = el("button", "Отправить новую версию", "primary");
      send.type = "submit";
      actions.append(status, send);
      form.append(fields, actions);
      dialog.append(form);
      window.ITDUploads.register(form, { context: () => destination, receiver });
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (send.disabled) return;
        const resolutions = rows.map(({ n, fixed, explanation }) => ({
          noteId: n.id, fixed: fixed.checked, explanation: explanation.value.trim(),
        }));
        const emptyAnswer = rows.find(({ explanation }) => !explanation.value.trim());
        if (emptyAnswer || (!rows.length && !description.field.value.trim())) {
          status.textContent = emptyAnswer ? "Напишите ответ по замечанию." : "Опишите изменения в файле.";
          (emptyAnswer?.explanation || description.field).focus();
          return;
        }
        const fixedCount = resolutions.filter((r) => r.fixed).length;
        const summary = description.field.value.trim() || (resolutions.length === 1 ? resolutions[0].explanation :
          `Исправлено отметок: ${fixedCount}. Осталось исправить: ${resolutions.length - fixedCount}.`);
        send.disabled = true;
        status.textContent = "Отправляем файл…";
        try {
          const result = await window.ITDUploads.send(form, {
            category: "result", stageId: m.stageId, materialId: m.id, expectedVersionId: v.id,
            correctionReport: { description: summary, resolutions },
          });
          if (result) {
            dialog.close();
            await hooks.refresh();
            await loadScope(m.stageId || 0, { mid: m.id });
            say("Исправленная версия отправлена клиенту.");
          }
        } catch (error) {
          status.textContent = error.message;
        } finally {
          send.disabled = false;
        }
      });
    });
  }
  async function open(id, requested, back, options = {}) {
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
        panel: options.panel,
      });
      return true;
    } finally {
      if (pendingOpen === token) pendingOpen = null;
    }
  }
  function captureView() {
    if (!viewer) return lastViewContext;
    const discussion = rail.querySelector(".ac-discussion");
    const comment = discussion?.querySelector("textarea").value || "";
    const room = rail.querySelector('input[aria-label="Помещение"]');
    const required = rail.querySelector('input[type="checkbox"]');
    const properties = room && required && (room.value !== current().room || required.checked !== current().required)
      ? { room: room.value, required: required.checked, revision: room.dataset.revision }
      : null;
    return {
      mid,
      vid: comment || vid !== current()?.currentVersion.id ? vid : undefined,
      context: {
        versionId: vid, position: viewer.position, panel: root.dataset.mobile,
        scroll: listHost.scrollTop, railScroll: rail.querySelector(".ac-rail-body")?.scrollTop || 0,
        discussionOpen: !!discussion?.open, comment, properties,
        historyOpen: !!rail.querySelector(".ac-history")?.open,
        noteFilter: rail.querySelector(".ac-notes select")?.value,
        openSections: ["ac-note-filter", "ac-properties", "ac-view-history", "ac-correction-report"]
          .filter((cls) => rail.querySelector("." + cls)?.open),
      },
    };
  }
  async function refreshView() {
    const target = captureView() || { mid };
    await flush();
    if (active && !pendingOpen && !root?.hasAttribute("data-opening-stage")) await loadScope(scope, target);
  }
  async function onTab(tab, requestedStage) {
    if (pendingOpen) return;
    if (active && tab !== "review") lastViewContext = captureView();
    active = tab === "review";
    if (root) root.hidden = !active;
    document.getElementById("app-view").inert = active && !!root;
    if (!active) {
      if (root?.hasAttribute("data-opening-stage"))
        finishScope(root.dataset.openingStage, data ? scope : root.dataset.openingStage);
      const leaving = viewer;
      await flush();
      if (!active && viewer === leaving) stopPreview();
      return;
    }
    if (!project) return;
    if (requestedStage != null && (!data || requestedStage !== scope)) {
      await changeScope(requestedStage);
      return;
    }
    if (root && data) {
      await refreshView();
      return;
    }
    build();
    await loadScope(window.ITDProjectState.selectedStage(project.stages)?.id ?? 0);
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

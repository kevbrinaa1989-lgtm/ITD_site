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
  const route = () =>
    `/api/approval-center/projects/${project.id}/stages/${scope}`;
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
    saveStatus.textContent = "Сохраняем черновик…";
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
          saveStatus.textContent =
            dirty === saved
              ? "Черновик сохранён на сервере"
              : "Есть несохранённые изменения";
        } catch (e) {
          saveError = e;
          saveStatus.textContent = "Не сохранено — повторите сохранение";
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
    root?.remove();
    root = null;
    project = null;
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
  function build() {
    if (root) return;
    root = el("section", undefined, "approval-center");
    root.id = "approval-center";
    root.setAttribute("aria-label", "Центр согласования");
    const panel = document.getElementById("panel-review");
    panel.classList.add("ac-enabled");
    panel.append(root);
    const head = el("header", undefined, "ac-head"),
      intro = el("div");
    intro.append(
      el("p", "ITD STUDIO / РЕШЕНИЯ ПО ПРОЕКТУ", "eyebrow"),
      el("h2", "Центр согласования"),
      el(
        "p",
        "Просмотрите материалы, подготовьте решения и отправьте один пакет.",
      ),
    );
    const tools = el("div", undefined, "ac-head-tools");
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
    tools.append(
      stagePicker,
      button("История и ведомости", showPackages),
      button("Обновить данные", async () => {
        if (saveError?.status === 409) {
          recoverDraft();
          return;
        }
        await flush();
        await loadScope(scope);
      }),
      button("Восстановление черновиков", recoverDraft),
    );
    if (admin())
      tools.append(
        button("Очередь замечаний", showNoteQueue),
        button("Направить материалы на согласование", publishFiles),
      );
    head.append(intro, tools);
    notice = el("p", "", "ac-notice");
    notice.setAttribute("role", "status");
    saveStatus = el(
      "span",
      admin() ? "Режим студии" : "Черновик сохранён на сервере",
    );
    const work = el("div", undefined, "ac-work"),
      left = el("aside", undefined, "ac-list-pane");
    const search = input("Поиск материала", "search");
    search.field.oninput = () => {
      query = search.field.value.toLocaleLowerCase("ru-RU");
      renderList();
    };
    left.append(
      search.wrap,
      select(
        "Показывать",
        [
          ["all", "Все материалы"],
          ["pending_approval", "Ожидают решения"],
          ["approved", "Согласованы"],
          ["changes_requested", "На доработке"],
          ["new", "Проверить исправления"],
          ["notes", "С замечаниями"],
          ["draft", "Подготовленные решения"],
          ["fixed", "Исправлено дизайнером"],
          ["open", "Открытые замечания"],
        ],
        filter,
        (v) => {
          filter = v;
          renderList();
        },
      ),
      button("Сетка / список", () => listHost.classList.toggle("ac-grid")),
    );
    const bulk = el("div", undefined, "ac-bulk");
    if (!admin())
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
    left.append(bulk);
    listHost = el("div", undefined, "ac-list");
    left.append(listHost);
    viewHost = el("section", undefined, "ac-view-pane");
    let swipe;
    viewHost.addEventListener(
      "touchstart",
      (e) => {
        swipe =
          e.touches.length === 1 &&
          !e.target.closest("button,input,select,.ac-pin-mode")
            ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
            : null;
      },
      { passive: true },
    );
    viewHost.addEventListener(
      "touchend",
      (e) => {
        if (swipe && viewer?.zoom === 1 && !comparison) {
          const dx = e.changedTouches[0].clientX - swipe.x,
            dy = e.changedTouches[0].clientY - swipe.y;
          if (Math.abs(dx) > 80 && Math.abs(dx) > Math.abs(dy) * 2)
            navigate(dx < 0 ? 1 : -1);
        }
        swipe = null;
      },
      { passive: true },
    );
    rail = el("aside", undefined, "ac-rail");
    work.append(left, viewHost, rail);
    const mobile = el("div", undefined, "ac-mobile-tools");
    mobile.append(
      button("Материалы", () => {
        root.dataset.mobile = "list";
      }),
      button("Просмотр", () => {
        root.dataset.mobile = "viewer";
      }),
      button("Замечания и решение", () => {
        root.dataset.mobile = "notes";
      }),
    );
    footer = el("footer", undefined, "ac-footer");
    summaryHost = el("div", undefined, "ac-summary");
    root.append(head, notice, summaryHost, mobile, work, footer);
    root.dataset.mobile = "viewer";
    root.addEventListener("keydown", (e) => {
      if (
        e.target.closest("input,textarea,select,dialog") ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey
      )
        return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        navigate(1);
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        navigate(-1);
      }
    });
  }
  async function loadScope(s, target) {
    const pid = project.id,
      generation = ++epoch;
    scope = s;
    dirty = saved = 0;
    saveError = null;
    operation = null;
    selected.clear();
    stopPreview();
    build();
    stagePicker.querySelector("select").value = scope;
    saveStatus.textContent = admin() ? "Режим студии" : "Загрузка черновика…";
    const result = await hooks.api(route());
    if (generation !== epoch || project?.id !== pid) return;
    data = result;
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
      : "Черновик сохранён на сервере";
    say(
      result.conflicts.length
        ? "Есть черновики по изменённым версиям. Откройте каждый конфликт и проверьте новую версию."
        : "",
    );
    renderList();
    await showMaterial(mid, vid);
    updateFooter();
  }
  const visible = () =>
    !data
      ? []
      : data.materials
          .filter((m) => {
            const d = data.draft.entries.find((e) => e.materialId === m.id),
              v = m.currentVersion;
            return (
              (!query ||
                [m.title, m.room, ...m.versions.map((v) => v.file.name)]
                  .join(" ")
                  .toLocaleLowerCase("ru-RU")
                  .includes(query)) &&
              (filter === "all" ||
                filter === v.status ||
                (filter === "draft" && !!d) ||
                (filter === "new" &&
                  v.versionNumber > 1 &&
                  v.status === "pending_approval") ||
                (filter === "notes" && m.notes.length > 0) ||
                (filter === "fixed" &&
                  m.notes.some((n) => n.status === "fixed")) ||
                (filter === "open" &&
                  m.notes.some((n) => ["open", "reopened"].includes(n.status))))
            );
          })
          .sort((a, b) => a.room.localeCompare(b.room, "ru") || a.id - b.id);
  function renderSummary() {
    if (!summaryHost || !data) return;
    summaryHost.replaceChildren();
    const ms = data.materials;
    for (const [key, label, count] of [
      ["all", "Материалов", ms.length],
      [
        "approved",
        "Согласовано",
        ms.filter((m) => m.currentVersion.status === "approved").length,
      ],
      [
        "changes_requested",
        "На доработке",
        ms.filter((m) => m.currentVersion.status === "changes_requested")
          .length,
      ],
      [
        "new",
        "Проверить исправления",
        ms.filter(
          (m) =>
            m.currentVersion.versionNumber > 1 &&
            m.currentVersion.status === "pending_approval",
        ).length,
      ],
      [
        "fixed",
        "Замечания исправлены",
        ms.reduce(
          (n, m) => n + m.notes.filter((x) => x.status === "fixed").length,
          0,
        ),
      ],
      [
        "open",
        "Замечания открыты",
        ms.reduce(
          (n, m) =>
            n +
            m.notes.filter((x) => ["open", "reopened"].includes(x.status))
              .length,
          0,
        ),
      ],
    ])
      summaryHost.append(
        button(`${label}: ${count}`, () => {
          filter = key;
          root.querySelector('select[aria-label="Показывать"]').value = key;
          renderList();
          root.dataset.mobile = "list";
        }),
      );
    if (data.packages.length)
      summaryHost.append(
        el(
          "p",
          `Последний отправленный раунд: №${data.packages[0].roundNumber}`,
        ),
      );
  }
  function renderList() {
    if (!data || !listHost) return;
    renderSummary();
    window.ITDApprovalThumbnails.clear(listHost);
    window.ITDViewer.releaseWithin(listHost);
    listHost.replaceChildren();
    let room;
    for (const m of visible()) {
      if (room !== m.room) {
        room = m.room;
        listHost.append(el("h3", room || "Без помещения", "ac-room"));
      }
      const row = el("article", undefined, "ac-material");
      row.classList.toggle("is-selected", m.id === mid);
      row.dataset.materialId = m.id;
      if (!admin()) {
        const check = el("input");
        check.type = "checkbox";
        check.checked = selected.has(m.id);
        check.setAttribute("aria-label", `Выбрать ${m.title}`);
        check.onchange = () =>
          check.checked ? selected.add(m.id) : selected.delete(m.id);
        row.append(check);
      }
      const v = m.currentVersion,
        open = button("", () => showMaterial(m.id), "ac-material-open"),
        d = data.draft.entries.find((e) => e.materialId === m.id);
      open.append(
        window.ITDApprovalThumbnails.mount(v.file),
        el("strong", displayTitle(m)),
        el(
          "span",
          `${v.file.contentType === "application/pdf" ? "PDF" : v.file.name.split(".").pop().toUpperCase()} · v${v.versionNumber} · ${v.confirmedView ? "Просмотр подтверждён" : "Проверьте материал"}`,
        ),
        el(
          "span",
          d?.decision ? `Черновик: ${labels[d.decision]}` : labels[v.status],
        ),
      );
      open.append(
        el(
          "span",
          m.required ? "Обязательный материал" : "Дополнительный материал",
        ),
      );
      if (m.notes.length)
        open.append(
          el(
            "span",
            `Замечания: ${m.notes.length} · исправлено: ${m.notes.filter((n) => n.status === "fixed").length}`,
          ),
        );
      if (v.versionNumber > 1 && v.status === "pending_approval")
        open.append(el("span", "Новая версия", "ac-badge"));
      if (data.conflicts.includes(m.id))
        open.append(el("span", "Конфликт черновика", "ac-error"));
      row.append(open);
      listHost.append(row);
    }
    if (!visible().length)
      listHost.append(el("p", "Материалов в этой выборке нет."));
  }
  async function showMaterial(id, requested) {
    if (!id) {
      viewHost.replaceChildren(
        el("p", "В этом разделе ещё нет материалов для согласования."),
      );
      rail.replaceChildren();
      return;
    }
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
      heading = el("div", undefined, "ac-view-heading");
    heading.append(
      el("h3", displayTitle(m)),
      el("p", `${v.file.name} · v${v.versionNumber} · ${labels[v.status]}`),
    );
    if (returnToLibrary) {
      heading.append(
        button(
          "← Файлы проекта",
          async () => {
            await flush();
            const back = returnToLibrary;
            returnToLibrary = null;
            stopPreview();
            back();
          },
          "review-library-back",
        ),
      );
      heading.querySelector(".review-library-back").dataset.libraryReturn =
        "true";
    }
    heading.append(
      button("← Предыдущий", () => navigate(-1)),
      button("Следующий →", () => navigate(1)),
      select(
        "Версия",
        m.versions.map((v) => [
          v.id,
          `v${v.versionNumber} · ${date(v.createdAt)}`,
        ]),
        vid,
        (v) => showMaterial(mid, +v),
      ),
    );
    if (m.versions.length > 1)
      heading.append(button("Было / Стало", () => compare()));
    viewHost.append(heading);
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
      editable:
        !admin() &&
        vid === m.currentVersion.id &&
        v.status === "pending_approval",
      onPage: async (page) => {
        if (admin()) return;
        try {
          await hooks.api(
            `/api/approval-center/versions/${v.id}/view`,
            "POST",
            { page },
          );
        } catch (e) {
          if (seq === openSeq) say(e.message);
        }
      },
      onMarker: (n) => {
        if (n.id) {
          focusNote(n);
          return;
        }
        if (
          admin() ||
          vid !== m.currentVersion.id ||
          v.status !== "pending_approval"
        ) {
          say(
            "Новые замечания доступны клиенту для текущей версии, ожидающей решения.",
          );
          return;
        }
        editMarker(n);
      },
      onPosition: (pos) => {
        if (generation !== epoch || seq !== openSeq || admin()) return;
        data.draft.position = { materialId: mid, versionId: vid, ...pos };
        change();
      },
    });
    if (!admin()) {
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
  async function confirmView() {
    const v = version();
    await viewer?.confirmReady();
    if (
      !window.ITDViewer.supported(v.file) &&
      !window.confirm("Вы скачали оригинал и проверили его содержание?")
    )
      return;
    if (!window.ITDViewer.supported(v.file))
      await hooks.api(`/api/approval-center/versions/${v.id}/view`, "POST", {
        page: 1,
        downloaded: true,
      });
    await hooks.api(`/api/approval-center/versions/${v.id}/view`, "POST", {
      confirm: true,
    });
    v.confirmedView = true;
    renderRail();
    renderList();
    say("Просмотр этой версии подтверждён. Можно подготовить согласование.");
  }
  function renderRail() {
    const m = current(),
      v = version();
    if (!m) return;
    rail.replaceChildren();
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
      } else {
        rail.append(
          el("h3", "Подготовить решение"),
          button(
            v.confirmedView
              ? "Просмотр подтверждён"
              : "Я проверил(а) все страницы",
            confirmView,
          ),
        );
        const note = input("Пояснение дизайнеру", "textarea", d?.comment || "");
        note.field.maxLength = 4000;
        note.field.oninput = () => {
          entry(true).comment = note.field.value;
          change();
        };
        rail.append(note.wrap);
        const actions = el("div", undefined, "ac-decisions");
        const approve = button(
          "Согласовать",
          () => decide("approved"),
          "primary",
        );
        approve.disabled = !v.confirmedView;
        actions.append(
          approve,
          button("На доработку", () => decide("changes_requested")),
          button("Пропустить", () => navigate(1)),
          button("Убрать черновое решение", () => {
            const e = entry();
            if (e) {
              e.decision = null;
              change();
              renderRail();
              renderList();
            }
          }),
        );
        rail.append(
          actions,
          el(
            "p",
            "Это черновик. Решение станет окончательным после отправки пакета.",
            "ac-help",
          ),
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
            editMarker({ ...n, draft: true, index: i }),
          ),
        ),
      );
    const comment = input("Комментарий к версии", "textarea");
    comment.field.maxLength = 4000;
    rail.append(
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
    renderHistory();
  }
  function decide(decision) {
    const v = version(),
      e = entry(true);
    if (e.versionId !== vid) throw Error("Проверьте конфликт черновика");
    if (decision === "approved" && !v.confirmedView)
      throw Error("Подтвердите просмотр");
    if (decision === "changes_requested" && !e.comment.trim())
      throw Error("Напишите обязательное пояснение");
    e.decision = decision;
    change();
    renderRail();
    renderList();
    navigate(1);
  }
  function bulkApprove() {
    const items = data.materials.filter((m) => selected.has(m.id));
    if (!items.length) throw Error("Выберите материалы");
    if (
      items.some(
        (m) =>
          !m.currentVersion.confirmedView ||
          m.currentVersion.status !== "pending_approval" ||
          data.conflicts.includes(m.id),
      )
    )
      throw Error(
        "Проверьте все выбранные материалы. Нельзя согласовать непросмотренную, конфликтующую или уже решённую версию.",
      );
    modal("Подготовить групповое согласование", (d) => {
      d.append(
        el(
          "p",
          `Будут подготовлены черновики для ${items.length} просмотренных материалов.`,
        ),
        button("Подготовить решения", () => {
          for (const m of items) {
            let e = data.draft.entries.find((e) => e.materialId === m.id);
            if (!e) {
              e = {
                materialId: m.id,
                versionId: m.currentVersion.id,
                expectedRevision: m.currentVersion.revision,
                decision: null,
                comment: "",
                markers: [],
              };
              data.draft.entries.push(e);
            }
            e.decision = "approved";
          }
          change();
          selected.clear();
          renderList();
          renderRail();
          d.close();
        }),
      );
    });
  }
  function editMarker(n) {
    const d = entry(true);
    if (d.versionId !== vid)
      throw Error("Сначала разрешите конфликт черновика");
    modal(n.draft ? "Черновое замечание" : "Новое замечание", (dialog) => {
      const note = input("Текст замечания", "textarea", n.body);
      note.field.maxLength = 4000;
      const x = input(
          "Положение по горизонтали, %",
          "number",
          Math.round(n.x * 100),
        ),
        y = input("Положение по вертикали, %", "number", Math.round(n.y * 100));
      x.field.min = y.field.min = 0;
      x.field.max = y.field.max = 100;
      dialog.append(
        el("p", `Версия ${version().versionNumber}, страница ${n.page}`),
        note.wrap,
        x.wrap,
        y.wrap,
        button("Сохранить черновик", () => {
          if (!note.field.value.trim()) throw Error("Напишите замечание");
          const marker = {
            page: n.page,
            x: Math.max(0, Math.min(1, +x.field.value / 100)),
            y: Math.max(0, Math.min(1, +y.field.value / 100)),
            body: note.field.value,
          };
          if (n.draft) d.markers[n.index] = marker;
          else d.markers.push(marker);
          change();
          dialog.close();
          refreshMarkers();
          renderRail();
        }),
      );
      if (n.draft)
        dialog.append(
          button("Удалить черновой маркер", () => {
            d.markers.splice(n.index, 1);
            change();
            dialog.close();
            refreshMarkers();
            renderRail();
          }),
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
  async function focusNote(n) {
    if (n.versionId !== vid) {
      await showMaterial(mid, n.versionId);
    }
    viewer?.focusMarker(n);
    document
      .getElementById(`ac-note-${n.id}`)
      ?.scrollIntoView({ block: "nearest" });
  }
  function updateFooter() {
    if (!footer || !data) return;
    footer.replaceChildren();
    const entries = data.draft.entries,
      a = entries.filter((e) => e.decision === "approved").length,
      c = entries.filter((e) => e.decision === "changes_requested").length;
    const summary = el("div");
    summary.append(
      el("strong", `Подготовлено: ${a} согласований · ${c} на доработку`),
      saveStatus,
    );
    footer.append(summary);
    if (!admin())
      footer.append(
        button("Сохранить сейчас", flush),
        button("Проверить и отправить", submit, "primary"),
      );
    footer.append(button("Готовность этапа", showStage));
  }
  async function submit() {
    await flush();
    if (saveError) throw saveError;
    const entries = data.draft.entries.filter(
      (e) => e.decision || e.markers.length || e.comment.trim(),
    );
    if (!entries.length) throw Error("Нет подготовленных решений");
    const a = entries.filter((e) => e.decision === "approved").length,
      c = entries.filter((e) => e.decision === "changes_requested").length;
    modal("Отправить пакет решений?", (d) => {
      d.append(
        el(
          "p",
          `Согласовать: ${a}. На доработку: ${c}. Без решения в этом пакете: ${data.materials.length - a - c}. Отправленные решения сохранятся в истории.`,
        ),
      );
      for (const e of entries)
        d.append(
          el(
            "p",
            `${data.materials.find((m) => m.id === e.materialId)?.title} · ${labels[e.decision] || "Только замечания"} · маркеров ${e.markers.length}`,
          ),
        );
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
                operationId: crypto.randomUUID(),
                expectedRevision: data.draft.revision,
                confirm: true,
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
                operationId: crypto.randomUUID(),
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
      editable: false,
      markers: m.notes.filter((n) => n.versionId === previous.id),
      onMarker: focusNote,
      onPosition: (p) => syncPos(viewer, p),
    });
    viewer = window.ITDApprovalViewer.mount(rh, v, {
      editable: false,
      markers: m.notes.filter((n) => n.versionId === v.id),
      onMarker: focusNote,
      onPosition: (p) => syncPos(comparison, p),
      onPage: (p) => {
        if (!admin())
          hooks
            .api(`/api/approval-center/versions/${v.id}/view`, "POST", {
              page: p,
            })
            .catch((e) => say(e.message));
      },
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
  }
  async function publishFiles() {
    const result = await hooks.api(
      `/api/projects/${project.id}/files?stageId=${scope || "none"}&category=result`,
    );
    const files = result.files.filter((f) => !f.review),
      chosen = new Set(),
      operationId = crypto.randomUUID();
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
      if (root) root.dataset.mobile = "notes";
      rail?.scrollIntoView({ block: "nearest" });
    },
  };
})();

"use strict";
(() => {
  const node = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const labels = {
    planned: "Не начат",
    in_progress: "В работе",
    pending_approval: "Нужно решение",
    changes_requested: "На доработку",
    approved: "Согласован",
    completed: "Завершён",
  };
  const active = (project) => !["Архив", "Завершён"].includes(project.status);
  // Editorial artwork is independent of uploaded project files and stage order.
  const stageArtwork = (stage) => {
    const title = String(stage?.title || "")
      .toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
    const patterns = [
      [/^обмер/, "01"],
      [/^планировоч/, "02"],
      [/^концепц/, "03"],
      [/^визуализац/, "04"],
      [/^(?:техническое описание|техническая документация|рабочая документация)/, "05"],
      [/^(?:спецификац|комплектац|ведомость материалов)/, "06"],
      [/^(?:авторский надзор|авторское сопровождение)/, "07"],
    ];
    return patterns.find(([pattern]) => pattern.test(title))?.[1] || null;
  };
  const materialTitle = (value) =>
    String(value || "Материал").replace(
      /\.(pdf|jpe?g|png|webp|gif|svg|dwg|dxf|docx?|xlsx?|pptx?|txt|zip|rar|7z)$/i,
      "",
    );
  function button(text, action, cls = "text-button") {
    const b = node("button", text, cls);
    b.type = "button";
    b.addEventListener("click", () =>
      Promise.resolve()
        .then(action)
        .catch((error) => {
          const message = document.getElementById("status-message");
          message.textContent = error.message;
          message.classList.add("is-error");
        }),
    );
    return b;
  }
  function date(value) {
    if (!value) return "";
    const [y, m, d] = value.slice(0, 10).split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
    });
  }
  function progress(project) {
    const state = window.ITDProjectState.progress(project.stages);
    const box = node("div", undefined, "route-progress");
    const meta = node("div", undefined, "route-progress-meta");
    meta.append(
      node("span", "Согласовано или завершено"),
      node("strong", state.total ? `${state.percent}%` : "—"),
    );
    const bar = node("progress");
    bar.max = state.total || 1;
    bar.value = state.accepted;
    bar.setAttribute("aria-label", state.label);
    box.append(
      meta,
      bar,
      node(
        "p",
        `${state.accepted} из ${state.total} этапов`,
        "route-progress-count",
      ),
      node("p", state.detail, "route-progress-detail"),
    );
    return box;
  }
  function journey(project, actions, selectedStageId = null) {
    const root = node("div", undefined, "project-journey"),
      stages = project.stages || [];
    const underway = stages.filter((s) =>
      ["in_progress", "pending_approval", "changes_requested"].includes(
        s.status,
      ),
    );
    // Selecting a card is a view-only action, not a workflow state change.
    const currentStage = window.ITDProjectState.currentStage(stages);
    const stage = window.ITDProjectState.selectedStage(stages, selectedStageId);
    const isPreview = !!stage && stage.id !== currentStage?.id;
    const stageFiles = window.ITDProjectFiles.select(window.ITDProjectFiles.entries(project),
      { stage: stage ? String(stage.id) : "unassigned", sort: "oldest" });
    const stageMaterials = stageFiles.filter((entry) => entry.file.category === "result");
    const waiting = active(project) ? stageMaterials.filter((m) => m.status === "pending_approval") : [];
    const suggested = waiting[0] || stageMaterials.at(-1);
    const alreadyFeatured = actions.featuredMaterialId != null &&
      suggested?.file.review?.materialId === actions.featuredMaterialId;
    const chosen = alreadyFeatured ? null : suggested?.file;
    const needsDecision =
      chosen?.review?.status === "pending_approval" && active(project);
    const state = window.ITDProjectState.progress(stages);
    const strip = node("div", undefined, "route-strip");
    strip.setAttribute("aria-label", "Маршрут проекта");
    stages.forEach((s, i) => {
      const b = button("", () => actions.openStage(s.id), "route-step");
      b.dataset.status = s.status;
      b.classList.toggle("is-current", s.id === stage?.id);
      b.dataset.workflowCurrent = String(s.id === currentStage?.id);
      b.setAttribute("aria-pressed", String(s.id === stage?.id));
      b.append(node("strong", String(i + 1).padStart(2, "0")));
      b.title = `${s.title} — ${labels[s.status] || s.status}`;
      const text = node("span");
      text.append(node("span", s.title, "route-step-title"));
      text.append(node("small", labels[s.status] || s.status));
      b.append(text);
      strip.append(b);
    });
    if (stages.length) root.append(strip);
    else
      root.append(
        node(
          "p",
          "Этапы проекта появятся после подготовки плана студией.",
          "empty-note",
        ),
      );
    const card = node("section", undefined, "route-feature"),
      head = node("div", undefined, "route-feature-head");
    const stageHeading = node("div", undefined, "route-stage-heading");
    stageHeading.append(
      node(
        "span",
        stage ? String(stages.indexOf(stage) + 1).padStart(2, "0") : "—",
        "route-stage-number",
      ),
    );
    const title = node("div");
    title.append(
      node(
        "p",
        isPreview ? "Просмотр этапа" : active(project) ? "Сейчас в проекте" : "История проекта",
        "eyebrow",
      ),
      node(
        "h2",
        stage?.title || (state.approved ? "Этапы согласованы" : project.status),
      ),
    );
    stageHeading.append(title);
    head.append(
      stageHeading,
      node(
        "span",
        waiting.length
          ? `${actions.admin ? "Ожидают решения клиента" : "Ждут вашего решения"} · ${waiting.length}`
          : active(project)
            ? "Решений не требуется"
            : project.status,
        "badge",
      ),
    );
    card.append(head);
    const body = node("div", undefined, "route-feature-body");
    const artwork = stageArtwork(stage);
    const visual = node("div");
    const showPlaceholder = () => {
      visual.classList.add("route-feature-placeholder");
      visual.append(
        node("span", stage ? String(stages.indexOf(stage) + 1).padStart(2, "0") : "ITD"),
        node("p", "От идеи — к пространству"),
      );
    };
    if (artwork) {
      visual.className = "route-feature-image route-stage-artwork";
      const image = node("img");
      image.addEventListener("error", () => {
        image.hidden = true;
        showPlaceholder();
      }, { once: true });
      image.src = `/assets/stages/${artwork}.webp`;
      image.alt = `Условная иллюстрация этапа «${stage.title}»`;
      image.decoding = "async";
      image.loading = "lazy";
      visual.append(image);
    } else {
      showPlaceholder();
    }
    body.append(visual);
    const copy = node("div", undefined, "route-feature-copy");
    copy.append(
      node("p", needsDecision ? "Следующий шаг" : "Ваш проект", "eyebrow"),
      node(
        "h3",
        chosen
          ? suggested.title
          : stage?.title ||
              (state.approved
                ? "Ожидается завершение этапов студией"
                : "Все доступные материалы — в альбоме проекта"),
      ),
    );
    copy.append(
      node(
        "p",
        needsDecision
          ? (actions.admin ? "Текущая версия ожидает решения клиента." : "Посмотрите текущую версию и сообщите, всё ли вам подходит.")
          : (!stage && state.approved
              ? "Согласование зафиксировано. Студия отметит завершение этапов после выполнения всех работ."
              : stage?.description) ||
              "Все доступные материалы и документы собраны в разделах проекта.",
        "muted",
      ),
    );
    if (stage?.plannedEndDate)
      copy.append(
        node(
          "p",
          "Срок этапа — " + date(stage.plannedEndDate),
          "route-deadline",
        ),
      );
    if (chosen?.review)
      copy.append(
        button(
          needsDecision && !actions.admin ? "Посмотреть и решить →" : "Открыть материал →",
          () => actions.openMaterial(chosen),
          "primary",
        ),
        node(
          "p",
          `Версия ${chosen.review.versionNumber} · ${chosen.name}`,
          "file-meta",
        ),
      );
    else
      copy.append(
        button(
          stage ? "Материалы этапа →" : "Материалы без этапа →",
          () => actions.openTab("results", { stageId: stage?.id ?? null }),
          "primary",
        ),
      );
    if (chosen && !chosen.review)
      copy.append(node("p", chosen.name, "file-meta"));
    copy.querySelector("h3").title = copy.querySelector("h3").textContent;
    copy.querySelector(".file-meta")?.setAttribute("title", chosen?.name || "");
    const links = node("div", undefined, "route-links");
    const scope = stage ? "этапа" : "без этапа";
    const imageCount = stageMaterials.filter((entry) => window.ITDViewer.image(entry.file)).length;
    const shortcuts = [
      [`Материалы ${scope}`, `Все форматы · ${stageMaterials.length}`, "results"],
      [`Документы ${scope}`, `Документов · ${stageFiles.filter((entry) => entry.document).length}`, "documents"],
    ];
    if (imageCount) shortcuts.push([`Альбом ${scope}`, `Только изображения · ${imageCount}`, "results", true]);
    for (const [title, description, tab, album = false] of shortcuts) {
      const item = node("section", undefined, "panel");
      const heading = node("h2");
      const open = button("", () => actions.openTab(tab, { stageId: stage?.id ?? null, album }), "route-shortcut");
      open.setAttribute("aria-label", `Открыть: ${title}`);
      open.setAttribute("aria-description", description);
      const arrow = node("span", "→", "route-shortcut-arrow");
      arrow.setAttribute("aria-hidden", "true");
      open.append(node("span", title), node("small", description), arrow);
      heading.append(open);
      item.append(heading);
      links.append(item);
    }
    body.append(links);
    card.append(body);
    if (chosen || stage?.description?.trim() || stage?.plannedEndDate) {
      const details = node("div", undefined, "route-feature-details");
      details.append(copy);
      card.append(details);
    }
    root.append(card);
    for (const s of underway.filter((s) => s.id !== stage?.id)) {
      const parallel = button(
        "",
        () => actions.openStage(s.id),
        "route-parallel",
      );
      parallel.append(
        node("span", String(stages.indexOf(s) + 1).padStart(2, "0")),
        node("strong", s.title),
        node(
          "small",
          (underway.length > 1 ? "Параллельно · " : "") +
            (labels[s.status] || s.status),
        ),
      );
      root.append(parallel);
    }

    return root;
  }
  let shellUser = null,
    shellTab = null,
    selectTab = null;
  function closeMenu() {
    document.body.classList.remove("menu-open");
    document
      .getElementById("mobile-menu-button")
      ?.setAttribute("aria-expanded", "false");
  }
  function placeNavigation() {
    const nav = document.getElementById("studio-navigation"),
      host = document.getElementById("shell-navigation-host"),
      sidebar = document.querySelector(".project-sidebar");
    if (!nav || !host) return;
    const horizontal =
      shellUser?.role === "client" && matchMedia("(min-width: 1101px)").matches;
    if (horizontal) host.append(nav);
    else sidebar.insertBefore(nav, sidebar.querySelector(".sidebar-bottom"));
    nav.setAttribute(
      "aria-orientation",
      horizontal ? "horizontal" : "vertical",
    );
  }
  function syncShell(user, tab, inProject, select) {
    shellUser = user;
    shellTab = tab;
    selectTab = select;
    document.body.dataset.role = user?.role || "guest";
    document.body.dataset.section = tab || "";
    document.body.classList.toggle("authenticated", !!user);
    placeNavigation();
    const bottom = document.getElementById("mobile-bottom-nav");
    if (!bottom) return;
    bottom.replaceChildren();
    if (!user) return;
    const items =
      user.role === "admin"
        ? [
            ["Главная", "workspace", "◫"],
            ["Проекты", "projects", "▦"],
            ["Клиенты", "clients", "♙"],
            ["Задачи", "tasks", "≡"],
          ]
        : [
            ["Главная", "client-home", "⌂"],
            ["Проекты", "client-projects", "▦"],
            ["Решения", "client-review", "✓"],
            ["Профиль", "profile", "○"],
          ];
    for (const [label, key, icon] of items) {
      const b = button("", () => select(key));
      b.dataset.shellTab = key;
      b.setAttribute(
        "aria-current",
        tab === key || (inProject && key.endsWith("projects"))
          ? "page"
          : "false",
      );
      b.append(node("span", icon), node("small", label));
      bottom.append(b);
    }
  }
  function toggleMenu() {
    const open = !document.body.classList.contains("menu-open");
    document.body.classList.toggle("menu-open", open);
    document
      .getElementById("mobile-menu-button")
      .setAttribute("aria-expanded", String(open));
    if (open)
      document
        .querySelector("#studio-navigation button:not([hidden])")
        ?.focus();
  }
  document.addEventListener("keydown", (e) => {
    if (!document.body.classList.contains("menu-open")) return;
    if (e.key === "Escape") {
      closeMenu();
      document.getElementById("mobile-menu-button")?.focus();
    }
    if (e.key === "Tab") {
      const controls = [
          ...document.querySelectorAll(
            ".project-sidebar a,.project-sidebar button,#mobile-menu-button",
          ),
        ].filter((n) => n.getClientRects().length && !n.disabled),
        first = controls[0],
        last = controls.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  });
  window.addEventListener("resize", () => {
    placeNavigation();
    if (innerWidth > 1100) closeMenu();
  });
  document.addEventListener("DOMContentLoaded", () =>
    document
      .getElementById("shell-menu-backdrop")
      ?.addEventListener("click", () => {
        closeMenu();
        document.getElementById("mobile-menu-button").focus();
      }),
  );
  window.ITDUI = {
    node,
    button,
    active,
    materialTitle,
    materialLabel: window.ITDProjectState.materialLabel,
    date,
    progress,
    journey,
    syncShell,
    toggleMenu,
  };
})();

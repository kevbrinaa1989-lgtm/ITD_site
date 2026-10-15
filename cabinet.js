"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const statuses = {
    planned: "Запланирован",
    in_progress: "В работе",
    completed: "Завершён",
  };
  let user = null,
    projects = [],
    selectedId = null;
  const projectTabs = new Map();
  let activeTab = "overview";
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  let messageTimer;
  const message = (text, error = false) => {
    clearTimeout(messageTimer);
    const el = $("status-message");
    el.textContent = text;
    el.classList.toggle("is-error", error);
    el.setAttribute("role", error ? "alert" : "status");
    if (text && !error)
      messageTimer = setTimeout(() => {
        el.textContent = "";
      }, 5000);
  };
  const showAuth = () => {
    clearTimeout(messageTimer);
    user = null;
    projects = [];
    selectedId = null;
    projectTabs.clear();
    activeTab = "overview";
    for (const id of [
      "user-avatar",
      "project-count",
      "overview-stage-count",
      "overview-file-count",
      "overview-progress-text",
      "overview-next-stage",
      "overview-next-action",
    ])
      if ($(id)) $(id).textContent = "";
    if ($("project-progress")) {
      $("project-progress").value = 0;
      $("project-progress").setAttribute("aria-label", "Готовность проекта");
    }
    for (const id of ["overview-stage-preview", "overview-recent-files"])
      $(id)?.replaceChildren();
    document.querySelectorAll("[data-tab-panel]").forEach((el) => {
      el.hidden = true;
    });
    $("admin-panel").hidden = true;
    $("status-message").textContent = "";
    $("login-view").hidden = false;
    $("app-view").hidden = true;
    $("user-name").textContent = "";
    $("user-role").textContent = "";
    for (const id of [
      "project-list",
      "stage-list",
      "result-list",
      "document-list",
    ])
      $(id).replaceChildren();
    for (const id of ["project-title", "project-client", "project-status"])
      $(id).textContent = "";
    $("create-project-form")
      .elements.namedItem("clientId")
      .replaceChildren(new Option("Выберите клиента", ""));
    $("upload-file-form")
      .elements.namedItem("stageId")
      .replaceChildren(new Option("Без привязки к этапу", ""));
    for (const id of [
      "create-project-form",
      "add-stage-form",
      "upload-file-form",
    ])
      $(id).reset();
  };
  async function api(path, method = "GET", data) {
    const requestUser = user;
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers:
        method === "GET"
          ? {}
          : { "Content-Type": "application/json", "X-ITD-Request": "1" },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    const result = await response.json().catch(() => ({}));
    if (user !== requestUser)
      throw new Error("Сессия изменилась. Повторите действие.");
    if (!response.ok) {
      if (response.status === 401 && user) showAuth();
      throw new Error(
        result.error || result.message || `Ошибка запроса (${response.status})`,
      );
    }
    return result;
  }
  async function busy(container, action) {
    if (container.dataset.busy) return;
    container.dataset.busy = "true";
    container.setAttribute("aria-busy", "true");
    const controls = [
      ...container.querySelectorAll("button, input, select, textarea"),
    ].map((el) => [el, el.disabled]);
    controls.forEach(([el]) => {
      el.disabled = true;
    });
    try {
      await action();
    } catch (error) {
      message(error.message || "Не удалось выполнить действие", true);
    } finally {
      controls.forEach(([el, disabled]) => {
        el.disabled = disabled;
      });
      delete container.dataset.busy;
      container.removeAttribute("aria-busy");
    }
  }
  function bindForm(id, action) {
    const form = $(id);
    if (form)
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(form));
        busy(form, () => action(values, form));
      });
  }
  function empty(list, text) {
    list.replaceChildren(node("p", text, "empty-note"));
  }
  function selectTab(tab) {
    if (tab === "management" && user?.role !== "admin") tab = "overview";
    activeTab = tab;
    if (selectedId !== null) projectTabs.set(selectedId, tab);
    document.querySelectorAll("[data-tab]").forEach((button) => {
      const adminOnly = button.dataset.tab === "management";
      button.hidden = adminOnly && user?.role !== "admin";
      const selected = button.dataset.tab === tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.classList.toggle("is-active", selected);
    });
    document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
      panel.hidden =
        panel.dataset.tabPanel !== tab ||
        (tab === "management" && user?.role !== "admin");
    });
    $("admin-panel").hidden = tab !== "management" || user?.role !== "admin";
  }
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
    item.append(icon, info, download(file));
    if (admin) {
      const button = node("button", "Удалить", "file-delete");
      button.type = "button";
      button.setAttribute("aria-label", `Удалить файл ${file.name}`);
      button.addEventListener("click", () => {
        if (window.confirm(`Удалить файл «${file.name}»?`))
          busy(item, async () => {
            await api(`/api/files/${file.id}`, "DELETE", {});
            await refresh();
            message("Файл удалён");
          });
      });
      item.append(button);
    }
    return item;
  }
  function stageEditor(stage) {
    const details = node("details", undefined, "stage-edit");
    details.append(node("summary", "Редактировать этап"));
    const form = node("form", undefined, "stage-edit-form");
    const title = node("input");
    title.name = "title";
    title.value = stage.title;
    title.required = true;
    title.maxLength = 200;
    title.setAttribute("aria-label", "Название этапа");
    const status = node("select");
    status.name = "status";
    status.setAttribute("aria-label", "Статус этапа");
    for (const [value, label] of Object.entries(statuses))
      status.add(new Option(label, value));
    status.value = stage.status;
    const description = node("textarea");
    description.name = "description";
    description.value = stage.description;
    description.maxLength = 10000;
    description.setAttribute("aria-label", "Описание этапа");
    const save = node("button", "Сохранить этап");
    save.type = "submit";
    form.append(title, status, description, save);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      busy(form, async () => {
        await api(`/api/stages/${stage.id}`, "PATCH", values);
        await refresh();
        message("Этап обновлён");
      });
    });
    details.append(form);
    return details;
  }
  function render() {
    const admin = user.role === "admin";
    if ($("user-avatar"))
      $("user-avatar").textContent = user.name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part[0])
        .join("")
        .toUpperCase();
    if ($("project-count"))
      $("project-count").textContent = String(projects.length);
    $("project-list").replaceChildren();
    for (const p of projects) {
      const button = node("button", undefined, "project-item");
      button.type = "button";
      button.append(
        node("span", p.title, "project-item-title"),
        node(
          "span",
          `${p.status} · Этапов: ${p.stages.length}`,
          "project-item-meta",
        ),
      );
      button.setAttribute("aria-pressed", String(p.id === selectedId));
      button.addEventListener("click", () => {
        selectedId = p.id;
        activeTab = projectTabs.get(p.id) || "overview";
        render();
      });
      $("project-list").append(button);
    }
    const project = projects.find((p) => p.id === selectedId);
    $("empty-state").hidden = !!project || admin;
    $("project-content").hidden = !project;
    for (const id of ["add-stage-form", "upload-file-form"])
      $(id).hidden = !project;
    selectTab(!project && admin ? "management" : activeTab);
    if (!project) {
      document.querySelectorAll("[data-tab]").forEach((button) => {
        button.hidden = button.dataset.tab !== "management" || !admin;
      });
      return;
    }
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.hidden = button.dataset.tab === "management" && !admin;
    });
    $("project-title").textContent = project.title;
    $("project-client").textContent =
      `${project.clientName} · ${project.clientEmail}`;
    $("project-status").textContent = project.status;
    const completed = project.stages.filter(
      (stage) => stage.status === "completed",
    ).length;
    const progress = project.stages.length
      ? Math.round((completed / project.stages.length) * 100)
      : 0;
    const current =
      project.stages.find((stage) => stage.status === "in_progress") ||
      project.stages.find((stage) => stage.status === "planned");
    const setText = (id, value) => {
      if ($(id)) $(id).textContent = value;
    };
    setText("overview-stage-count", `${completed} из ${project.stages.length}`);
    setText("overview-file-count", String(project.files.length));
    setText(
      "overview-progress-text",
      project.stages.length ? `${progress}%` : "Нет этапов",
    );
    if ($("project-progress")) {
      $("project-progress").value = progress;
      $("project-progress").setAttribute(
        "aria-label",
        `Завершено этапов: ${completed} из ${project.stages.length}`,
      );
    }
    setText(
      "overview-next-stage",
      current?.title ||
        (project.stages.length
          ? "Все этапы завершены"
          : "Этапы ещё не добавлены"),
    );
    setText(
      "overview-next-action",
      current
        ? admin
          ? "Статус меняется в разделе «Этапы проекта», материалы добавляются в «Управлении»."
          : "Посмотрите описание текущего этапа и доступные материалы."
        : project.stages.length
          ? "Все этапы завершены. Доступные результаты и документы можно скачать в соответствующих разделах."
          : admin
            ? "Добавьте этап проекта в разделе «Управление»."
            : "Новые этапы и материалы появятся здесь после публикации студией.",
    );
    const preview = $("overview-stage-preview");
    if (preview) {
      preview.replaceChildren();
      if (current)
        preview.append(
          node("span", statuses[current.status], "stage-status"),
          node("p", current.description || "Описание этапа пока не добавлено."),
        );
    }
    const recent = $("overview-recent-files");
    if (recent) {
      recent.replaceChildren();
      for (const file of project.files.slice(-3).reverse())
        recent.append(fileRow(file, project));
      if (!project.files.length) empty(recent, "Материалы пока не загружены.");
    }
    $("stage-list").replaceChildren();
    const stageSelect = $("upload-file-form").elements.namedItem("stageId");
    stageSelect.replaceChildren(new Option("Без привязки к этапу", ""));
    project.stages.forEach((stage, index) => {
      stageSelect.add(new Option(stage.title, String(stage.id)));
      const item = node(
        "article",
        undefined,
        `stage-card stage-${stage.status}`,
      );
      const number = node("span", String(index + 1), "stage-number");
      number.setAttribute("aria-hidden", "true");
      const content = node("div", undefined, "stage-body");
      content.append(
        node("h3", stage.title),
        node("p", statuses[stage.status] || stage.status, "stage-status"),
        node("p", stage.description || "Описание этапа пока не добавлено."),
      );
      const results = project.files.filter(
        (file) => file.stageId === stage.id && file.category === "result",
      );
      if (results.length) {
        const links = node("div", undefined, "stage-results");
        for (const file of results) links.append(download(file, file.name));
        content.append(links);
      }
      if (admin) content.append(stageEditor(stage));
      item.append(number, content);
      $("stage-list").append(item);
    });
    if (!project.stages.length)
      empty($("stage-list"), "Этапы пока не добавлены.");
    for (const [category, id] of [
      ["result", "result-list"],
      ["document", "document-list"],
    ]) {
      const list = $(id);
      list.replaceChildren();
      for (const file of project.files.filter(
        (file) => file.category === category,
      ))
        list.append(fileRow(file, project, admin));
      if (!list.childElementCount)
        empty(
          list,
          category === "result"
            ? "Результаты пока не загружены."
            : "Документы пока не загружены.",
        );
    }
  }
  async function refresh() {
    const currentUser = user;
    const result = await api("/api/projects");
    if (!user || user !== currentUser) return;
    projects = result.projects;
    if (!projects.some((p) => p.id === selectedId))
      selectedId = projects[0]?.id ?? null;
    render();
  }
  async function refreshClients() {
    if (user?.role !== "admin") return;
    const currentUser = user;
    const { clients } = await api("/api/clients");
    if (!user || user !== currentUser) return;
    const select = $("create-project-form").elements.namedItem("clientId");
    const previous = select.value;
    select.replaceChildren(
      new Option(
        clients.length
          ? "Выберите клиента"
          : "Пока нет зарегистрированных клиентов",
        "",
      ),
    );
    for (const client of clients)
      select.add(
        new Option(`${client.name} (${client.email})`, String(client.id)),
      );
    if (clients.some((client) => String(client.id) === previous))
      select.value = previous;
  }
  async function enter(nextUser) {
    user = nextUser;
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    $("user-name").textContent = user.name;
    $("user-role").textContent =
      user.role === "admin" ? "Администратор" : "Клиент";
    await refresh();
    await refreshClients();
  }
  function authTab(register) {
    $("login-form").hidden = register;
    $("register-form").hidden = !register;
    $("show-login").setAttribute("aria-pressed", String(!register));
    $("show-register").setAttribute("aria-pressed", String(register));
    $("auth-heading").textContent = register
      ? "Создать аккаунт"
      : "Вход в проект";
    $("login-error").textContent = "";
    $("register-error").textContent = "";
  }
  const mobileTabs = window.matchMedia("(max-width: 760px)");
  function orientTabs() {
    document
      .querySelectorAll('[role="tablist"]')
      .forEach((list) =>
        list.setAttribute(
          "aria-orientation",
          mobileTabs.matches ? "horizontal" : "vertical",
        ),
      );
  }
  orientTabs();
  mobileTabs.addEventListener("change", orientTabs);
  document.querySelectorAll("[data-open-tab]").forEach((button) =>
    button.addEventListener("click", () => {
      selectTab(button.dataset.openTab);
      document.querySelector(`[data-tab="${button.dataset.openTab}"]`)?.focus();
    }),
  );
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => selectTab(button.dataset.tab));
    button.addEventListener("keydown", (event) => {
      if (
        ![
          "ArrowLeft",
          "ArrowRight",
          "ArrowUp",
          "ArrowDown",
          "Home",
          "End",
        ].includes(event.key)
      )
        return;
      const tabs = [...document.querySelectorAll("[data-tab]")].filter(
        (tab) => !tab.hidden,
      );
      const index = tabs.indexOf(button);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (index +
                (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : -1) +
                tabs.length) %
              tabs.length;
      event.preventDefault();
      tabs[next].focus();
      selectTab(tabs[next].dataset.tab);
    });
  });
  $("show-login").addEventListener("click", () => authTab(false));
  $("show-register").addEventListener("click", () => authTab(true));
  for (const [id, endpoint] of [
    ["login-form", "/api/login"],
    ["register-form", "/api/register"],
  ])
    bindForm(id, async (values, form) => {
      const errorElement = $(
        id === "register-form" ? "register-error" : "login-error",
      );
      errorElement.textContent = "";
      try {
        const result = await api(endpoint, "POST", values);
        form.reset();
        await enter(result.user);
        message("Вы вошли в личный кабинет");
      } catch (error) {
        errorElement.textContent = error.message;
        throw error;
      }
    });
  $("refresh-button")?.addEventListener("click", () =>
    busy($("app-view"), async () => {
      await refresh();
      await refreshClients();
      message("Данные обновлены");
    }),
  );
  $("logout-button").addEventListener("click", () =>
    busy($("app-view"), async () => {
      await api("/api/logout", "POST", {});
      showAuth();
      message("Вы вышли из кабинета");
    }),
  );
  bindForm("create-project-form", async (values, form) => {
    const result = await api("/api/projects", "POST", {
      title: values.title,
      clientId: Number(values.clientId),
    });
    selectedId = result.id;
    form.reset();
    await refresh();
    message("Проект создан");
  });
  bindForm("add-stage-form", async (values, form) => {
    if (!selectedId) throw new Error("Выберите проект");
    await api(`/api/projects/${selectedId}/stages`, "POST", values);
    form.reset();
    await refresh();
    message("Этап добавлен");
  });
  bindForm("upload-file-form", async (values, form) => {
    if (!selectedId) throw new Error("Выберите проект");
    const projectId = selectedId;
    const uploadUser = user;
    const file = values.file;
    if (!(file instanceof File) || !file.size)
      throw new Error("Выберите непустой файл");
    if (file.size > 10 * 1024 * 1024)
      throw new Error("Размер файла не должен превышать 10 МБ");
    const types = {
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      txt: "text/plain",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      zip: "application/zip",
    };
    const contentType = types[file.name.split(".").pop().toLowerCase()];
    if (!contentType)
      throw new Error(
        "Допустимые форматы: PDF, PNG, JPG, WEBP, TXT, DOCX, XLSX, ZIP",
      );
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
      reader.readAsDataURL(file);
    });
    if (user !== uploadUser) return;
    await api(`/api/projects/${projectId}/files`, "POST", {
      name: file.name,
      contentType,
      data,
      category: values.category,
      ...(values.stageId ? { stageId: Number(values.stageId) } : {}),
    });
    form.reset();
    await refresh();
    message("Файл загружен");
  });
  api("/api/me")
    .then((result) => enter(result.user))
    .catch((error) => {
      showAuth();
      if (error.message !== "Войдите в кабинет") message(error.message, true);
    });
})();

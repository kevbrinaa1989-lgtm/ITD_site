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
    clearRecovery();
    window.ITDViewer?.invalidate();
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
    const hasProject = projects.some((project) => project.id === selectedId);
    if (["management", "recovery"].includes(tab) && user?.role !== "admin")
      tab = "overview";
    activeTab = tab;
    if (selectedId !== null) projectTabs.set(selectedId, tab);
    document.querySelectorAll("[data-tab]").forEach((button) => {
      const adminOnly = ["management", "recovery"].includes(button.dataset.tab);
      button.hidden = adminOnly ? user?.role !== "admin" : !hasProject;
      const selected = button.dataset.tab === tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.classList.toggle("is-active", selected);
    });
    document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
      panel.hidden =
        panel.dataset.tabPanel !== tab ||
        (["management", "recovery"].includes(tab) && user?.role !== "admin");
    });
    $("admin-panel").hidden = tab !== "management" || user?.role !== "admin";
    if (tab === "recovery" && user?.role === "admin") refreshRecovery();
    $("project-content").hidden = !hasProject || tab === "recovery";
    $("empty-state").hidden = hasProject || user?.role === "admin";
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
    item.append(icon, info);
    if (window.ITDViewer?.supported(file))
      item.append(window.ITDViewer.control(file, project.files));
    item.append(download(file));
    if (admin) item.append(deleteFileButton(file, item));
    return item;
  }
  function deleteFileButton(file, container) {
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
        window.ITDViewer?.invalidate();
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
    selectTab(
      !project && admin && activeTab !== "recovery" ? "management" : activeTab,
    );
    if (!project) {
      document.querySelectorAll("[data-tab]").forEach((button) => {
        button.hidden =
          !["management", "recovery"].includes(button.dataset.tab) || !admin;
      });
      return;
    }
    document.querySelectorAll("[data-tab]").forEach((button) => {
      button.hidden =
        ["management", "recovery"].includes(button.dataset.tab) && !admin;
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
        for (const file of results) {
          if (window.ITDViewer?.supported(file))
            links.append(
              window.ITDViewer.control(file, project.files, file.name),
            );
          else links.append(download(file, file.name));
        }
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
      const categoryFiles = project.files.filter(
        (file) => file.category === category,
      );
      if (category === "result") {
        const groups = new Map();
        for (const file of categoryFiles.filter((file) =>
          window.ITDViewer?.image(file),
        )) {
          const key = file.stageId ?? "unassigned";
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(file);
        }
        for (const [stageId, files] of groups) {
          const section = node("section", undefined, "gallery-section");
          const stage = project.stages.find((stage) => stage.id === stageId);
          section.append(node("h3", stage?.title || "Без привязки к этапу"));
          const gallery = node("div", undefined, "material-gallery");
          for (const file of files) {
            const card = window.ITDViewer.thumbnail(file, files);
            const actions = node("div", undefined, "gallery-actions");
            actions.append(download(file));
            if (admin) actions.append(deleteFileButton(file, card));
            card.append(actions);
            gallery.append(card);
          }
          section.append(gallery);
          list.append(section);
        }
      }
      for (const file of categoryFiles) {
        if (category === "result" && window.ITDViewer?.image(file)) continue;
        list.append(fileRow(file, project, admin));
      }
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
    window.ITDViewer?.invalidate();
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
    clearRecovery();
    user = nextUser;
    if (user.role === "admin")
      recoveryTimer = setInterval(() => {
        if (activeTab !== "recovery") return;
        const current = recoveryCurrent?.request;
        if (
          current &&
          current.status === "approved" &&
          recoveryStatus(current) === "expired"
        ) {
          current.status = "expired";
          const listed = recoveryRequests.find(
            (item) => item.id === current.id,
          );
          if (listed) listed.status = "expired";
          recoveryLinks.delete(current.id);
          renderRecoveryList();
          renderRecoveryDetail();
        }
      }, 1000);
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    $("user-name").textContent = user.name;
    $("user-role").textContent =
      user.role === "admin" ? "Администратор" : "Клиент";
    await refresh();
    await refreshClients();
  }
  function authTab(register) {
    $("recovery-auth").hidden = true;
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
  const recoveryStatuses = {
    new: "Новый",
    approved: "Одобрен",
    used: "Использован",
    expired: "Истёк",
    rejected: "Отклонён",
  };
  const recoveryEvents = {
    requested: "Запрос получен",
    viewed: "Просмотрен",
    approved: "Запрос одобрен",
    issued: "Ссылка создана",
    reissued: "Создана новая ссылка",
    rejected: "Отклонён",
    copied: "Ссылка скопирована",
    used: "Пароль изменён",
    expired: "Срок ссылки истёк",
    superseded: "Прежняя ссылка аннулирована",
  };
  let recoveryEpoch = 0,
    recoverySelection = null,
    recoveryDetailVersion = 0;
  let recoveryRequests = [],
    recoveryCurrent = null,
    recoveryTimer;
  const recoveryLinks = new Map();
  const recoveryBase = "/api/admin/password-recovery/requests";
  const recoveryDate = (value) =>
    value ? new Date(value).toLocaleString("ru-RU") : "—";
  const recoveryStatus = (request) =>
    request.status === "approved" &&
    request.expiresAt &&
    Date.parse(request.expiresAt) <= Date.now()
      ? "expired"
      : request.status;
  function clearRecovery() {
    recoveryEpoch++;
    recoveryDetailVersion++;
    recoverySelection = null;
    recoveryCurrent = null;
    recoveryRequests = [];
    recoveryLinks.clear();
    clearInterval(recoveryTimer);
    $("recovery-list").replaceChildren();
    $("recovery-detail").replaceChildren(
      node("p", "Выберите запрос, чтобы посмотреть подробности.", "muted"),
    );
    $("recovery-admin-message").textContent = "";
    $("recovery-request-message").textContent = "";
    $("recovery-request-form").reset();
    $("recovery-auth").hidden = true;
  }
  function renderRecoveryList() {
    const list = $("recovery-list");
    list.replaceChildren();
    if (!recoveryRequests.length) {
      empty(list, "Запросов на восстановление пока нет.");
      return;
    }
    for (const request of recoveryRequests) {
      const button = node("button", undefined, "recovery-request");
      button.type = "button";
      button.setAttribute(
        "aria-pressed",
        String(request.id === recoverySelection),
      );
      button.append(
        node("strong", request.clientName || "Аккаунт не найден"),
        node("span", request.email, "recovery-email"),
        node(
          "span",
          `${recoveryStatuses[recoveryStatus(request)] || request.status} · ${recoveryDate(request.createdAt)}`,
          "recovery-meta",
        ),
      );
      button.addEventListener("click", () => loadRecoveryDetail(request.id));
      list.append(button);
    }
  }
  async function refreshRecovery() {
    if (user?.role !== "admin") return;
    const epoch = recoveryEpoch;
    $("recovery-admin-message").textContent = "Загрузка запросов…";
    try {
      const result = await api(recoveryBase);
      if (epoch !== recoveryEpoch || user?.role !== "admin") return;
      recoveryRequests = result.requests;
      renderRecoveryList();
      $("recovery-admin-message").textContent = "";
      if (recoverySelection !== null)
        await loadRecoveryDetail(recoverySelection);
    } catch (error) {
      if (epoch === recoveryEpoch && user?.role === "admin")
        $("recovery-admin-message").textContent = error.message;
    }
  }
  async function loadRecoveryDetail(id) {
    const epoch = recoveryEpoch,
      version = ++recoveryDetailVersion;
    recoverySelection = id;
    renderRecoveryList();
    $("recovery-detail").replaceChildren(
      node("p", "Загрузка запроса…", "muted"),
    );
    try {
      const result = await api(`${recoveryBase}/${encodeURIComponent(id)}`);
      if (
        epoch !== recoveryEpoch ||
        version !== recoveryDetailVersion ||
        user?.role !== "admin"
      )
        return;
      recoveryCurrent = result;
      renderRecoveryDetail();
    } catch (error) {
      if (
        epoch === recoveryEpoch &&
        version === recoveryDetailVersion &&
        user?.role === "admin"
      )
        $("recovery-detail").replaceChildren(node("p", error.message, "error"));
    }
  }
  function renderRecoveryDetail() {
    if (!recoveryCurrent || user?.role !== "admin") return;
    const { request, events } = recoveryCurrent;
    const detail = $("recovery-detail");
    detail.replaceChildren();
    const status = recoveryStatus(request),
      cached = recoveryLinks.get(request.id);
    if (
      cached &&
      (status !== "approved" || cached.expiresAt !== request.expiresAt)
    )
      recoveryLinks.delete(request.id);
    detail.append(
      node("h3", request.clientName || "Аккаунт не найден"),
      node("p", request.email, "recovery-email"),
    );
    const fields = node("dl", undefined, "recovery-fields");
    for (const [label, value] of [
      ["Статус", recoveryStatuses[status] || status],
      ["Создан", recoveryDate(request.createdAt)],
      ["Обработал", request.processedByName || "—"],
      ["Обработан", recoveryDate(request.processedAt)],
      ["Ссылка действует до", recoveryDate(request.expiresAt)],
    ])
      fields.append(node("dt", label), node("dd", value));
    detail.append(fields);
    const actions = node("div", undefined, "recovery-actions");
    if (["new", "approved"].includes(status)) {
      if (request.userId) {
        const identity = node("label", undefined, "recovery-identity"),
          check = node("input");
        check.type = "checkbox";
        identity.append(
          check,
          node(
            "span",
            "Я проверил(а) личность клиента по известному каналу связи.",
          ),
        );
        const approve = node(
          "button",
          status === "approved"
            ? "Создать новую ссылку"
            : "Одобрить и создать ссылку",
          "primary",
        );
        approve.type = "button";
        approve.disabled = true;
        check.addEventListener("change", () => {
          approve.disabled = !check.checked;
        });
        approve.addEventListener("click", () => {
          if (!check.checked) return;
          if (
            status === "approved" &&
            !window.confirm(
              "Создать новую ссылку? Предыдущая ссылка сразу перестанет работать.",
            )
          )
            return;
          recoveryAction(request, "approve");
        });
        actions.append(identity, approve);
      } else
        actions.append(
          node(
            "p",
            "Для этого email нет доступного клиентского аккаунта. Одобрение невозможно.",
            "muted",
          ),
        );
      const reject = node("button", "Отклонить запрос", "text-button");
      reject.type = "button";
      reject.addEventListener("click", () => {
        if (
          window.confirm(
            "Отклонить этот запрос? Выданная ссылка, если она есть, перестанет работать.",
          )
        )
          recoveryAction(request, "reject");
      });
      actions.append(reject);
    }
    const linkState = recoveryLinks.get(request.id);
    if (status === "approved" && linkState) {
      const linkBox = node("div", undefined, "recovery-link-box");
      linkBox.append(
        node(
          "p",
          "Передайте ссылку только проверенному клиенту. Она одноразовая и не сохраняется в этом браузере.",
          "muted",
        ),
      );
      const copy = node("button", "Скопировать ссылку", "primary");
      copy.type = "button";
      copy.addEventListener("click", () =>
        copyRecoveryLink(request, linkState, linkBox),
      );
      linkBox.append(copy);
      actions.append(linkBox);
    } else if (status === "approved")
      actions.append(
        node(
          "p",
          "Ссылка была выдана ранее и не доступна после обновления страницы. Если нужно, создайте новую — прежняя перестанет работать.",
          "muted",
        ),
      );
    detail.append(actions);
    detail.append(node("h4", "История действий"));
    const history = node("ol", undefined, "recovery-history");
    for (const event of events || [])
      history.append(
        node(
          "li",
          `${recoveryEvents[event.type] || "Действие"} · ${event.actorName || "Система"} · ${recoveryDate(event.createdAt)}`,
        ),
      );
    if (!history.childElementCount)
      history.append(node("li", "Действий пока нет."));
    detail.append(history);
  }
  async function recoveryAction(request, action) {
    const epoch = recoveryEpoch,
      version = recoveryDetailVersion;
    const controls = [...$("recovery-detail").querySelectorAll("button,input")];
    controls.forEach((el) => (el.disabled = true));
    try {
      const result = await api(
        `${recoveryBase}/${encodeURIComponent(request.id)}/${action}`,
        "POST",
        {},
      );
      if (epoch !== recoveryEpoch || user?.role !== "admin") return;
      recoveryLinks.delete(request.id);
      if (action === "approve") {
        const path = result.resetPath;
        if (
          typeof path !== "string" ||
          !/^\/reset-password\/#(?:[a-f0-9]{64})$/.test(path)
        )
          throw new Error("Не удалось получить ссылку. Обновите запрос.");
        recoveryLinks.set(request.id, {
          url: new URL(path, location.origin).href,
          expiresAt: result.request.expiresAt,
        });
      }
      if (version === recoveryDetailVersion) await refreshRecovery();
    } catch (error) {
      if (
        epoch === recoveryEpoch &&
        version === recoveryDetailVersion &&
        user?.role === "admin"
      ) {
        $("recovery-admin-message").textContent = error.message;
        renderRecoveryDetail();
      }
    }
  }
  async function copyRecoveryLink(request, state, box) {
    const epoch = recoveryEpoch,
      version = recoveryDetailVersion;
    const stillCurrent = () =>
      epoch === recoveryEpoch &&
      version === recoveryDetailVersion &&
      user?.role === "admin" &&
      recoveryLinks.get(request.id) === state &&
      Date.parse(state.expiresAt) > Date.now();
    if (!stillCurrent()) return;
    const copied = async () => {
      if (!stillCurrent()) return;
      try {
        await api(
          `${recoveryBase}/${encodeURIComponent(request.id)}/copied`,
          "POST",
          {},
        );
        if (stillCurrent())
          $("recovery-admin-message").textContent =
            "Копирование подтверждено. Передайте ссылку клиенту лично.";
      } catch (error) {
        if (stillCurrent())
          $("recovery-admin-message").textContent = error.message;
      }
    };
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(state.url);
      await copied();
    } catch {
      if (!stillCurrent() || box.querySelector("input")) return;
      const label = node("label", "Ссылка для ручного копирования"),
        input = node("input");
      input.type = "text";
      input.readOnly = true;
      input.value = state.url;
      input.autocomplete = "off";
      input.setAttribute("aria-label", "Одноразовая ссылка для клиента");
      const confirm = node("button", "Я скопировал(а) ссылку", "text-button");
      confirm.type = "button";
      confirm.addEventListener("click", copied);
      box.append(
        label,
        input,
        node(
          "p",
          "Выделите ссылку и скопируйте её через меню браузера.",
          "muted",
        ),
        confirm,
      );
      input.focus();
      input.select();
    }
  }
  $("recovery-refresh").addEventListener("click", refreshRecovery);
  $("show-recovery").addEventListener("click", () => {
    $("login-form").hidden = true;
    $("register-form").hidden = true;
    $("recovery-auth").hidden = false;
    $("auth-heading").textContent = "Забыли пароль?";
    $("show-login").setAttribute("aria-pressed", "false");
    $("show-register").setAttribute("aria-pressed", "false");
    $("recovery-request-message").textContent = "";
    $("recovery-email").value = $("login-email").value;
    $("recovery-email").focus();
  });
  $("recovery-back").addEventListener("click", () => {
    authTab(false);
    $("login-email").focus();
  });
  bindForm("recovery-request-form", async (values, form) => {
    const epoch = recoveryEpoch;
    $("recovery-request-message").textContent = "";
    try {
      const result = await api("/api/password-recovery/requests", "POST", {
        email: values.email,
      });
      if (epoch === recoveryEpoch && !user) {
        $("recovery-request-message").textContent = result.message;
        form.reset();
      }
    } catch (error) {
      if (epoch === recoveryEpoch && !user)
        $("recovery-request-message").textContent = error.message;
    }
  });

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
      if (activeTab === "recovery") await refreshRecovery();
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
  window.addEventListener("itd-preview-session-expired", () => {
    if (user) {
      showAuth();
      message("Сессия завершилась. Войдите повторно.", true);
    }
  });
  window.addEventListener("pagehide", clearRecovery);
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    showAuth();
    api("/api/me")
      .then((result) => enter(result.user))
      .catch(() => showAuth());
  });
  api("/api/me")
    .then((result) => enter(result.user))
    .catch((error) => {
      showAuth();
      if (error.message !== "Войдите в кабинет") message(error.message, true);
    });
})();

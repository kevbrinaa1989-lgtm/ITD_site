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
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const message = (text, error = false) => {
    const el = $("status-message");
    el.textContent = text;
    el.classList.toggle("is-error", error);
    el.setAttribute("role", error ? "alert" : "status");
  };
  const showAuth = () => {
    user = null;
    projects = [];
    selectedId = null;
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
  function render() {
    const admin = user.role === "admin";
    $("project-list").replaceChildren();
    for (const p of projects) {
      const button = node("button", p.title, "project-item");
      button.type = "button";
      button.setAttribute("aria-pressed", String(p.id === selectedId));
      button.addEventListener("click", () => {
        selectedId = p.id;
        render();
      });
      $("project-list").append(button);
    }
    const project = projects.find((p) => p.id === selectedId);
    $("empty-state").hidden = !!project;
    $("project-content").hidden = !project;
    $("admin-panel").hidden = !admin;
    for (const id of ["add-stage-form", "upload-file-form"])
      if ($(id)) $(id).hidden = !project;
    if (!project) return;
    $("project-title").textContent = project.title;
    $("project-client").textContent =
      `${project.clientName} · ${project.clientEmail}`;
    $("project-status").textContent = project.status;
    $("stage-list").replaceChildren();
    const stageSelect = $("upload-file-form").elements.namedItem("stageId");
    stageSelect.replaceChildren(new Option("Без привязки к этапу", ""));
    for (const stage of project.stages) {
      stageSelect.add(new Option(stage.title, String(stage.id)));
      const item = node("article", undefined, "stage-card");
      item.append(
        node("h3", stage.title),
        node("p", statuses[stage.status] || stage.status, "stage-status"),
        node("p", stage.description),
      );
      if (admin) {
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
        item.append(form);
      }
      $("stage-list").append(item);
    }
    if (!project.stages.length)
      empty($("stage-list"), "Этапы пока не добавлены.");
    for (const [category, id] of [
      ["result", "result-list"],
      ["document", "document-list"],
    ]) {
      const list = $(id);
      list.replaceChildren();
      for (const file of project.files.filter((f) => f.category === category)) {
        const item = node("div", undefined, "file-item");
        const link = node("a", file.name);
        link.href = `/api/files/${encodeURIComponent(file.id)}/download`;
        link.download = file.name;
        item.append(
          link,
          node("span", ` ${(file.size / 1024).toFixed(1)} КБ`, "file-size"),
        );
        const stage = project.stages.find((s) => s.id === file.stageId);
        if (stage) item.append(node("span", ` · ${stage.title}`));
        if (admin) {
          const button = node("button", "Удалить");
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
        list.append(item);
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

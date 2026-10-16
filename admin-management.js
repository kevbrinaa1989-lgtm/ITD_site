"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const statuses = ["Новый", "В работе", "На паузе", "Завершён"];
  let hooks,
    epoch = 0,
    clientVersion = 0,
    projectVersion = 0,
    listVersion = 0,
    clients = [],
    selectedClient = null,
    selectedProject = null,
    active = "";
  const date = (value) =>
    value ? new Date(value).toLocaleString("ru-RU") : "Не указана";
  const valid = (generation) =>
    generation === epoch && hooks.getUser()?.role === "admin";
  function reset() {
    epoch++;
    clientVersion++;
    projectVersion++;
    listVersion++;
    clients = [];
    selectedClient = null;
    selectedProject = null;
    active = "";
    for (const id of [
      "admin-client-list",
      "admin-client-detail",
      "admin-project-list",
      "admin-project-detail",
    ])
      $(id)?.replaceChildren();
    for (const id of ["admin-clients-message", "admin-projects-message"])
      $(id).textContent = "";
    $("admin-client-search").reset();
    $("admin-project-search").reset();
  }
  function notice(kind, text) {
    $("admin-" + kind + "-message").textContent = text;
  }
  function fields(host, pairs) {
    const list = node("dl", undefined, "recovery-fields");
    for (const [key, value] of pairs)
      list.append(node("dt", key), node("dd", String(value)));
    host.append(list);
  }
  const eventNames = {
    "client.renamed": "Имя клиента изменено",
    "client.disabled": "Доступ клиента отключён",
    "client.enabled": "Доступ клиента восстановлен",
    "project.created": "Проект создан",
    "project.renamed": "Название проекта изменено",
    "project.status_changed": "Статус проекта изменён",
    "project.archived": "Проект перемещён в архив",
    "project.restored": "Проект восстановлен",
    "project.reassigned": "Клиент проекта изменён",
    client_renamed: "Имя клиента изменено",
    client_deactivated: "Доступ клиента отключён",
    client_activated: "Доступ клиента восстановлен",
    project_created: "Проект создан",
    project_updated: "Проект обновлён",
    project_renamed: "Название проекта изменено",
    project_status_changed: "Статус проекта изменён",
    project_archived: "Проект перемещён в архив",
    project_restored: "Проект восстановлен",
    project_reassigned: "Клиент проекта изменён",
    requested: "Запрос на восстановление пароля",
    approved: "Запрос одобрен",
    issued: "Ссылка восстановления создана",
    reissued: "Ссылка восстановления обновлена",
    copied: "Ссылка скопирована",
    used: "Пароль изменён",
    rejected: "Запрос отклонён",
    expired: "Ссылка истекла",
    viewed: "Запрос просмотрен",
  };
  function history(host, events) {
    const details = node("details", undefined, "admin-history"),
      summary = node("summary", "История действий");
    details.append(summary);
    const list = node("ol", undefined, "recovery-history");
    for (const event of events || [])
      list.append(
        node(
          "li",
          `${eventNames[event.type] || eventNames[event.type.replace(/^recovery\./, "")] || "Изменение"} · ${event.actorName || "Система"} · ${date(event.createdAt)}`,
        ),
      );
    if (!list.childElementCount) list.append(node("li", "История пока пуста."));
    details.append(list);
    host.append(details);
  }
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
      const controls = [...form.querySelectorAll("input,select,button")];
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
  async function mutate(kind, path, data, method = "POST") {
    const generation = epoch;
    await hooks.api(path, method, data);
    if (!valid(generation)) return false;
    await hooks.refresh();
    return valid(generation);
  }
  async function loadClients() {
    const generation = epoch,
      version = ++listVersion;
    notice("clients", "Загрузка клиентов…");
    try {
      const result = await hooks.api("/api/clients");
      if (!valid(generation) || version !== listVersion) return;
      clients = result.clients;
      renderClients();
      notice("clients", "");
    } catch (error) {
      if (valid(generation) && version === listVersion)
        notice("clients", error.message);
    }
  }
  function renderClients() {
    const list = $("admin-client-list");
    list.replaceChildren();
    const search = $("admin-client-query").value.trim().toLocaleLowerCase("ru");
    for (const client of clients.filter((item) =>
      (item.name + " " + item.email).toLocaleLowerCase("ru").includes(search),
    )) {
      const card = button("", () => clientDetail(client.id), "admin-record");
      card.setAttribute("aria-pressed", String(selectedClient === client.id));
      card.append(
        node("strong", client.name),
        node("span", client.email),
        node(
          "small",
          `${client.isActive === false ? "Доступ отключён" : "Доступ открыт"} · Проектов: ${client.projectCount ?? 0}`,
        ),
      );
      list.append(card);
    }
    if (!list.childElementCount)
      list.append(node("p", "Клиенты не найдены.", "empty-note"));
  }
  async function clientDetail(id) {
    const generation = epoch,
      version = ++clientVersion;
    selectedClient = id;
    renderClients();
    const host = $("admin-client-detail");
    host.replaceChildren(node("p", "Загрузка…", "muted"));
    try {
      const result = await hooks.api(`/api/admin/clients/${id}`);
      if (!valid(generation) || version !== clientVersion) return;
      renderClient(result);
    } catch (error) {
      if (valid(generation) && version === clientVersion)
        host.replaceChildren(node("p", error.message, "error"));
    }
  }
  function renderClient({ client, projects, events }) {
    const host = $("admin-client-detail");
    host.replaceChildren(node("h3", client.name));
    fields(host, [
      ["Email", client.email],
      ["Регистрация", date(client.createdAt)],
      ["Доступ", client.isActive === false ? "Отключён" : "Открыт"],
      ["Проектов", client.projectCount ?? projects.length],
    ]);
    const edit = node("details", undefined, "admin-editor");
    edit.append(node("summary", "Изменить имя"));
    const form = node("form");
    input(form, "Имя клиента", "name", client.name);
    const save = node("button", "Сохранить имя", "primary");
    save.type = "submit";
    form.append(save);
    formAction(form, "clients", async (values) => {
      if (
        await mutate(
          "clients",
          `/api/admin/clients/${client.id}`,
          { name: values.name },
          "PATCH",
        )
      ) {
        await loadClients();
        if (selectedClient === client.id) await clientDetail(client.id);
        notice("clients", "Имя сохранено.");
      }
    });
    edit.append(form);
    host.append(edit);
    const toggle = button(
      client.isActive === false ? "Восстановить доступ" : "Отключить доступ",
      async () => {
        const enable = client.isActive === false;
        if (
          !window.confirm(
            enable
              ? `Восстановить вход в кабинет для ${client.name}?`
              : `Отключить доступ для ${client.name}? Клиент не сможет входить в кабинет. Проекты и файлы останутся на месте.`,
          )
        )
          return;
        const generation = epoch;
        toggle.disabled = true;
        try {
          if (
            await mutate(
              "clients",
              `/api/admin/clients/${client.id}`,
              { isActive: enable, confirm: true },
              "PATCH",
            )
          ) {
            await loadClients();
            if (selectedClient === client.id) await clientDetail(client.id);
            notice(
              "clients",
              enable ? "Доступ восстановлен." : "Доступ отключён.",
            );
          }
        } catch (error) {
          if (valid(generation)) notice("clients", error.message);
        } finally {
          toggle.disabled = false;
        }
      },
      "admin-danger",
    );
    host.append(toggle, node("h4", "Проекты клиента"));
    const projectList = node("div", undefined, "admin-linked-projects");
    for (const project of projects)
      projectList.append(
        button(`${project.title} · ${project.status}`, () =>
          hooks.openProject(project.id),
        ),
      );
    if (!projects.length)
      projectList.append(node("p", "У клиента пока нет проектов.", "muted"));
    host.append(projectList);
    history(host, events);
  }
  async function loadProjects() {
    const generation = epoch,
      version = ++listVersion;
    notice("projects", "Загрузка проектов…");
    try {
      const query = new URLSearchParams({
        search: $("admin-project-query").value.trim(),
        status: $("admin-project-filter").value,
      });
      const result = await hooks.api(`/api/admin/projects?${query}`);
      if (!valid(generation) || version !== listVersion) return;
      const list = $("admin-project-list");
      list.replaceChildren();
      for (const project of result.projects) {
        const card = button(
          "",
          () => projectDetail(project.id),
          "admin-record",
        );
        card.dataset.projectId = String(project.id);
        card.setAttribute(
          "aria-pressed",
          String(project.id === selectedProject),
        );
        const stages = project.stages || [],
          complete = stages.filter(
            (stage) => stage.status === "completed",
          ).length;
        card.append(
          node("strong", project.title),
          node(
            "span",
            `${project.clientName || "Клиент не указан"} · ${project.clientEmail || ""}`,
          ),
          node(
            "small",
            `${project.status} · ${stages.length ? `${complete} из ${stages.length} этапов` : "Этапы не добавлены"}`,
          ),
        );
        list.append(card);
      }
      if (!list.childElementCount)
        list.append(node("p", "Проекты не найдены.", "empty-note"));
      notice("projects", "");
    } catch (error) {
      if (valid(generation) && version === listVersion)
        notice("projects", error.message);
    }
  }
  async function projectDetail(id) {
    const generation = epoch,
      version = ++projectVersion;
    selectedProject = id;
    const host = $("admin-project-detail");
    host.replaceChildren(node("p", "Загрузка…", "muted"));
    $("admin-project-list")
      .querySelectorAll("button")
      .forEach((el) =>
        el.setAttribute(
          "aria-pressed",
          String(el.dataset.projectId === String(id)),
        ),
      );
    try {
      const [result, clientResult] = await Promise.all([
        hooks.api(`/api/admin/projects/${id}`),
        hooks.api("/api/clients"),
      ]);
      if (!valid(generation) || version !== projectVersion) return;
      renderProject(result, clientResult.clients);
    } catch (error) {
      if (valid(generation) && version === projectVersion)
        host.replaceChildren(node("p", error.message, "error"));
    }
  }
  function renderProject({ project, events }, availableClients) {
    const host = $("admin-project-detail");
    host.replaceChildren(node("h3", project.title));
    const stages = project.stages || [],
      files = project.files || [],
      completed = stages.filter((stage) => stage.status === "completed").length;
    fields(host, [
      [
        "Клиент",
        `${project.clientName || "Не указан"} · ${project.clientEmail || ""}`,
      ],
      ["Статус", project.status],
      ["Создан", date(project.createdAt)],
      [
        "Этапы",
        stages.length
          ? `${completed} из ${stages.length} завершено`
          : "Этапы не добавлены",
      ],
      [
        "Материалы",
        `${files.filter((file) => file.category === "result").length} результатов · ${files.filter((file) => file.category === "document").length} документов`,
      ],
    ]);
    host.append(
      button("Открыть этапы и материалы →", () =>
        hooks.openProject(project.id),
      ),
    );
    const edit = node("details", undefined, "admin-editor");
    edit.append(node("summary", "Изменить название и статус"));
    const form = node("form");
    input(form, "Название проекта", "title", project.title);
    const label = node("label", "Статус проекта"),
      select = node("select");
    select.name = "status";
    select.setAttribute("aria-label", "Статус проекта");
    for (const status of project.status === "Архив" ? ["Архив"] : statuses)
      select.add(new Option(status, status));
    if (project.status !== "Архив" && !statuses.includes(project.status))
      select.add(new Option(project.status, project.status));
    select.value = project.status;
    form.append(label, select);
    const save = node("button", "Сохранить изменения", "primary");
    save.type = "submit";
    form.append(save);
    formAction(form, "projects", async (values) => {
      const payload = { title: values.title };
      if (
        project.status !== "Архив" &&
        values.status !== project.status &&
        statuses.includes(values.status)
      )
        payload.status = values.status;
      if (
        await mutate(
          "projects",
          `/api/admin/projects/${project.id}`,
          payload,
          "PATCH",
        )
      ) {
        await loadProjects();
        if (selectedProject === project.id) await projectDetail(project.id);
        notice("projects", "Изменения сохранены.");
      }
    });
    edit.append(form);
    host.append(edit);
    const ownership = node("details", undefined, "admin-editor");
    ownership.append(node("summary", "Назначить другого клиента"));
    const assign = node("form"),
      clientSelect = node("select");
    clientSelect.name = "clientId";
    clientSelect.required = true;
    clientSelect.setAttribute("aria-label", "Новый клиент проекта");
    clientSelect.add(new Option("Выберите клиента", ""));
    for (const client of availableClients) {
      const option = new Option(
        `${client.name} (${client.email})${client.isActive === false ? " — доступ отключён" : ""}`,
        String(client.id),
      );
      option.disabled =
        client.isActive === false || client.id === project.clientId;
      clientSelect.add(option);
    }
    const warning = node(
      "p",
      "После переназначения прежний клиент потеряет доступ к проекту и всем его файлам. Новый клиент получит доступ ко всем материалам проекта.",
      "admin-warning",
    );
    const identity = node("label", undefined, "recovery-identity"),
      check = node("input");
    check.type = "checkbox";
    check.required = true;
    identity.append(
      check,
      node(
        "span",
        "Я проверил(а) клиента и подтверждаю передачу доступа ко всем файлам.",
      ),
    );
    const move = node("button", "Переназначить проект", "primary");
    move.type = "submit";
    assign.append(warning, clientSelect, identity, move);
    formAction(assign, "projects", async (values) => {
      const client = availableClients.find(
        (item) => String(item.id) === values.clientId,
      );
      if (!client || client.isActive === false) return;
      if (
        !window.confirm(
          `Передать проект «${project.title}» клиенту ${client.name} (${client.email})? Прежний клиент потеряет доступ ко всем файлам проекта.`,
        )
      )
        return;
      if (
        await mutate("projects", `/api/admin/projects/${project.id}/assign`, {
          clientId: Number(values.clientId),
          expectedClientId: project.clientId,
          confirm: true,
        })
      ) {
        await loadProjects();
        if (selectedProject === project.id) await projectDetail(project.id);
        notice("projects", "Клиент проекта изменён.");
      }
    });
    ownership.append(assign);
    host.append(ownership);
    const archived = project.status === "Архив";
    const archive = button(
      archived ? "Восстановить из архива" : "Переместить в архив",
      async () => {
        if (
          !window.confirm(
            archived
              ? `Восстановить проект «${project.title}» из архива?`
              : `Переместить проект «${project.title}» в архив? Файлы сохранятся, клиент сможет открыть их через архив.`,
          )
        )
          return;
        const generation = epoch;
        archive.disabled = true;
        try {
          const path = `/api/admin/projects/${project.id}${archived ? "/restore" : ""}`;
          if (
            await mutate(
              "projects",
              path,
              archived ? { confirm: true } : { status: "Архив", confirm: true },
              archived ? "POST" : "PATCH",
            )
          ) {
            await loadProjects();
            if (selectedProject === project.id) await projectDetail(project.id);
            notice(
              "projects",
              archived ? "Проект восстановлен." : "Проект перемещён в архив.",
            );
          }
        } catch (error) {
          if (valid(generation)) notice("projects", error.message);
        } finally {
          archive.disabled = false;
        }
      },
      "admin-danger",
    );
    host.append(archive);
    history(host, events);
  }
  function init(options) {
    hooks = options;
    $("admin-client-search").addEventListener("submit", (event) => {
      event.preventDefault();
      renderClients();
    });
    $("admin-project-search").addEventListener("submit", (event) => {
      event.preventDefault();
      loadProjects();
    });
    $("admin-project-filter").addEventListener("change", loadProjects);
  }
  function onTab(tab) {
    active = tab;
    if (hooks.getUser()?.role !== "admin") return;
    if (tab === "clients") loadClients();
    if (tab === "projects") loadProjects();
  }
  window.ITDAdmin = { init, reset, onTab };
})();

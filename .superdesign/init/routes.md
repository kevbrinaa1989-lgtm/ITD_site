# Маршруты и вкладки

Исследовано по коду 99b7555fad5a5c9996391ca85e6f3ba0486c75e8, ветка feature/itd-superdesign-redesign. Это контекст существующей реализации, не утверждённый новый дизайн. Реальные данные и сервер не исследовались.

Внутренние разделы кабинета не являются самостоятельными URL и не имеют React-router. Все используют `/cabinet`, а `cabinet.js:selectTab` переключает `data-tab-panel` и общее состояние selectedId/activeTab. Это важно для будущего сохранения контекста/ссылок.

| Роль/контекст | Вкладки | Реализация |
|---|---|---|
| Гость | вход, регистрация (только разрешённый runtime), запрос восстановления | cabinet.html + cabinet.js |
| Администратор | workspace, tasks | admin-workspace.js |
| Администратор | clients, projects, settings | admin-management.js + cabinet.js |
| Администратор | create-project, management, recovery | cabinet.js |
| Клиент | client-home, client-projects, client-review, profile | client-workspace.js |
| Общие | notifications | cabinet.js, material-review.js, client-workspace.js |
| Проект | overview, stages, results, documents | cabinet.js |
| Проект | review | material-review.js |
| Сброс пароля | /reset-password, /reset-password/ | reset-password.html + recovery.js |
| Приглашение | /accept-invitation, /accept-invitation/ | invitation.html + invitation-accept.js |

Приглашение и сброс получают секрет из fragment, не должны передавать реальные токены дизайн-сервису. Публичные `/` и `/anketa` в серверном маршрутизаторе относятся к старым файлам репозитория; это НЕ текущий бренд-референс. Новый дизайн опирается на live itdstudio.ru после проверки, не на эти страницы.

## Полная таблица статических маршрутов сервера
```js
      const routes = {
        "/": "tilda-home-connected-fixed.html",
        "/anketa": "tilda-anketa-connected-fixed.html",
        "/anketa/": "tilda-anketa-connected-fixed.html",
        "/reset-password": "reset-password.html",
        "/reset-password/": "reset-password.html",
        "/recovery.js": "recovery.js",
        "/cabinet": "cabinet.html",
        "/cabinet/": "cabinet.html",
        "/cabinet.js": "cabinet.js",
        "/admin-management.js": "admin-management.js",
        "/admin-workspace.js": "admin-workspace.js",
        "/client-workspace.js": "client-workspace.js",
        "/invitations.js": "invitations.js",
        "/invitation-accept.js": "invitation-accept.js",
        "/accept-invitation": "invitation.html",
        "/accept-invitation/": "invitation.html",
        "/upload-context.js": "upload-context.js",
        "/material-review.js": "material-review.js",
        "/file-viewer.js": "file-viewer.js",
        "/cabinet.css": "cabinet.css",
      };
```

## Полные функции переключения вкладки и открытия проекта
```js
  function selectTab(tab, options = {}) {
    const admin = user?.role === "admin";
    const home = admin ? "workspace" : "client-home";
    const hasProject = projects.some((project) => project.id === selectedId);
    if (
      (adminTabs.includes(tab) && !admin) ||
      (clientTabs.includes(tab) && admin)
    )
      tab = home;
    if (projectTabNames.includes(tab) && !hasProject) tab = home;
    activeTab = tab;
    const inProject = projectTabNames.includes(tab) && hasProject;
    if (inProject) projectTabs.set(selectedId, tab);
    document.querySelectorAll("[data-tab]").forEach((button) => {
      const value = button.dataset.tab;
      button.hidden =
        value === "management" ||
        (adminTabs.includes(value) && !admin) ||
        (clientTabs.includes(value) && admin) ||
        (projectTabNames.includes(value) && !inProject);
      const selected =
        value === tab ||
        (inProject && value === (admin ? "projects" : "client-projects"));
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex =
        selected || button.closest("#studio-navigation") ? 0 : -1;
      button.classList.toggle("is-active", selected);
    });
    document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.tabPanel !== tab;
    });
    $("project-content").hidden = !inProject;
    $("project-heading").hidden = !inProject;
    $("project-navigation").hidden = !inProject;
    $("admin-panel").hidden = tab !== "management" || !admin;
    $("empty-state").hidden = true;
    $("shell-back").hidden = !inProject && tab !== "create-project";
    $("shell-back").textContent =
      inProject && returnClientId ? "← К карточке клиента" : "← К проектам";
    const titles = {
      workspace: "Главная",
      projects: "Проекты",
      clients: "Клиенты",
      tasks: "Задачи",
      recovery: "Запросы на восстановление",
      notifications: "Уведомления",
      "create-project": "Новый проект",
      "client-home": "Главная",
      "client-projects": "Мои проекты",
      "client-review": "На согласование",
      profile: "Мой профиль",
    };
    $("shell-location").textContent = inProject
      ? "Проекты / " + (projects.find((p) => p.id === selectedId)?.title || "")
      : titles[tab] || "Главная";
    $("shell-role-label").textContent = admin
      ? "Рабочее пространство студии"
      : "Личный кабинет";
    document.body.classList.remove("menu-open");
    $("mobile-menu-button")?.setAttribute("aria-expanded", "false");
    if (tab === "recovery" && admin) refreshRecovery();
    if (tab === "settings" && admin)
      window.ITDAdmin?.openSettings(selectedId, options);
    window.ITDWorkspace?.onTab(tab);
    window.ITDInvitations?.onTab(tab);
    window.ITDAdmin?.onTab(tab);
    window.ITDReview?.onTab(tab);
    window.ITDClientWorkspace?.onTab(tab);
  }
  async function openProject(id, options = {}) {
    id = Number(id);
    if (!(await window.ITDUploads.allowSwitch(id)))
      throw new Error("Переход отменён. Подготовленная загрузка сохранена.");
    const currentUser = user;
    await refresh();
    if (!user || user !== currentUser) throw new Error("Сессия изменилась.");
    if (!projects.some((project) => project.id === id))
      throw new Error("Проект недоступен.");
    if (selectedId !== id) selectedStageId = null;
    selectedId = id;
    returnClientId = options.clientId || null;
    activeTab = options.tab || "overview";
    render();
  }
```

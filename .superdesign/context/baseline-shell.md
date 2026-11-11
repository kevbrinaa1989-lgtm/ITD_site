# Existing cabinet shell — exact selected source

This is source ground truth for a baseline reproduction, not the proposed redesign. Only whitespace within HTML tags has been collapsed. Data-bound values must use fictional fixtures. Static HTML hides panels initially; selectTab exposes only the requested role/page after login. Do not reproduce all hidden tabs at once. No live API calls.

## cabinet.html:166:329
```html
<section id="app-view" class="workspace" hidden aria-label="Ваши проекты">
<aside class="project-sidebar" aria-label="Навигация кабинета">
<a class="brand sidebar-brand" href="https://itdstudio.ru/" aria-label="ITD Studio — на основной сайт" ><img class="brand-logo" src="https://forms.itdstudio.ru/itd/assets/logo.svg" alt="ITD Studio" /></a>
<p id="shell-role-label" class="sidebar-caption">Личный кабинет</p>
<nav id="studio-navigation" class="workspace-nav" role="tablist" aria-orientation="vertical" aria-label="Общие разделы" >
<button id="tab-workspace" type="button" role="tab" aria-selected="false" aria-controls="panel-workspace" data-tab="workspace" hidden >
<span aria-hidden="true">◫</span>Главная</button ><button id="tab-projects" type="button" role="tab" aria-selected="false" aria-controls="admin-projects-panel" data-tab="projects" hidden >
<span aria-hidden="true">▦</span>Проекты</button ><button id="tab-clients" type="button" role="tab" aria-selected="false" aria-controls="admin-clients-panel" data-tab="clients" hidden >
<span aria-hidden="true">♙</span>Клиенты</button ><button id="tab-tasks" type="button" role="tab" aria-selected="false" aria-controls="panel-tasks" data-tab="tasks" hidden >
<span aria-hidden="true">≡</span>Задачи</button ><button id="tab-client-home" type="button" role="tab" aria-selected="false" aria-controls="client-home-panel" data-tab="client-home" hidden >
Главная</button ><button id="tab-client-projects" type="button" role="tab" aria-selected="false" aria-controls="client-projects-panel" data-tab="client-projects" hidden >
Мои проекты</button ><button id="tab-client-review" type="button" role="tab" aria-selected="false" aria-controls="client-review-panel" data-tab="client-review" hidden >
На согласование</button ><button id="tab-notifications" type="button" role="tab" aria-selected="false" aria-controls="panel-notifications" data-tab="notifications" >
<span aria-hidden="true">◉</span>Уведомления
<span id="notification-count" class="notification-count" hidden >0</span ></button ><button id="tab-profile" type="button" role="tab" aria-selected="false" aria-controls="profile-panel" data-tab="profile" hidden >
Мой профиль</button ><button id="tab-recovery" type="button" role="tab" aria-selected="false" aria-controls="password-recovery-panel" data-tab="recovery" hidden >
<span aria-hidden="true">⌑</span>Запросы на восстановление
</button>
</nav>
<div class="sidebar-bottom">
<a class="studio-contact" href="https://t.me/Kevbrina_Diana" >Связаться со студией <span aria-hidden="true">→</span></a >
<div class="account-bar">
<div id="user-avatar" class="account-avatar" aria-hidden="true">
ITD
</div>
<div class="account-person">
<strong id="user-name"></strong><span id="user-role"></span>
</div>
</div>
</div>
</aside>
<div class="workspace-body">
<div class="workspace-topbar">
<div class="shell-location-row">
<button id="mobile-menu-button" type="button" class="shell-menu-button" aria-controls="studio-navigation" aria-expanded="false" >
☰ Меню</button ><button id="shell-back" type="button" class="text-button" hidden>
← Назад</button ><span id="shell-location">Главная</span>
</div>
<div class="topbar-actions">
<button id="refresh-button" type="button" class="text-button">
<span aria-hidden="true">↻</span> Обновить</button ><a href="https://itdstudio.ru/">На сайт →</a>
<button id="logout-button" type="button" aria-label="Выйти из кабинета" title="Выйти" >
Выйти
</button>
</div>
</div>
<div class="project-area">
```

## cabinet.html:343:426
```html
<article id="project-content" hidden>
<div id="project-heading" class="project-heading" hidden>
<div>
<p class="eyebrow">Рабочее пространство проекта</p>
<h1 id="project-title"></h1>
<p id="project-client" class="muted"></p>
</div>
<span id="project-status" class="badge"></span>
<div class="project-heading-progress">
<p id="project-header-progress-text" class="muted"></p>
<progress id="project-header-progress" max="100" value="0" aria-label="Прогресс по этапам" ></progress>
</div>
<div id="project-actions" class="project-actions"></div>
</div>
<nav id="project-navigation" class="project-navigation" role="tablist" aria-label="Разделы проекта" hidden >
<button id="tab-overview" type="button" role="tab" aria-selected="true" aria-controls="panel-overview" data-tab="overview" >
<span aria-hidden="true">◫</span ><span id="project-overview-label">Обзор</span></button ><button id="tab-stages" type="button" role="tab" aria-selected="false" aria-controls="panel-stages" data-tab="stages" >
<span aria-hidden="true">≡</span>Этапы</button ><button id="tab-results" type="button" role="tab" aria-selected="false" aria-controls="panel-results" data-tab="results" >
<span aria-hidden="true">▧</span>Материалы</button ><button id="tab-review" type="button" role="tab" aria-selected="false" aria-controls="panel-review" data-tab="review" >
<span aria-hidden="true">✓</span>Согласования</button ><button id="tab-documents" type="button" role="tab" aria-selected="false" aria-controls="panel-documents" data-tab="documents" >
<span aria-hidden="true">▤</span>Документы</button ><button id="tab-settings" type="button" role="tab" aria-selected="false" aria-controls="project-settings-panel" data-tab="settings" hidden >
Настройки
</button>
</nav>
```

## cabinet.html:503:545
```html
<section id="panel-review" data-tab-panel="review" role="tabpanel" tabindex="0" aria-labelledby="tab-review" hidden >
<div class="section-title">
<div>
<h2>Согласования материалов</h2>
<p class="muted">
Решение относится к конкретной версии. Старые версии и
история сохраняются.
</p>
</div>
<select id="review-filter" aria-label="Фильтр согласований">
<option value="">Все материалы</option>
<option value="pending_approval">
Ожидает согласования
</option>
<option value="changes_requested">Нужны изменения</option>
<option value="approved">Согласован</option>
<option value="unviewed">Не просмотрено</option>
<option value="viewed">Просмотрено</option>
</select>
</div>
<p id="review-message" role="status" class="muted"></p>
<div class="review-library-heading">
<h3>Материалы проекта</h3>
<span id="review-material-count" class="review-library-count" aria-live="polite"></span>
</div>
<div id="review-material-list" class="review-material-list" ></div>
<section id="review-material-detail" class="panel review-detail" aria-label="Версия материала" hidden ></section>
</section>
```

## cabinet.html:1097:1169
```html
<section id="panel-workspace" data-tab-panel="workspace" role="tabpanel" tabindex="0" aria-labelledby="tab-workspace" hidden >
<div class="section-title">
<div>
<p class="eyebrow">Студия / Рабочий день</p>
<h1>Обзор студии</h1>
<p id="workspace-calendar" class="muted"></p>
</div>
<button id="workspace-refresh" class="text-button" type="button" >
Обновить
</button>
</div>
<p id="workspace-message" role="status" class="muted"></p>
<div id="workspace-metrics" class="workspace-metrics"></div>
<div class="workspace-quick-actions">
<button type="button" class="text-button" id="workspace-new-project" >
Создать проект →</button ><button id="workspace-new-task" type="button" class="text-button" >
Создать задачу →</button ><button type="button" class="text-button" data-open-tab="clients" >
Клиенты →</button ><button type="button" class="text-button" data-open-tab="projects" >
Открыть проекты →</button ><button type="button" class="text-button" data-open-tab="recovery" >
Запросы на восстановление →
</button>
</div>
<div class="workspace-attention-filters">
<label >Проект<select id="workspace-project-filter">
<option value="">Все активные проекты</option>
</select></label ><label >Требует внимания<select id="workspace-type-filter">
<option value="">Все события</option>
<option value="changes_requested">Нужны изменения</option>
<option value="unanswered_comment">Ждёт ответа</option>
</select></label >
</div>
<div id="workspace-attention" class="workspace-sections"></div>
<div id="workspace-deadlines" class="workspace-sections"></div>
</section>
```

## cabinet.html:1234:1236
```html
<div class="workspace-footer">
ITD Studio <span>Интерьер, продуманный до мелочей.</span>
</div>
```

## cabinet.js:181:249
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
```

## cabinet.js:422:489
```js
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
    $("user-name").textContent = user.name;
    const project = projects.find((p) => p.id === selectedId);
    window.ITDUploads?.reconcile();
    $("empty-state").hidden = !!project || admin;
    $("project-content").hidden = !project;
    for (const id of ["add-stage-form", "upload-file-form"])
      $(id).hidden = !project;
    selectTab(activeTab);
    if (!project) {
      window.ITDReview?.setProject(null);
      return;
    }
    $("project-title").textContent = project.title;
    $("project-client").replaceChildren();
    if (admin && project.clientId !== null)
      $("project-client").append(
        projectAction(`${project.clientName} · ${project.clientEmail}`, () =>
          window.ITDAdmin.openClient(project.clientId),
        ),
      );
    else
      $("project-client").textContent =
        project.clientId === null
          ? "Без клиента"
          : `${project.clientName} · ${project.clientEmail}`;
    $("project-actions").replaceChildren();
    if (admin) {
      if (project.clientId === null)
        $("project-actions").append(
          projectAction("Назначить клиента", () =>
            selectTab("settings", { assign: true }),
          ),
        );
      $("project-actions").append(
        projectAction("Добавить этап", () => {
          selectTab("management");
          $("add-stage-form").closest("details").open = true;
          $("stage-title").focus();
        }),
        projectAction("Загрузить материал", () => openUpload()),
        projectAction("Добавить документ", () => openUpload(null, "document")),
        projectAction("Создать задачу", () =>
          window.ITDWorkspace.newTask(project.id),
        ),
      );
    }
    $("project-status").textContent = project.status;
    const completed = project.stages.filter(
      (stage) => stage.status === "completed",
    ).length;
    const progress = project.stages.length
      ? Math.round((completed / project.stages.length) * 100)
      : 0;
    $("project-header-progress").value = progress;
    $("project-header-progress").hidden = !project.stages.length;
    $("project-header-progress-text").textContent = project.stages.length
      ? `${progress}% · ${completed} из ${project.stages.length} этапов`
      : "Нет этапов";
```

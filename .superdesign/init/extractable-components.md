# Кандидаты в общие DraftComponents

Исследовано по коду 99b7555fad5a5c9996391ca85e6f3ba0486c75e8, ветка feature/itd-superdesign-redesign. Это контекст существующей реализации, не утверждённый новый дизайн. Реальные данные и сервер не исследовались.

Это каталог для будущего выделения, удалённых DraftComponent ещё не создавалось. Значения бренда не превращать в динамические props.

## CabinetShell
- Source: `cabinet.html`
- Category: layout
- Description: Общая оболочка студии/клиента.
- Extractable props: activeItem, role, projectSelected.
- Hardcoded: логотип, подписи, общий chrome.

## ProjectNavigation
- Source: `cabinet.html + cabinet.js:selectTab`
- Category: layout
- Description: Вкладки внутри проекта.
- Extractable props: currentTab, isAdmin.
- Hardcoded: порядок/подписи вкладок.

## WorkspaceTopbar
- Source: `cabinet.html`
- Category: layout
- Description: Контекст, возврат, меню, уведомления.
- Extractable props: projectTitle, showBack, notificationCount.
- Hardcoded: кнопки выхода и обновления, иконки.

## StatusBadge
- Source: `cabinet.css + cabinet.js`
- Category: basic
- Description: Состояние проекта/этапа/материала с контекстом.
- Extractable props: status, kind.
- Hardcoded: цвета и словарь статусов.

## ProjectCard
- Source: `client-workspace.js + admin-management.js`
- Category: basic
- Description: Переход в проект.
- Extractable props: projectId, selected, progress.
- Hardcoded: визуальная структура карточки.

## MaterialCard
- Source: `material-review.js`
- Category: basic
- Description: Компактная карточка текущей версии.
- Extractable props: materialId, versionId, status, isSelected.
- Hardcoded: метки типа/версии, иконки.

## MaterialDetails
- Source: `material-review.js`
- Category: basic
- Description: Выбранная версия, действия и обсуждение.
- Extractable props: versionId, canDecide, canUpload.
- Hardcoded: подписи решений, структура истории.

## FileViewer
- Source: `file-viewer.js`
- Category: basic
- Description: Изображения/PDF внутри кабинета.
- Extractable props: fileId, currentIndex, zoom, pageCount.
- Hardcoded: кнопки/панель управления.

## SafeUpload
- Source: `upload-context.js + cabinet.html`
- Category: basic
- Description: Загрузка с явным назначением.
- Extractable props: projectId, clientId, busy, hasPreparedFile.
- Hardcoded: тексты предупреждений/подтверждения.

## TaskCard
- Source: `admin-workspace.js`
- Category: basic
- Description: Рабочая задача со сроком.
- Extractable props: taskId, status, overdue, priority.
- Hardcoded: метки и расположение действий.

## AttentionList
- Source: `admin-workspace.js + client-workspace.js`
- Category: basic
- Description: Ожидающее действие, разделённое по роли.
- Extractable props: role, itemsCount, eventType.
- Hardcoded: тексты пустого состояния.

## ClientProfile
- Source: `client-workspace.js`
- Category: basic
- Description: Профиль с безопасным редактированием.
- Extractable props: editing, busy.
- Hardcoded: названия полей; email не изменяем без процедуры.


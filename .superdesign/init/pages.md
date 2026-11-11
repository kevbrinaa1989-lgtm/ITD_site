# Зависимости основных экранов

Исследовано по коду 99b7555fad5a5c9996391ca85e6f3ba0486c75e8, ветка feature/itd-superdesign-redesign. Это контекст существующей реализации, не утверждённый новый дизайн. Реальные данные и сервер не исследовались.

## Общий полный граф загрузки /cabinet

Все JS — defer scripts в одном HTML; это не ES imports. Их нетранзитивные зависимости реализованы через window и callbacks; трассировка включает и эти связи. Внешний SVG логотип загружается HTML. Прочих framework imports нет. PDF worker — единственный динамический локальный JS-import.

```text
- cabinet.html
  - cabinet.css
  - file-viewer.js
    - vendor/pdfjs/pdf.mjs (dynamic import on PDF open)
      - vendor/pdfjs/pdf.worker.mjs (configured worker)
  - admin-management.js (window.ITDAdmin)
  - material-review.js (window.ITDReview)
    - file-viewer.js (ITDViewer, preview/control callbacks)
    - upload-context.js (ITDUploads, safe version upload)
  - admin-workspace.js (window.ITDWorkspace)
  - upload-context.js (window.ITDUploads)
  - client-workspace.js (window.ITDClientWorkspace)
  - invitations.js (window.ITDInvitations)
  - cabinet.js (controller, init/hook injection into all modules above)
```

## 1. Вход и запрос восстановления
Entry: `cabinet.html + cabinet.js`.
Статические формы auth-view, runtime-регистрация, вызовы API сессии и восстановления.

## 2. Общий обзор администратора
Entry: `admin-workspace.js`.
dashboard и внутренние задачи; общий граф выше, renderDashboard/openTarget callbacks в cabinet.js.

## 3. Задачи
Entry: `admin-workspace.js`.
список, фильтры, создание и редактирование, выбор этапа; общий граф.

## 4. Клиенты, приглашения и проекты
Entry: `admin-management.js + invitations.js`.
карточки, поиск/архив, назначение, отключение аккаунта; общий граф.

## 5. Главная клиента и профиль
Entry: `client-workspace.js`.
главная, проекты, pending reviews и профиль; hooks открывают project/review через cabinet.js.

## 6. Обзор/этапы/результаты/документы проекта
Entry: `cabinet.js`.
file rows зависят от ITDViewer/ITDReview, upload forms от ITDUploads; общий граф.

## 7. Материал, выбранная версия, решения/комментарии
Entry: `material-review.js`.
общий граф + API material-review.mjs; preview только через file-viewer.js, версии upload-context.js.

## 8. Уведомления и восстановление (администратор)
Entry: `cabinet.js + material-review.js + client-workspace.js`.
общая оболочка, роль/контекст влияют на видимость и API.

## 9. Установка нового пароля
Entry: `reset-password.html`.
reset-password.html → cabinet.css + recovery.js; без общего cabinet controller.

## 10. Приглашение
Entry: `invitation.html`.
invitation.html → cabinet.css + invitation-accept.js; без cabinet controller.

## Серверная граница (не визуальные компоненты)

server.mjs обеспечивает static routes и связывает admin-workspace.mjs, admin-management.mjs, material-review.mjs, password-recovery.mjs, invitation.mjs, upload-intents.mjs, upload-content.mjs, data-storage.mjs, security-policy.mjs, passwords.mjs, profile.mjs, project-profile-migration.mjs. Они не импортируются браузером. Сохранить существующие проверки прав; не отправлять БД, документы, токены или данные клиентов в дизайн-инструмент.

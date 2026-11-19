# Точка продолжения · 19 ноября 2026

Работа возобновлена из `5c2e98c6cb5466f62e32684e3afc132669ad977b` в `feature/approval-center`. База — `feature/project-file-library` на `adf83c1`. Коммит приложения, демостенда и проверок — `6cbd37fa041df0d36ceefbd605868ed596d21d4a`. [Draft PR №5](https://github.com/kevbrinaa1989-lgtm/ITD_site/pull/5)

- Исправлены отправка пакета по Wi-Fi и постановка маркера в момент смены страницы PDF. Восстановлена установка зависимостей в проверках GitHub. Для приёмки подготовлены временный проект на 40 материалов, три отдельных этапа с парой PDF и образец v2.
- На Windows в Chrome пройден весь цикл 40 → 35/5 → пять загрузок v2 → подтверждения клиента → ведомость второго раунда → отдельное принятие этапа. Пройдены основной и PDF-сценарии в Edge и WebKit. Локальный `npm test` — 221 успешно, пять Linux-проверок пропущены. На Ubuntu — 226 из 226 и все 12 браузерных заданий. [Протокол](TESTING.md#повторная-приёмка-19-ноября-2026) · [Проверки GitHub](https://github.com/kevbrinaa1989-lgtm/ITD_site/actions/runs/44515302353)
- Следующий шаг — пройти сценарий на физических Samsung Internet/Android, Chrome/Android и Safari/iOS. В сессии были только настольные браузеры и эмуляция. Для каждого устройства сохранить модель, версии и результат. [Шаги для владельца](TESTING.md#проверка-на-телефоне)

## Запуск демостенда

В PowerShell из корня репозитория на Node.js 24.13–24.x выполните команды ниже. Вводите IPv4 компьютера из раздела Wi-Fi в выводе `ipconfig`. Для просмотра только с компьютера достаточно `node tests/preview-approval-center.mjs`.

```powershell
npm.cmd ci
ipconfig
$wifiAddress = Read-Host 'IPv4 компьютера в сети Wi-Fi'
node tests/preview-approval-center.mjs $wifiAddress
```

Стенд выведет адрес кабинета на порту 4175, данные демопользователей и ссылку для скачивания образца v2 после входа. Держите окно открытым. Ctrl+C завершает этот запуск. При новом запуске создаются чистая временная база и новый пароль. Для уже запущенного из чата экземпляра данные входа находятся на компьютере в `test-results/approval-acceptance/demo-access.txt`. Git игнорирует эту папку.

## Проверки в этой среде

Откройте второе окно PowerShell в корне репозитория. В этой среде Playwright установлен вместе с Codex, а Chrome находится в Program Files (x86).

```powershell
npm.cmd test
npm.cmd audit --omit=dev
$pw = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules\playwright'
$env:ITD_PLAYWRIGHT_MODULE = ([uri](Get-Item (Join-Path $pw 'index.mjs')).FullName).AbsoluteUri
$env:ITD_CHROMIUM = Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'
$env:ITD_SCREENSHOT_DIR = Join-Path (Get-Location) 'test-results\approval-acceptance\chrome'
node tests/browser-review.mjs
$env:ITD_SCREENSHOT_DIR = $null
foreach ($suite in 'document-ownership','file-library','route-fixes','preview','route','workspace','upload-context') {
  node "tests/browser-$suite.mjs"
  if ($LASTEXITCODE -ne 0) { throw "Ошибка в browser-$suite" }
}
git diff --check
```

Входная команда `browser-review.mjs` включает PDF, повтор после потери ответа, мобильный HTTP-адрес и сквозной тест на 40 материалах. Для запуска только последнего используйте `node tests/browser-approval-round.mjs`. [Другие движки и профили](TESTING.md#другие-браузеры-на-windows)

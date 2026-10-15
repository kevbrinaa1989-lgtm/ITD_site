import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { bindData, backupData, configuredData, inspectData, verifyBackup, restoreBackup, defaultSettingsFile, assertFreshSetupAllowed } from "./data-storage.mjs";
import { initializeData, defaultDataRoot } from "./initialize-data.mjs";
import { readSecret } from "./secret-input.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const [command, first, second] = process.argv.slice(2);
try {
  if (command === "init") {
    if (first || second) throw Error("Email и пароль вводятся только по запросу программы, не в командной строке.");
    assertFreshSetupAllowed();
    if (!stdin.isTTY) throw Error("Откройте ПЕРВЫЙ-ЗАПУСК.cmd в обычном окне Windows.");
    const prompt = createInterface({ input: stdin, output: stdout });
    let adminEmail;
    try {
      console.log(`Новая база будет создана в отдельной папке внутри: ${defaultDataRoot()}\nЗакройте ВСЕ прежние окна приложения (Ctrl+C). Старые данные не подключаются и не удаляются.\nПрежняя настройка пути, если есть, будет сохранена отдельной копией.`);
      if ((await prompt.question('Для создания чистой базы введите ДА: ')).trim().toUpperCase() !== "ДА")
        throw Error("Создание отменено.");
      adminEmail = (await prompt.question("Ваш email администратора: ")).trim();
    } finally { prompt.close(); }
    let adminPassword, confirmation;
    try {
      adminPassword = await readSecret("Придумайте пароль (12–256 символов; ввод не виден): ");
      confirmation = await readSecret("Повторите пароль (ввод не виден): ");
      if (adminPassword !== confirmation) throw Error("Пароли не совпадают. База не создана. Повторите первый запуск.");
      const info = await initializeData({ adminEmail, adminPassword });
      console.log(`Готово. Новый администратор создан: ${adminEmail}\nПостоянная папка данных: ${info.dataDir}\nПервая резервная копия проверена: ${info.backupDir}`);
      if (info.previousSettings) console.log(`Прежняя настройка сохранена: ${info.previousSettings}`);
      console.log("Теперь откройте ЗАПУСТИТЬ.cmd и войдите с введёнными email и паролем. Повторять первый запуск не нужно.");
    } finally { adminPassword = undefined; confirmation = undefined; }
  } else if (command === "bind") {
    let folder = first;
    if (!folder) {
      const prompt = createInterface({ input: stdin, output: stdout });
      try {
        console.log("Сначала остановите ВСЕ старые окна приложения (Ctrl+C).\nУкажите прежнюю папку .itd-data, где лежат itd.sqlite и files.");
        folder = (await prompt.question(`Полный путь [${join(root, ".itd-data")}]: `)).trim().replace(/^"|"$/g, "") || join(root, ".itd-data");
        const info = inspectData(folder);
        console.log(`Найдено: аккаунтов ${info.counts.users}, проектов ${info.counts.projects}, документов ${info.counts.files}.\nПапка: ${info.dataDir}`);
        if ((await prompt.question('Это ваши прежние данные? Введите ДА: ')).trim().toUpperCase() !== "ДА")
          throw Error("Подключение отменено. Настройки не изменены.");
      } finally { prompt.close(); }
    }
    const info = await bindData(resolve(folder));
    console.log(`Подключено: ${info.dataDir}\nАккаунтов: ${info.counts.users}; проектов: ${info.counts.projects}; документов: ${info.counts.files}.`);
    if (info.backupDir) console.log(`Первая резервная копия проверена: ${info.backupDir}`);
    else console.log("Эта папка уже подключена. Настройки сохранены.");
    console.log("Теперь откройте ЗАПУСТИТЬ.cmd. Повторно подключать папку не нужно.");
  } else if (command === "backup") {
    console.log("Все старые версии приложения должны быть остановлены. Создаётся копия базы и документов...");
    console.log(`Резервная копия создана и проверена: ${await backupData({ destination: first })}\nСкопируйте всю полученную папку на отдельный внешний диск.`);
  } else if (command === "status") {
    const info = inspectData(configuredData());
    console.log(`Данные: ${info.dataDir}\nАккаунтов: ${info.counts.users}; проектов: ${info.counts.projects}; документов: ${info.counts.files}.`);
  } else if (command === "verify" && first) {
    const info = verifyBackup(resolve(first));
    console.log(`Копия проверена: ${info.dataDir}\nАккаунтов: ${info.counts.users}; проектов: ${info.counts.projects}; документов: ${info.counts.files}.`);
  } else if (command === "restore" && first && second) {
    const info = restoreBackup(resolve(first), resolve(second));
    console.log(`Копия восстановлена в новую папку: ${info.dataDir}`);
    if (existsSync(defaultSettingsFile()))
      console.log("На этом компьютере уже есть настройки. Они не изменены. Для безопасного переключения сообщите помощнику путь восстановленной папки; прежние данные и настройки не удаляйте.");
    else console.log(`Для подключения: node storage-cli.mjs bind "${info.dataDir}"`);
  } else throw Error('Команды: init, bind [папка данных], backup [папка копий], status, verify "копия", restore "копия" "новая папка".');
} catch (error) {
  console.error(`Операция остановлена: ${error.message}\nНе удаляйте прежние данные или настройки. Если копирование прервалось, неполная копия не заменяет предыдущие.`);
  process.exitCode = 1;
}

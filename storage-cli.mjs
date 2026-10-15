import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { bindData, backupData, configuredData, inspectData, verifyBackup, restoreBackup, defaultSettingsFile } from "./data-storage.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const [command, first, second] = process.argv.slice(2);
try {
  if (command === "bind") {
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
  } else throw Error('Команды: bind [папка данных], backup [папка копий], status, verify "копия", restore "копия" "новая папка".');
} catch (error) {
  console.error(`Операция остановлена: ${error.message}\nНе удаляйте прежние данные или настройки. Если копирование прервалось, неполная копия не заменяет предыдущие.`);
  process.exitCode = 1;
}

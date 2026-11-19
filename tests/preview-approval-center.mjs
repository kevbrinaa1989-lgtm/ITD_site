import { networkInterfaces } from "node:os";
import { seedApprovalDemo } from "./approval-demo.mjs";
import { ownershipFixture } from "./ownership-fixture.mjs";

// A fresh disposable project on each launch, independent of configured storage.
const host = process.argv[2] || "127.0.0.1";
const localIPv4 = Object.values(networkInterfaces()).flat()
  .some((address) => address.family === "IPv4" && address.address === host);
if (host !== "127.0.0.1" &&
    !(localIPv4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host))) {
  throw Error("Укажите локальный IPv4-адрес этого компьютера в сети Wi-Fi.");
}

const f = await ownershipFixture({ host, port: Number(process.argv[3] || 4175) });
try {
  const firstUse = process.argv.includes("--first-use");
  const { project, full, mobile, corrected } = await seedApprovalDemo(f, { firstPlanPages: 5, firstUse });
  console.log(`Кабинет: ${f.base}/cabinet
Клиент: ${f.clients[0].email}
Дизайнер: admin@example.test
Пароль демопользователей: ${f.password}
Проект: ${project.title}
40 материалов: ${full.title} (первый PDF — пять страниц)
Samsung Internet / Chrome Android / Safari: ${mobile.slice(0, 3).map(s => s.title).join(" / ")}
Файл v2 для загрузки дизайнером (после входа): ${f.base}/api/files/${corrected.id}/download
Остановить демоверсию: Ctrl+C.`);
  if (firstUse) console.log("Повторная приёмка: в этапе «" + mobile[0].title + "» откройте «План кухни» (исправление на листе 3) и «План спальни» (10 замечаний).");
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await f.close();
}

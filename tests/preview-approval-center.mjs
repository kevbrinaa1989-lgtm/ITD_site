import { networkInterfaces } from "node:os";
import { buffer } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import { ownershipFixture } from "./ownership-fixture.mjs";

// A fresh disposable project on each launch, independent of configured storage.
const host = process.argv[2] || "127.0.0.1";
const localIPv4 = Object.values(networkInterfaces()).flat()
  .some((address) => address.family === "IPv4" && address.address === host);
if (host !== "127.0.0.1" &&
    !(localIPv4 && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host))) {
  throw Error("Укажите локальный IPv4-адрес этого компьютера в сети Wi-Fi.");
}

async function drawing(pages, revised = false) {
  const pdf = new PDFDocument({ size: [640, 420], margin: 32, autoFirstPage: false });
  const bytes = buffer(pdf);
  const font = fileURLToPath(new URL("../assets/fonts/itd-font-1.ttf", import.meta.url));
  for (let page = 1; page <= pages; page++) {
    pdf.addPage().font(font).fillColor("#25372f").fontSize(20)
      .text("Балтика · Демонстрационный план", 38, 32);
    pdf.fontSize(13).text(`Версия ${revised ? 2 : 1} · Лист ${page} из ${pages}`, 38, 66);
    const wall = revised && page === 2 ? 330 : 275;
    pdf.lineWidth(4).rect(62, 122, 510, 206).stroke("#51665a")
      .moveTo(wall, 122).lineTo(wall, 246).stroke();
    pdf.fontSize(14).text("Гостиная", 96, 155).text("Кухня", 395, 155);
    pdf.fontSize(12).text(page === 2 ? "Положение перегородки" : "План помещений", 62, 352);
  }
  pdf.end();
  return (await bytes).toString("base64");
}

const f = await ownershipFixture({ host, port: 4175 });
try {
  const project = f.projects[0];
  const upload = (name, data, stage, category = "result") => f.api(
    `/api/projects/${project.id}/files`,
    { name, data, contentType: "application/pdf", category, stageId: stage?.id ?? null, review: !!stage },
    f.admin, "POST", 201,
  );
  const [onePage, twoPages, revision] = await Promise.all([drawing(1), drawing(2), drawing(3, true)]);
  const [full, ...mobile] = project.stages;
  for (let i = 1; i <= 40; i++) {
    await upload(`План-${String(i).padStart(2, "0")}.pdf`, i <= 35 ? onePage : twoPages, full);
  }
  // Independent pairs let each physical browser run through to stage acceptance.
  for (const stage of mobile.slice(0, 3)) {
    await upload("01-Общий-план.pdf", onePage, stage);
    await upload("02-Перегородка.pdf", twoPages, stage);
  }
  const corrected = await upload("Перегородка-v2.pdf", revision, null, "document");
  console.log(`Кабинет: ${f.base}/cabinet
Клиент: ${f.clients[0].email}
Дизайнер: admin@example.test
Пароль демопользователей: ${f.password}
Проект: ${project.title}
40 материалов: ${full.title}
Samsung Internet / Chrome Android / Safari: ${mobile.slice(0, 3).map(s => s.title).join(" / ")}
Файл v2 для загрузки дизайнером (после входа): ${f.base}/api/files/${corrected.id}/download
Остановить демоверсию: Ctrl+C.`);
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
} finally {
  await f.close();
}

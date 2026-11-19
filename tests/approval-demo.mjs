import { buffer } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import PDFDocument from "pdfkit";

// Vector originals in the disposable fixture. The preview uses the same file API and PDF renderer as a client project.
export async function drawing(title, pages, revised = false) {
  const pdf = new PDFDocument({
    size: [800, 490],
    margin: 0,
    autoFirstPage: false,
  });
  const bytes = buffer(pdf);
  const font = fileURLToPath(
    new URL("../assets/fonts/itd-font-1.ttf", import.meta.url),
  );
  const ink = "#343734",
    light = "#969993";
  function line(x, y, x2, y2, width = 0.8, color = ink) {
    pdf.lineWidth(width).moveTo(x, y).lineTo(x2, y2).stroke(color);
  }
  function box(x, y, w, h, fill = "white", color = light, r = 0) {
    pdf.lineWidth(0.8).roundedRect(x, y, w, h, r).fillAndStroke(fill, color);
  }
  function text(value, x, y, size = 10, width = 160, align = "left") {
    pdf
      .fillColor(ink)
      .fontSize(size)
      .text(value, x, y, { width, align, lineBreak: false });
  }
  function wall(x, y, w, h) {
    box(x, y, w, h, "#858982", ink);
    pdf.save().rect(x, y, w, h).clip();
    for (let a = x - h; a < x + w; a += 4)
      line(a, y + h, a + h, y, 0.4, "#c4c6c0");
    pdf.restore();
  }
  function door(x, y, size, left = false) {
    const sign = left ? -1 : 1;
    line(x, y, x, y - size, 1);
    pdf
      .lineWidth(0.65)
      .moveTo(x, y - size)
      .bezierCurveTo(
        x + sign * size * 0.55,
        y - size,
        x + sign * size,
        y - size * 0.55,
        x + sign * size,
        y,
      )
      .stroke(light);
  }
  function windowLine(x, y, w) {
    box(x, y, w, 7);
    line(x, y + 3.5, x + w, y + 3.5, 0.6);
    line(x + w / 2, y, x + w / 2, y + 7, 0.6);
  }
  function dimension(x, y, x2, y2, label) {
    line(x, y, x2, y2, 0.6, light);
    for (const [a, b] of [
      [x, y],
      [x2, y2],
    ]) {
      line(a - 3, b + 3, a + 3, b - 3, 0.8);
    }
    if (y === y2) text(label, x + (x2 - x) / 2 - 28, y - 14, 9, 56, "center");
    else {
      pdf.save().rotate(-90, { origin: [x - 7, (y + y2) / 2] });
      text(label, x - 36, (y + y2) / 2 - 9, 9, 58, "center");
      pdf.restore();
    }
  }
  for (let page = 1; page <= pages; page++) {
    pdf.addPage().font(font);
    text("Балтика", 32, 16, 20, 470);
    text(title, 32, 45, 12, 500);
    line(32, 67, 768, 67, 0.75);
    dimension(114, 92, 688, 92, "11 480");
    dimension(86, 112, 86, 398, "5 720");
    const divide = revised && page === 2 ? 392 : 384;
    wall(109, 108, 584, 9);
    wall(109, 108, 9, 293);
    wall(684, 108, 9, 293);
    wall(109, 392, 335, 9);
    wall(488, 392, 205, 9);
    wall(divide, 117, 7, 132);
    wall(divide, 281, 7, 48);
    wall(divide, 247, 30, 7);
    wall(divide + 65, 247, 84, 7);
    wall(divide + 144, 117, 7, 136);
    wall(divide + 144, 247, 155, 7);
    wall(554, 294, 130, 7);
    wall(552, 294, 7, 35);
    wall(552, 362, 7, 30);
    wall(118, 288, 118, 6);
    wall(267, 288, 55, 6);
    wall(315, 288, 7, 104);
    windowLine(143, 109, 170);
    windowLine(548, 109, 109);
    windowLine(154, 393, 116);
    windowLine(594, 393, 65);
    door(divide, 281, 31, true);
    door(divide + 31, 251, 34);
    door(236, 291, 31);
    door(556, 361, 32, true);
    door(444, 397, 42);
    // Furniture outlines, fittings and fixtures remain legible at normal zoom.
    box(135, 130, 145, 47, "#f4f4f1", ink, 4);
    for (let i = 0; i < 3; i++)
      box(139 + i * 46, 135, 44, 34, "white", light, 3);
    box(138, 171, 141, 7, "#efefeb", light, 2);
    box(168, 201, 65, 32, "white", light, 12);
    box(301, 156, 53, 69, "#f3f3f0", ink, 9);
    for (const x of [307, 332])
      for (const y of [146, 224]) box(x, y, 16, 11, "white", light, 3);
    for (const x of [291, 353]) box(x, 178, 10, 24, "white", light, 3);
    box(405, 126, 83, 34, "#eeeeeb", ink, 3);
    box(410, 129, 72, 26, "white", light, 11);
    box(497, 169, 23, 26, "white", light, 8);
    box(493, 203, 30, 32);
    box(497, 209, 22, 16, "white", light, 5);
    box(566, 126, 85, 94, "white", ink, 3);
    box(570, 130, 36, 17, "#f1f1ee", light, 4);
    box(609, 130, 36, 17, "#f1f1ee", light, 4);
    box(569, 153, 79, 64, "#f6f6f3", light, 2);
    line(570, 162, 646, 162);
    for (const x of [542, 657]) box(x, 129, 18, 21);
    box(121, 298, 27, 89, "#f0f0ec");
    box(148, 361, 160, 26, "#f0f0ec");
    box(160, 364, 36, 19);
    for (const x of [167, 184])
      for (const y of [369, 378])
        pdf.lineWidth(0.6).circle(x, y, 3.5).stroke(light);
    box(252, 364, 34, 17, "white", light, 3);
    box(256, 367, 24, 11, "white", light, 2);
    box(572, 311, 95, 31, "#f5f5f2");
    box(600, 315, 29, 15);
    box(607, 343, 26, 14, "white", light, 5);
    box(326, 330, 40, 58, "#f8f8f6");
    for (let i = 1; i < 3; i++)
      line(326, 330 + i * 19, 366, 330 + i * 19, 0.6, light);
    text("Гостиная", 155, 254, 11);
    text("Кухня", 188, 318, 11);
    text("Санузел", 421, 200, 10);
    text("Спальня", 568, 225, 10);
    text("Прихожая", 415, 307, 11);
    text("Кабинет", 595, 367, 10);
    line(32, 438, 768, 438, 0.75);
    text(`Лист ${page} из ${pages}`, 32, 450, 10);
    text("М 1:50", 688, 450, 10, 80, "right");
  }
  pdf.end();
  return (await bytes).toString("base64");
}

export async function seedApprovalDemo(f, { firstPlanPages = 1 } = {}) {
  const project = f.projects[0],
    [full, ...mobile] = project.stages;
  const db = new DatabaseSync(join(f.dataDir, "itd.sqlite"));
  async function upload(title, bytes, stage, category = "result") {
    const file = await f.api(
      `/api/projects/${project.id}/files`,
      {
        name: title + ".pdf",
        data: bytes,
        contentType: "application/pdf",
        category,
        stageId: stage?.id ?? null,
        review: !!stage,
      },
      f.admin,
      "POST",
      201,
    );
    if (file.review)
      db.prepare("UPDATE review_materials SET title=? WHERE id=?").run(
        title,
        file.review.materialId,
      );
    return file;
  }
  try {
    const subjects = [
      "Обмерный план",
      "План помещений",
      "План мебели",
      "План оборудования",
      "План перегородок",
      "План дверных проёмов",
      "План привязок",
      "План полов",
      "План потолков",
      "План освещения",
    ];
    const groups = ["", " · секция Б", " · секция В", " · секция Г"];
    for (const group of groups) {
      for (const subject of subjects) {
        const title = subject + group;
        const pages = subject === "План перегородок" || group === groups[3] ? 2 : 1;
        await upload(title, await drawing(title, title === subjects[0] ? firstPlanPages : pages), full);
      }
    }
    for (const stage of mobile.slice(0, 3)) {
      await upload("Общий план", await drawing("Общий план", 1), stage);
      await upload(
        "План перегородок",
        await drawing("План перегородок", 2),
        stage,
      );
    }
    const corrected = await upload(
      "Перегородка-v2",
      await drawing("Уточнённый план", 3, true),
      null,
      "document",
    );
    return { project, full, mobile, corrected };
  } finally {
    db.close();
  }
}

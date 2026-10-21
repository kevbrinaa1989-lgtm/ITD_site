export function validateProfile(body, fail) {
  if (
    !Object.keys(body).length ||
    Object.keys(body).some((k) => !["name", "phone"].includes(k))
  )
    fail(400, "Разрешено изменять только имя и телефон");
  const fields = {};
  if ("name" in body) {
    if (
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.length > 200
    )
      fail(400, "Укажите имя до 200 символов");
    fields.name = body.name.trim();
  }
  if ("phone" in body) {
    if (
      body.phone !== null &&
      (typeof body.phone !== "string" ||
        body.phone.length > 40 ||
        !/^[+\d() .-]*$/.test(body.phone))
    )
      fail(400, "Укажите телефон до 40 символов: цифры, +, пробелы и скобки");
    fields.phone =
      typeof body.phone === "string" ? body.phone.trim() || null : null;
  }
  return fields;
}

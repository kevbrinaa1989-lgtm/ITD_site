export const button = (root, name) =>
  root.getByRole("button", { name, exact: true });

export async function menu(page) {
  const details = page.locator(".ac-menu");
  await details.waitFor();
  if (!(await details.evaluate((element) => element.open)))
    await details.locator("summary").click();
}
export async function action(page, name) {
  await menu(page);
  await button(page.locator(".ac-menu-items"), name).click();
}
export async function notes(page) {
  if (await page.locator(".ac-rail").isVisible()) return;
  if (await page.locator(".ac-compare").isVisible())
    await button(page.locator(".ac-footer"), "Замечания и история").click();
  else await action(page, "Замечания и история");
}
export async function closeNotes(page) {
  if (await page.locator(".ac-rail").isVisible())
    await button(page, "Закрыть панель").click();
}
export async function queue(page) {
  await page.locator(".ac-view-heading").waitFor();
  const toggle = button(page, "Материалы");
  if (await toggle.isVisible()) await toggle.click();
}
export async function saved(page) {
  await page
    .locator('.ac-save[data-state="saved"]')
    .getByText("Сохранено", { exact: true })
    .waitFor();
}
export async function summary(page) {
  await page.getByRole("button", { name: /^К отправке ·/ }).click();
}
export async function markForRevision(page, text, position = { x: 1, y: 1 }) {
  await button(page, "Нужны правки").click();
  const doc = page.getByRole("dialog");
  await doc.getByLabel("Текст замечания", { exact: true }).fill(text);
  await button(doc, "Поставить отметку на документе").click();
  await page.locator(".ac-sheet").click({ position });
  await button(doc, "Подготовить и далее").click();
  await saved(page);
}

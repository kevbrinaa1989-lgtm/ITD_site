export async function dismissWelcome(page) {
  await page.waitForFunction(
    () => document.body.dataset.cabinetReady === "true",
  );
  const overlay = page.locator("#itd-tour-layer");
  if (await overlay.isVisible()) {
    await overlay.getByRole("button", { name: "Пропустить" }).click();
    await overlay.waitFor({ state: "detached" });
  }
}

export async function openGlobal(page, key) {
  await page.locator("#app-view").waitFor({ state: "visible" });
  await dismissWelcome(page);
  if (!(await closeUpload(page))) return false;
  const tab = page.locator(`#tab-${key}`);
  if (!(await tab.isVisible()))
    await page.locator("#mobile-menu-button").click();
  await tab.click();
}

// Use the visible catalog, so regressions exercise the same route as a person.
export async function openProject(
  page,
  project,
  { client = false, wait = true } = {},
) {
  if (
    (await openGlobal(page, client ? "client-projects" : "projects")) === false
  )
    return;
  const catalog = page.locator(
    client ? "#client-projects-panel" : "#admin-project-list",
  );
  const card =
    typeof project === "number"
      ? catalog.locator(`[data-project-id="${project}"]`)
      : client
        ? catalog
            .locator(".client-project-card")
            .filter({ hasText: project })
            .locator("button[data-project-id]")
        : catalog.locator("[data-project-id]").filter({ hasText: project });
  await card.click();
  if (!wait) return;
  await page.locator("#project-heading").waitFor({ state: "visible" });
  if (typeof project === "string") {
    await page.waitForFunction(
      (title) =>
        document.querySelector("#project-title")?.textContent === title,
      project,
    );
  }
}

export async function closeUpload(page) {
  if (await page.locator("#library-upload-dialog").isVisible()) {
    await page.locator("#library-upload-close").click();
    if (await page.locator("#library-upload-dialog").isVisible()) return false;
  }
  return true;
}
export async function openFiles(
  page,
  category = "all",
  { album = false } = {},
) {
  await closeUpload(page);
  await page.locator("#tab-files").click();
  await page.locator(`[data-library-category="${category}"]`).click();
  if (album) await page.locator("#library-album-toggle").click();
}
export async function openUpload(page, { document = false } = {}) {
  if (await page.locator("#library-upload-dialog").isVisible()) return;
  if (await page.locator("#panel-files").isVisible()) {
    await page
      .locator(`[data-library-category="${document ? "document" : "result"}"]`)
      .click();
    await page.locator("#library-upload").click();
    await page.locator("#upload-file-form").waitFor({ state: "visible" });
    return;
  }
  await page
    .locator("#project-actions")
    .getByRole("button", {
      name: document ? "Добавить документ" : "Загрузить материал",
      exact: true,
    })
    .click();
  await page.locator("#upload-file-form").waitFor({ state: "visible" });
}

export async function openGlobal(page, key) {
  await page.locator("#app-view").waitFor({ state: "visible" });
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
  await openGlobal(page, client ? "client-projects" : "projects");
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

export async function openUpload(page, { document = false } = {}) {
  await page
    .locator("#project-actions")
    .getByRole("button", {
      name: document ? "Добавить документ" : "Загрузить материал",
      exact: true,
    })
    .click();
  await page.locator("#upload-file-form").waitFor({ state: "visible" });
}

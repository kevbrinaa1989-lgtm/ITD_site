// Explicitly prepare the viewing prerequisite in fixtures using the legacy decision API.
// Production callers must record actual page renders and a separate user confirmation.
export async function confirmFixtureReview(post, versionId) {
  const path = `/api/approval-center/versions/${versionId}/view`;
  const result = await post(path, { page: 1, downloaded: true });
  for (let page = 2; page <= result.pageCount; page++)
    await post(path, { page });
  await post(path, { confirm: true });
}

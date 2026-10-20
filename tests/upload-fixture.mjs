// API fixtures use the same explicit session/project/recipient handshake as the UI.
// Negative requests still reach /files even when intent preparation is rejected,
// so existing authorization, validation and no-write assertions remain exercised.
export async function prepareFixtureUpload(
  base,
  path,
  body,
  cookie,
  method = "POST",
  options = {},
) {
  if (
    method !== "POST" ||
    !/^\/api\/projects\/\d+\/files$/.test(path) ||
    !body ||
    Object.hasOwn(body, "uploadIntent")
  )
    return body;
  const scope = Object.hasOwn(body, "materialId")
    ? { materialId: body.materialId, expectedVersionId: body.expectedVersionId }
    : {};
  const response = await fetch(
    base + path.replace(/\/files$/, "/upload-intents"),
    {
      method: "POST",
      headers: {
        Origin: options.origin ?? base,
        "Content-Type": "application/json",
        ...(options.csrf === false ? {} : { "X-ITD-Request": "1" }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(options.headers || {}),
      },
      body: JSON.stringify(scope),
    },
  );
  const result = await response.json();
  return response.ok ? { ...body, uploadIntent: result.uploadIntent } : body;
}

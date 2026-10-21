import { isIP } from "node:net";
const fail = (message) => {
  throw Object.assign(new Error(message), { status: 403 });
};
const loopback = (ip) =>
  ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
export function createSecurityPolicy(options = {}) {
  const internetMode =
    options.internetMode ?? process.env.ITD_INTERNET_MODE === "1";
  let origin;
  if (internetMode) {
    const value = options.publicOrigin ?? process.env.PUBLIC_ORIGIN;
    try {
      origin = new URL(value);
      if (
        origin.protocol !== "https:" ||
        origin.origin !== value ||
        origin.username ||
        origin.password
      )
        throw Error();
    } catch {
      throw Error(
        "Для интернет-режима задайте PUBLIC_ORIGIN как точный HTTPS-адрес без пути и завершающего слеша.",
      );
    }
  }
  function apply(req, res) {
    req.itdClientIP = req.socket.remoteAddress || "unknown";
    if (!internetMode) return;
    if (!loopback(req.socket.remoteAddress))
      fail("Доступ разрешён только через доверенный HTTPS-прокси.");
    if (req.headers.host !== origin.host) fail("Недопустимый адрес сервера.");
    if (req.headers["x-forwarded-proto"] !== "https")
      fail("Требуется защищённое соединение HTTPS.");
    const ip = req.headers["x-real-ip"];
    if (typeof ip !== "string" || !isIP(ip))
      fail("Не удалось проверить адрес клиента.");
    req.itdClientIP =
      ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
    if (
      req.headers.origin !== undefined &&
      req.headers.origin !== origin.origin
    )
      fail("Недопустимый источник запроса.");
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );
  }
  return {
    internetMode,
    registrationAllowed: !internetMode,
    secureCookies: internetMode || !!options.secureCookies,
    apply,
    validOrigin: (req) =>
      internetMode ? req.headers.origin === origin.origin : null,
  };
}

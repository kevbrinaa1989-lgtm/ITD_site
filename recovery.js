"use strict";
(() => {
  // Keep the single-use credential only in this closure and remove it from the URL.
  let token = location.hash.slice(1);
  history.replaceState(null, "", location.pathname);
  const form = document.getElementById("reset-password-form");
  const output = document.getElementById("reset-message");
  const help = document.getElementById("reset-help");
  const password = document.getElementById("reset-password");
  const confirmation = document.getElementById("reset-password-confirm");
  const submit = form.querySelector("button");
  const say = (text, error = false) => {
    output.textContent = text;
    output.classList.toggle("error", error);
    output.setAttribute("role", error ? "alert" : "status");
  };
  if (!/^[a-f0-9]{64}$/.test(token)) {
    token = "";
    form.hidden = true;
    help.hidden = false;
    say(
      "Ссылка недействительна или не содержит данных для восстановления.",
      true,
    );
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled || !token) return;
    if (password.value !== confirmation.value) {
      say("Пароли не совпадают. Повторите новый пароль ещё раз.", true);
      confirmation.focus();
      return;
    }
    submit.disabled = true;
    form.setAttribute("aria-busy", "true");
    say("Сохраняем новый пароль…");
    try {
      const response = await fetch("/api/password-recovery/reset", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json", "X-ITD-Request": "1" },
        body: JSON.stringify({
          token,
          password: password.value,
          passwordConfirm: confirmation.value,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        password.value = "";
        confirmation.value = "";
        if ([400, 404, 410].includes(response.status)) help.hidden = false;
        throw new Error(
          result.error ||
            result.message ||
            "Не удалось сменить пароль. Попробуйте ещё раз.",
        );
      }
      token = "";
      form.reset();
      form.hidden = true;
      say("Пароль изменён. Теперь войдите в кабинет с новым паролем.");
      document.getElementById("reset-login").hidden = false;
      document.getElementById("reset-login").focus();
    } catch (error) {
      say(error.message || "Нет связи с сервером. Попробуйте ещё раз.", true);
    } finally {
      submit.disabled = false;
      form.removeAttribute("aria-busy");
    }
  });
  window.addEventListener("pagehide", () => {
    token = "";
    form.reset();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      form.hidden = true;
      help.hidden = false;
      say("Откройте ссылку заново, чтобы продолжить восстановление.", true);
    }
  });
})();

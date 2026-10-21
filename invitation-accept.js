"use strict";
(() => {
  let token = location.hash.slice(1).replace(/^token=/, "");
  history.replaceState(null, "", location.pathname);
  let epoch = 0;
  const form = document.getElementById("invitation-accept-form"),
    output = document.getElementById("invitation-accept-message"),
    help = document.getElementById("invitation-accept-help"),
    password = document.getElementById("invitation-password"),
    confirmation = document.getElementById("invitation-password-confirm"),
    submit = form.querySelector("button");
  const say = (text, error = false) => {
    output.textContent = text;
    output.classList.toggle("error", error);
    output.setAttribute("role", error ? "alert" : "status");
  };
  if (!/^[a-f0-9]{64}$/.test(token)) {
    token = "";
    form.hidden = true;
    help.hidden = false;
    say("Ссылка приглашения недействительна.", true);
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled || !token) return;
    if (password.value !== confirmation.value) {
      say("Пароли не совпадают. Повторите пароль ещё раз.", true);
      confirmation.focus();
      return;
    }
    const generation = epoch;
    submit.disabled = true;
    form.setAttribute("aria-busy", "true");
    say("Создаём аккаунт…");
    try {
      const response = await fetch("/api/invitations/accept", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json", "X-ITD-Request": "1" },
        body: JSON.stringify({
          token,
          name: document.getElementById("invitation-name").value,
          password: password.value,
          passwordConfirm: confirmation.value,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (generation !== epoch) return;
      if (!response.ok) {
        password.value = "";
        confirmation.value = "";
        if ([400, 404, 409, 410].includes(response.status)) help.hidden = false;
        throw new Error(
          result.error ||
            result.message ||
            "Не удалось принять приглашение. Попробуйте ещё раз.",
        );
      }
      token = "";
      form.reset();
      form.hidden = true;
      say(
        "Аккаунт создан. Войдите с email, который вы согласовали со студией, и новым паролем.",
      );
      const login = document.getElementById("invitation-login");
      login.hidden = false;
      login.focus();
    } catch (error) {
      if (generation !== epoch) return;
      say(
        error instanceof TypeError
          ? "Нет связи с сервером. Попробуйте ещё раз."
          : error.message,
        true,
      );
    } finally {
      submit.disabled = false;
      form.removeAttribute("aria-busy");
    }
  });
  window.addEventListener("pagehide", () => {
    epoch++;
    token = "";
    form.reset();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      form.hidden = true;
      help.hidden = false;
      say("Откройте приглашение заново, чтобы продолжить.", true);
    }
  });
})();

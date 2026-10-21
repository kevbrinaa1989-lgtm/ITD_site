"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const statuses = {
    pending: "Действует",
    new: "Действует",
    active: "Действует",
    used: "Использовано",
    expired: "Истекло",
    revoked: "Отменено",
  };
  let hooks,
    epoch = 0,
    sequence = 0,
    memory = null,
    busy = false;
  const valid = (g) => g === epoch && hooks.getUser()?.role === "admin";
  const date = (value) =>
    value ? new Date(value).toLocaleString("ru-RU") : "—";
  const message = (text, error = false) => {
    const n = $("invitation-message");
    n.textContent = text;
    n.classList.toggle("error", error);
    n.setAttribute("role", error ? "alert" : "status");
  };
  function reset() {
    epoch++;
    sequence++;
    memory = null;
    busy = false;
    $("invitation-form").reset();
    $("invitation-list").replaceChildren();
    $("invitation-link").replaceChildren();
    message("");
  }
  function showLink() {
    const host = $("invitation-link");
    host.replaceChildren();
    if (!memory) return;
    const current = memory;
    host.append(
      el(
        "p",
        `Приглашение для ${current.email}. Действует до ${date(current.expiresAt)}. Ссылка показывается только в этой сессии.`,
        "muted",
      ),
    );
    const copy = el("button", "Скопировать ссылку", "primary");
    copy.type = "button";
    copy.addEventListener("click", async () => {
      const generation = epoch;
      if (!valid(generation) || memory !== current) return;
      if (Date.parse(current.expiresAt) <= Date.now()) {
        memory = null;
        showLink();
        message("Срок приглашения истёк. Создайте новое.", true);
        return;
      }
      try {
        await navigator.clipboard.writeText(current.url);
        if (valid(generation) && memory === current)
          message(
            "Ссылка скопирована. Передайте её только проверенному получателю.",
          );
      } catch {
        if (
          !valid(generation) ||
          memory !== current ||
          host.querySelector("input")
        )
          return;
        const input = el("input");
        input.type = "text";
        input.readOnly = true;
        input.autocomplete = "off";
        input.value = current.url;
        input.setAttribute(
          "aria-label",
          "Ссылка приглашения для ручного копирования",
        );
        host.append(
          el(
            "p",
            "Выделите ссылку и скопируйте через меню браузера. Не публикуйте её в общем доступе.",
            "muted",
          ),
          input,
        );
        input.focus();
        input.select();
      }
    });
    host.append(copy);
  }
  async function load() {
    if (hooks.getUser()?.role !== "admin") return;
    const generation = epoch,
      seq = ++sequence;
    try {
      const result = await hooks.api("/api/admin/invitations");
      if (!valid(generation) || seq !== sequence) return;
      const list = $("invitation-list");
      list.replaceChildren();
      for (const invite of result.invitations) {
        const card = el("article", undefined, "invitation-card");
        const status = invite.status;
        card.append(
          el("strong", invite.email),
          el(
            "p",
            `${statuses[status] || status} · Создано: ${date(invite.createdAt)} · До: ${date(invite.expiresAt)}`,
            "muted",
          ),
        );
        if (!["used", "expired", "revoked"].includes(status)) {
          const revoke = el("button", "Отменить приглашение", "text-button");
          revoke.type = "button";
          revoke.addEventListener("click", async () => {
            if (
              !window.confirm(
                `Отменить приглашение для ${invite.email}? Ссылка перестанет работать.`,
              )
            )
              return;
            revoke.disabled = true;
            const g = epoch;
            try {
              await hooks.api(
                `/api/admin/invitations/${invite.id}/revoke`,
                "POST",
                {},
              );
              if (!valid(g)) return;
              if (memory?.id === invite.id) {
                memory = null;
                showLink();
              }
              await load();
              message("Приглашение отменено.");
            } catch (error) {
              if (valid(g)) message(error.message, true);
            } finally {
              revoke.disabled = false;
            }
          });
          card.append(revoke);
        }
        if (
          memory?.id === invite.id &&
          ["used", "expired", "revoked"].includes(status)
        ) {
          memory = null;
          showLink();
        }
        list.append(card);
      }
      if (!list.childElementCount)
        list.append(el("p", "Приглашений пока нет.", "empty-note"));
    } catch (error) {
      if (valid(generation) && seq === sequence) message(error.message, true);
    }
  }
  function init(options) {
    hooks = options;
    $("invitation-refresh").addEventListener("click", load);
    $("invitation-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy || hooks.getUser()?.role !== "admin") return;
      const form = event.currentTarget,
        values = Object.fromEntries(new FormData(form));
      if (!values.verified) return;
      const generation = epoch;
      busy = true;
      const controls = [...form.querySelectorAll("input,button")];
      controls.forEach((n) => (n.disabled = true));
      message("");
      try {
        const result = await hooks.api("/api/admin/invitations", "POST", {
          email: values.email,
          confirmVerified: true,
        });
        if (!valid(generation)) return;
        const path = result.invitationPath,
          url = new URL(path, location.origin);
        if (
          url.origin !== location.origin ||
          !/^\/(?:accept-invitation|invitation)\/?$/.test(url.pathname) ||
          !/^#(?:token=)?[a-f0-9]{64}$/.test(url.hash)
        )
          throw new Error(
            "Приглашение создано, но ссылка имеет неожиданный формат. Создайте новое приглашение.",
          );
        memory = {
          id: result.invitation.id,
          email: result.invitation.email,
          expiresAt: result.invitation.expiresAt,
          url: url.href,
        };
        form.reset();
        showLink();
        await load();
        if (valid(generation))
          message(
            "Приглашение создано. Проверьте получателя и передайте ссылку лично.",
          );
      } catch (error) {
        if (valid(generation)) message(error.message, true);
      } finally {
        if (valid(generation)) busy = false;
        controls.forEach((n) => (n.disabled = false));
      }
    });
  }
  function onTab(tab) {
    if (tab === "clients") load();
  }
  window.ITDInvitations = { init, reset, onTab };
})();

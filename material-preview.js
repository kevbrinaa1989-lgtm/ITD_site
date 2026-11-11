"use strict";
// One protected preview per review workspace. The owner disposes it on navigation.
(() => {
  const el = window.ITDUI.node;
  let dispose = () => {};
  function clear() {
    dispose();
    dispose = () => {};
  }
  function mount(host, file, onRendered) {
    clear();
    let alive = true,
      url,
      task,
      renderTask,
      pdf,
      page = 1,
      serial = 0,
      reported = false;
    const controller = new AbortController();
    const status = el("p", "Загрузка материала…", "material-preview-status");
    status.setAttribute("role", "status");
    const media = el("div", undefined, "material-preview-media");
    host.append(media, status);
    const visible = () =>
      alive && host.isConnected && !!host.getClientRects().length;
    const report = () => {
      if (visible() && !reported) {
        reported = true;
        onRendered(file);
      }
    };
    const observer = new IntersectionObserver((entries) => {
      if (
        entries.some((e) => e.isIntersecting) &&
        host.dataset.loaded === "true"
      )
        report();
    });
    observer.observe(host);
    dispose = () => {
      alive = false;
      serial++;
      controller.abort();
      observer.disconnect();
      renderTask?.cancel();
      task?.destroy().catch(() => {});
      if (url) URL.revokeObjectURL(url);
      host.replaceChildren();
    };
    if (!window.ITDViewer.supported(file)) {
      status.textContent = "Для этого формата доступно скачивание оригинала.";
      return;
    }
    const expand = window.ITDViewer.control(file, [file], "На весь экран ↗");
    // One fullscreen action shared by the inline preview and accessibility tests.
    expand.className = "material-preview-expand file-preview";
    expand.setAttribute("aria-label", "Увеличить материал");
    host.append(expand);
    async function render() {
      const token = ++serial;
      renderTask?.cancel();
      const p = await pdf.getPage(page);
      if (!alive || token !== serial) return;
      const base = p.getViewport({ scale: 1 });
      const view = p.getViewport({
        scale: Math.min(1.5, 1400 / base.width, 1400 / base.height),
      });
      const canvas = el("canvas");
      canvas.width = Math.ceil(view.width);
      canvas.height = Math.ceil(view.height);
      canvas.setAttribute(
        "aria-label",
        `${file.name}, страница ${page} из ${pdf.numPages}`,
      );
      media.replaceChildren(canvas);
      renderTask = p.render({
        canvasContext: canvas.getContext("2d"),
        viewport: view,
      });
      await renderTask.promise;
      if (!alive || token !== serial) return;
      status.textContent = `Страница ${page} из ${pdf.numPages} · PDF`;
      previous.disabled = page <= 1;
      next.disabled = page >= pdf.numPages;
      host.dataset.loaded = "true";
      report();
    }
    const previous = window.ITDUI.button(
      "← Страница",
      () => {
        page--;
        return render();
      },
      "review-secondary",
    );
    const next = window.ITDUI.button(
      "Страница →",
      () => {
        page++;
        return render();
      },
      "review-secondary",
    );
    previous.disabled = next.disabled = true;
    async function load() {
      try {
        const r = await fetch(`/api/files/${file.id}/preview`, {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        if (r.status === 401)
          window.dispatchEvent(new Event("itd-preview-session-expired"));
        if (!r.ok)
          throw Error(
            "Не удалось загрузить материал. Попробуйте открыть или скачать оригинал.",
          );
        const bytes = await r.arrayBuffer();
        if (!alive) return;
        if (window.ITDViewer.image(file)) {
          url = URL.createObjectURL(
            new Blob([bytes], { type: file.contentType }),
          );
          const img = el("img");
          img.alt = file.name;
          img.onload = () => {
            if (!alive) return;
            host.dataset.loaded = "true";
            status.textContent =
              "Нажмите «На весь экран», чтобы рассмотреть детали";
            report();
          };
          img.onerror = () => {
            if (alive)
              status.textContent =
                "Изображение повреждено или не поддерживается. Скачайте оригинал.";
          };
          img.src = url;
          media.append(img);
        } else {
          const lib = await import("/vendor/pdfjs/pdf.mjs");
          if (!alive) return;
          lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
          task = lib.getDocument({
            data: new Uint8Array(bytes),
            isEvalSupported: false,
            enableXfa: false,
            cMapUrl: "/vendor/pdfjs/cmaps/",
            cMapPacked: true,
            standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
            wasmUrl: "/vendor/pdfjs/wasm/",
            iccUrl: "/vendor/pdfjs/iccs/",
          });
          pdf = await task.promise;
          if (!alive) return;
          const pager = el("div", undefined, "material-preview-pager");
          if (pdf.numPages > 1) {
            pager.append(previous, next);
            host.append(pager);
          }
          await render();
        }
      } catch (e) {
        if (
          alive &&
          e.name !== "AbortError" &&
          e.name !== "RenderingCancelledException"
        )
          status.textContent =
            e.message || "Предпросмотр недоступен. Скачайте оригинал.";
      }
    }
    load();
  }
  window.ITDMaterialPreview = { mount, clear };
})();

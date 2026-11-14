"use strict";
(() => {
  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  let prefetched = null;
  function clearPrefetch() {
    prefetched?.controller.abort();
    prefetched = null;
  }
  function prefetch(file) {
    if (
      !file ||
      file.size > 2 * 1024 * 1024 ||
      !window.ITDViewer.supported(file)
    ) {
      clearPrefetch();
      return;
    }
    if (prefetched?.id === file.id) return;
    clearPrefetch();
    const item = { id: file.id, controller: new AbortController() };
    prefetched = item;
    item.promise = fetch(`/api/files/${file.id}/preview`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: item.controller.signal,
    })
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null);
  }
  function mount(
    host,
    version,
    {
      markers = [],
      onPage = () => {},
      onMarker = () => {},
      onPosition = () => {},
      position = {},
      editable = true,
    } = {},
  ) {
    let alive = true,
      serial = 0,
      task,
      pdf,
      renderTask,
      blobUrl,
      media,
      page = position.page || 1,
      zoom = position.zoom || 1,
      addMode = false,
      pageSave = Promise.resolve();
    const abort = new AbortController(),
      viewport = el("div", undefined, "ac-viewport"),
      sheet = el("div", undefined, "ac-sheet"),
      tools = el("div", undefined, "ac-view-tools"),
      status = el("p", "Загрузка…", "ac-view-status");
    const btn = (name, fn) => {
      const b = el("button", name);
      b.type = "button";
      b.addEventListener("click", fn);
      return b;
    };
    viewport.tabIndex = 0;
    viewport.setAttribute(
      "aria-label",
      "Область просмотра: масштаб и перемещение",
    );
    viewport.append(sheet);
    const pageInput = el("input");
    pageInput.type = "number";
    pageInput.min = "1";
    pageInput.value = page;
    pageInput.setAttribute("aria-label", "Страница PDF");
    pageInput.hidden = true;
    const download = el("a", "Скачать оригинал");
    download.href = `/api/files/${version.file.id}/download`;
    download.download = version.file.name;
    const pin = btn("Добавить замечание", () => {
      addMode = !addMode;
      pin.setAttribute("aria-pressed", String(addMode));
      sheet.classList.toggle("ac-pin-mode", addMode);
    });
    pin.setAttribute("aria-pressed", "false");
    pin.hidden = !editable;
    tools.append(
      btn("−", () => setZoom(zoom - 0.25)),
      btn("100%", () => setZoom(1)),
      btn("+", () => setZoom(zoom + 0.25)),
      pageInput,
      pin,
      btn("На весь экран", () => {
        if (host.requestFullscreen) host.requestFullscreen().catch(() => {});
        else host.classList.toggle("ac-expanded");
      }),
      download,
    );
    const closeFull = btn("Свернуть", () => {
      if (document.fullscreenElement) document.exitFullscreen();
      host.classList.remove("ac-expanded");
    });
    tools.append(closeFull);
    host.append(tools, viewport, status);
    const positionChanged = () =>
      onPosition({
        page,
        zoom,
        scrollX: viewport.scrollLeft,
        scrollY: viewport.scrollTop,
      });
    function drawMarkers() {
      sheet.querySelectorAll(".ac-pin").forEach((n) => n.remove());
      for (const [i, n] of markers.entries())
        if (n.page === page) {
          const b = btn(String(n.number || i + 1), (e) => {
            e.stopPropagation();
            onMarker({ ...n, existing: true, index: n.draft ? n.index : i });
          });
          b.className = "ac-pin";
          b.style.left = `${n.x * 100}%`;
          b.style.top = `${n.y * 100}%`;
          b.setAttribute(
            "aria-label",
            `Замечание ${n.number || i + 1}: ${n.body}`,
          );
          sheet.append(b);
        }
    }
    function fit() {
      if (!media) return;
      const w = media.naturalWidth || media.width,
        h = media.naturalHeight || media.height;
      const ratio =
        Math.min(
          Math.max(200, viewport.clientWidth - 32) / w,
          Math.max(240, viewport.clientHeight - 24) / h,
          1,
        ) * zoom;
      sheet.style.width = `${w * ratio}px`;
      sheet.style.height = `${h * ratio}px`;
      media.style.width = "100%";
      media.style.height = "100%";
    }
    function setZoom(n) {
      zoom = Math.max(0.5, Math.min(4, n));
      fit();
      positionChanged();
    }
    async function render() {
      const seq = ++serial;
      renderTask?.cancel();
      status.textContent = "Подготовка страницы…";
      try {
        const p = await pdf.getPage(page);
        if (!alive || seq !== serial) return;
        const base = p.getViewport({ scale: 1 }),
          view = p.getViewport({
            scale: Math.min(2, 2000 / base.width, 2000 / base.height),
          });
        const canvas = el("canvas");
        canvas.width = Math.ceil(view.width);
        canvas.height = Math.ceil(view.height);
        canvas.setAttribute(
          "aria-label",
          `${version.file.name}, страница ${page}`,
        );
        const job = p.render({
          canvasContext: canvas.getContext("2d"),
          viewport: view,
        });
        renderTask = job;
        await job.promise;
        if (!alive || seq !== serial) return;
        media = canvas;
        sheet.replaceChildren(canvas);
        fit();
        drawMarkers();
        status.textContent = `Страница ${page} из ${pdf.numPages}`;
        pageInput.value = page;
        pageSave = Promise.resolve(onPage(page, pdf.numPages));
        await pageSave;
        positionChanged();
        p.cleanup();
      } catch (e) {
        if (alive && e.name !== "RenderingCancelledException")
          status.textContent = e.message;
      }
    }
    function go(n) {
      const next = Math.max(
        1,
        Math.min(pdf?.numPages || 1, Math.round(n) || 1),
      );
      if (next === page) return;
      page = next;
      if (pdf) render();
    }
    pageInput.onchange = () => go(Number(pageInput.value));
    sheet.addEventListener("click", (e) => {
      if (!addMode || !media || e.target.closest("button")) return;
      const r = sheet.getBoundingClientRect();
      onMarker({
        page,
        x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
        y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
        body: "",
      });
    });
    sheet.tabIndex = 0;
    sheet.setAttribute(
      "aria-label",
      "Материал. В режиме замечания Enter добавляет маркер в центре.",
    );
    sheet.addEventListener("keydown", (e) => {
      if (addMode && e.key === "Enter") {
        e.preventDefault();
        onMarker({ page, x: 0.5, y: 0.5, body: "" });
      }
    });
    let drag = null;
    viewport.addEventListener("pointerdown", (e) => {
      if (zoom > 1 && !addMode && !e.target.closest("button")) {
        drag = {
          x: e.clientX,
          y: e.clientY,
          left: viewport.scrollLeft,
          top: viewport.scrollTop,
        };
        viewport.setPointerCapture(e.pointerId);
      }
    });
    viewport.addEventListener("pointermove", (e) => {
      if (drag) {
        viewport.scrollLeft = drag.left + drag.x - e.clientX;
        viewport.scrollTop = drag.top + drag.y - e.clientY;
      }
    });
    viewport.addEventListener("pointerup", () => {
      drag = null;
      positionChanged();
    });
    let pinch = null;
    viewport.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length === 2)
          pinch = {
            d: Math.hypot(
              e.touches[0].clientX - e.touches[1].clientX,
              e.touches[0].clientY - e.touches[1].clientY,
            ),
            z: zoom,
          };
      },
      { passive: true },
    );
    viewport.addEventListener(
      "touchmove",
      (e) => {
        if (pinch && e.touches.length === 2) {
          e.preventDefault();
          setZoom(
            (pinch.z *
              Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX,
                e.touches[0].clientY - e.touches[1].clientY,
              )) /
              pinch.d,
          );
        }
      },
      { passive: false },
    );
    viewport.addEventListener("touchend", () => {
      pinch = null;
    });
    let scrollTimer;
    viewport.addEventListener(
      "scroll",
      () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(positionChanged, 200);
      },
      { passive: true },
    );
    const resize = new ResizeObserver(fit);
    resize.observe(viewport);
    const ready = (async () => {
      try {
        if (!window.ITDViewer.supported(version.file)) {
          pin.hidden = true;
          status.textContent =
            "Встроенный просмотр недоступен. Скачайте оригинал и проверьте его перед подтверждением.";
          return;
        }
        let cached;
        if (prefetched?.id === version.file.id) {
          const item = prefetched;
          prefetched = null;
          cached = await item.promise;
        }
        const r = cached
          ? null
          : await fetch(`/api/files/${version.file.id}/preview`, {
              signal: abort.signal,
              credentials: "same-origin",
              cache: "no-store",
            });
        if (r && !r.ok) {
          if (r.status === 401)
            window.dispatchEvent(new Event("itd-preview-session-expired"));
          throw Error("Не удалось загрузить материал. Повторите открытие.");
        }
        const bytes = cached || (await r.arrayBuffer());
        if (!alive) return;
        if (version.file.contentType === "application/pdf") {
          const lib = await import("/vendor/pdfjs/pdf.mjs");
          if (!alive) return;
          lib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.mjs";
          task = lib.getDocument({
            data: new Uint8Array(bytes),
            isEvalSupported: false,
            cMapUrl: "/vendor/pdfjs/cmaps/",
            cMapPacked: true,
            standardFontDataUrl: "/vendor/pdfjs/standard_fonts/",
            wasmUrl: "/vendor/pdfjs/wasm/",
            iccUrl: "/vendor/pdfjs/iccs/",
          });
          pdf = await task.promise;
          if (!alive) return;
          page = Math.min(page, pdf.numPages);
          pageInput.hidden = false;
          pageInput.max = pdf.numPages;
          tools.prepend(btn("Следующая страница", () => go(page + 1)));
          tools.prepend(btn("Предыдущая страница", () => go(page - 1)));
          await render();
        } else {
          blobUrl = URL.createObjectURL(
            new Blob([bytes], { type: version.file.contentType }),
          );
          media = el("img");
          media.alt = version.file.name;
          media.src = blobUrl;
          await media.decode();
          if (!alive) return;
          sheet.replaceChildren(media);
          fit();
          drawMarkers();
          status.textContent = "Изображение загружено";
          pageSave = Promise.resolve(onPage(1, 1));
          await pageSave;
        }
        viewport.scrollTo(position.scrollX || 0, position.scrollY || 0);
      } catch (e) {
        if (alive && e.name !== "AbortError") status.textContent = e.message;
      }
    })();
    return {
      ready,
      async confirmReady() {
        await ready;
        await pageSave;
      },
      get zoom() {
        return zoom;
      },
      setZoom,
      go,
      get dimensions() {
        return media
          ? {
              width: media.naturalWidth || media.width,
              height: media.naturalHeight || media.height,
            }
          : null;
      },
      get pageCount() {
        return pdf?.numPages || 1;
      },
      get viewport() {
        return viewport;
      },
      get sheet() {
        return sheet;
      },
      setMarkers(next) {
        markers = next;
        drawMarkers();
      },
      focusMarker(n) {
        go(n.page);
        setTimeout(() => {
          const r = sheet.getBoundingClientRect();
          viewport.scrollTo({
            left: r.width * n.x - viewport.clientWidth / 2,
            top: r.height * n.y - viewport.clientHeight / 2,
          });
        }, 100);
      },
      dispose() {
        alive = false;
        serial++;
        clearTimeout(scrollTimer);
        abort.abort();
        resize.disconnect();
        renderTask?.cancel();
        task?.destroy().catch(() => {});
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        host.replaceChildren();
      },
    };
  }
  window.ITDApprovalViewer = { mount, prefetch, clearPrefetch };
})();

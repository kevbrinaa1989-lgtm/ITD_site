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
      showProgress = false,
      onDisplay = () => {},
    } = {},
  ) {
    let alive = true,
      serial = 0,
      task,
      pdf,
      renderTask,
      pendingRender,
      blobUrl,
      media,
      page = position.page || 1,
      zoom = position.zoom || 1,
      addMode = false,
      scrollTimer;
    const pendingPages = new Map(), failedPages = new Set(), reported = new Set();
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
    const toolButton = (label, glyph, action) => {
      const b = btn(glyph, action);
      b.title = label;
      b.setAttribute("aria-label", label);
      return b;
    };
    const previous = toolButton("Предыдущая страница", "‹", () => go(page - 1)),
      next = toolButton("Следующая страница", "›", () => go(page + 1)),
      pageLabel = el("span", "Документ", "ac-page-label"),
      pageControl = el("label", undefined, "ac-page-jump"),
      pagePicker = el("select"),
      seen = el("span", "", "ac-seen"),
      zoomButton = btn("", () => setZoom(1)),
      pages = el("div", undefined, "ac-page-controls"),
      scale = el("div", undefined, "ac-scale-controls");
    pagePicker.setAttribute("aria-label", "Перейти на страницу");
    pagePicker.hidden = true;
    pagePicker.onchange = () => go(Number(pagePicker.value));
    pageControl.append(pageLabel, pagePicker);
    zoomButton.title = "Вернуть исходный масштаб";
    zoomButton.className = "ac-zoom";
    seen.hidden = !showProgress;
    function controls() {
      const count = pdf?.numPages || 1;
      pageLabel.textContent = pdf ? `Страница ${page} из ${count}` : "Документ";
      pagePicker.value = String(page);
      previous.disabled = !pdf || !media || page <= 1;
      next.disabled = !pdf || !media || page >= count;
      zoomButton.textContent = Math.round(zoom * 100) + "%";
    }
    function progress() {
      const total = version.pageCount || pdf?.numPages;
      const all =
        version.confirmedView || (total && version.viewedPages >= total);
      seen.classList.toggle("is-complete", !!all);
      seen.textContent = all
        ? "Все страницы просмотрены"
        : total
          ? `Просмотрено ${version.viewedPages || 0} из ${total}`
          : "";
    }
    const full = toolButton("На весь экран", "⛶", async () => {
      if (document.fullscreenElement === host) await document.exitFullscreen();
      else if (host.classList.contains("ac-expanded"))
        host.classList.remove("ac-expanded");
      else {
        try {
          await host.requestFullscreen();
        } catch {
          host.classList.add("ac-expanded");
        }
      }
      fullState();
    });
    function fullState() {
      const expanded =
        document.fullscreenElement === host ||
        host.classList.contains("ac-expanded");
      full.title = expanded
        ? "Выйти из полноэкранного режима"
        : "На весь экран";
      full.setAttribute("aria-label", full.title);
      full.setAttribute("aria-pressed", String(expanded));
    }
    host.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && host.classList.contains("ac-expanded")) {
        host.classList.remove("ac-expanded");
        fullState();
      }
    });
    document.addEventListener("fullscreenchange", fullState);
    pages.append(previous, pageControl, next);
    scale.append(
      toolButton("Уменьшить масштаб", "−", () => setZoom(zoom - 0.25)),
      zoomButton,
      toolButton("Увеличить масштаб", "+", () => setZoom(zoom + 0.25)),
      full,
    );
    tools.append(pages, seen, scale);
    viewport.append(status);
    host.append(tools, viewport);
    controls();
    progress();
    let painted = 0, inView = false;
    function savePage(n) {
      if (pendingPages.has(n)) return pendingPages.get(n);
      const request = Promise.resolve().then(() => onPage(n)).then(() => {
        reported.add(n);
        failedPages.delete(n);
        if (alive) progress();
      }).catch(() => {
        failedPages.add(n);
      }).finally(() => {
        pendingPages.delete(n);
        if (alive) onDisplay();
      });
      pendingPages.set(n, request);
      return request;
    }
    function recordPage() {
      if (!alive || !painted || !inView || document.hidden ||
          !sheet.getClientRects().length || reported.has(painted) || failedPages.has(painted))
        return;
      const sheetRect = sheet.getBoundingClientRect(),
        area = viewport.getBoundingClientRect();
      const left = Math.max(sheetRect.left, area.left, 0),
        right = Math.min(sheetRect.right, area.right, innerWidth),
        top = Math.max(sheetRect.top, area.top, 0),
        bottom = Math.min(sheetRect.bottom, area.bottom, innerHeight);
      if (
        right <= left ||
        bottom <= top ||
        !sheet.contains(
          document.elementFromPoint((left + right) / 2, (top + bottom) / 2),
        )
      )
        return;
      return savePage(painted);
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        inView = entry.isIntersecting;
        if (inView) recordPage();
      },
      { root: viewport },
    );
    observer.observe(sheet);
    document.addEventListener("visibilitychange", recordPage);
    document.addEventListener("close", recordPage, true);
    const positionChanged = () =>
      onPosition({
        page,
        zoom,
        scrollX: viewport.scrollLeft,
        scrollY: viewport.scrollTop,
      });
    function drawMarkers() {
      sheet.querySelectorAll(".ac-pin").forEach((n) => n.remove());
      if (!media) return;
      for (const [i, n] of markers.entries())
        if (n.page === page) {
          const b = btn(String(n.number || i + 1), (e) => {
            e.stopPropagation();
            onMarker({ ...n, existing: true, index: n.draft ? n.index : i });
          });
          b.className = "ac-pin";
          if (n.id) b.dataset.noteId = n.id;
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
      const style = getComputedStyle(viewport);
      const ratio =
        Math.min(
          Math.max(
            1,
            viewport.clientWidth -
              parseFloat(style.paddingLeft) -
              parseFloat(style.paddingRight),
          ) / w,
          Math.max(
            1,
            viewport.clientHeight -
              parseFloat(style.paddingTop) -
              parseFloat(style.paddingBottom),
          ) / h,
          media.tagName === "IMG" ? 1 : Infinity,
        ) * zoom;
      sheet.style.width = `${w * ratio}px`;
      sheet.style.height = `${h * ratio}px`;
      media.style.width = "100%";
      media.style.height = "100%";
    }
    function setZoom(n) {
      zoom = Math.max(0.5, Math.min(4, n));
      fit();
      controls();
      positionChanged();
    }
    async function render() {
      const seq = ++serial;
      renderTask?.cancel();
      media = null;
      painted = 0;
      controls();
      pageLabel.textContent = "Загрузка…";
      onDisplay();
      sheet.replaceChildren();
      status.hidden = false;
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
        status.hidden = true;
        painted = page;
        controls();
        onDisplay();
        await recordPage();
        positionChanged();
        p.cleanup();
      } catch (e) {
        if (alive && seq === serial && e.name !== "RenderingCancelledException")
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
      if (pdf) pendingRender = render();
    }
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
      if (addMode && media && e.key === "Enter") {
        e.preventDefault();
        onMarker({ page, x: 0.5, y: 0.5, body: "" });
      }
    });
    let drag = null;
    viewport.addEventListener("pointerdown", (e) => {
      if (
        e.pointerType === "mouse" &&
        zoom > 1 &&
        !addMode &&
        !e.target.closest("button")
      ) {
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
          if (pdf.numPages > 1) {
            for (let n = 1; n <= pdf.numPages; n++)
              pagePicker.add(new Option(String(n), String(n)));
            pagePicker.hidden = false;
          }
          page = Math.min(page, pdf.numPages);
          controls();
          progress();
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
          painted = 1;
          onDisplay();
          status.hidden = true;
          await recordPage();
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
        await pendingRender;
        if (media && !inView) {
          const rect = sheet.getBoundingClientRect(),
            area = viewport.getBoundingClientRect();
          inView =
            area.width > 0 &&
            area.height > 0 &&
            rect.bottom > area.top &&
            rect.top < area.bottom;
        }
        await recordPage();
        await Promise.all(pendingPages.values());
      },
      get failedPages() {
        return [...failedPages].sort((a, b) => a - b);
      },
      async retryViews() {
        await Promise.all([...failedPages].map(savePage));
      },
      get position() {
        return { page, zoom, scrollX: viewport.scrollLeft, scrollY: viewport.scrollTop };
      },
      setPinMode(enabled) {
        addMode = enabled;
        sheet.classList.toggle("ac-pin-mode", enabled);
        if (enabled) sheet.focus({ preventScroll: true });
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
      async focusMarker(n) {
        await ready;
        if (!alive) return;
        go(n.page);
        await pendingRender;
        if (!alive || !media) return;
        sheet.querySelector(".ac-pin.is-located")?.classList.remove("is-located");
        if (n.id) sheet.querySelector(`.ac-pin[data-note-id="${n.id}"]`)?.classList.add("is-located");
        const r = sheet.getBoundingClientRect(),
          area = viewport.getBoundingClientRect();
        viewport.scrollBy({
          left: r.left - area.left + r.width * n.x - area.width / 2,
          top: r.top - area.top + r.height * n.y - area.height / 2,
        });
      },
      dispose() {
        alive = false;
        serial++;
        clearTimeout(scrollTimer);
        abort.abort();
        resize.disconnect();
        observer.disconnect();
        document.removeEventListener("fullscreenchange", fullState);
        document.removeEventListener("visibilitychange", recordPage);
        document.removeEventListener("close", recordPage, true);
        renderTask?.cancel();
        task?.destroy().catch(() => {});
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        host.replaceChildren();
      },
    };
  }
  window.ITDApprovalViewer = { mount, prefetch, clearPrefetch };
})();

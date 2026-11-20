"use strict";
// At most two small originals in flight. Offscreen previews release their resources.
(() => {
  let jobs = [],
    running = 0;
  const records = new Map();
  const placeholder = (file) => file.contentType === "application/pdf" ? "PDF" : "Фото";
  const pump = () => {
    while (running < 2 && jobs.length) {
      const r = jobs.shift();
      if (!r.visible || r.started) continue;
      r.started = true;
      running++;
      load(r).finally(() => {
        running--;
        pump();
      });
    }
  };
  async function load(r) {
    const generation = r.generation;
    const valid = () => r.visible && r.generation === generation;
    const controller = new AbortController();
    r.controller = controller;
    let task;
    try {
      const response = await fetch(`/api/files/${r.file.id}/preview`, {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw Error("preview");
      const bytes = await response.arrayBuffer();
      if (!valid()) return;
      const canvas = document.createElement("canvas");
      if (r.file.contentType === "application/pdf") {
        const lib = await import("/vendor/pdfjs/pdf.mjs");
        if (!valid()) return;
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
        r.task = task;
        const pdf = await task.promise;
        if (!valid()) return;
        const page = await pdf.getPage(1);
        if (!valid()) return;
        const base = page.getViewport({ scale: 1 }),
          vp = page.getViewport({
            scale: Math.min(r.width / base.width, r.height / base.height),
          });
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        r.render = page.render({
          canvasContext: canvas.getContext("2d"),
          viewport: vp,
        });
        await r.render.promise;
      } else {
        const bitmap = await createImageBitmap(
          new Blob([bytes], { type: r.file.contentType }),
        );
        const ratio = Math.min(r.width / bitmap.width, r.height / bitmap.height);
        canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
        canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
        canvas
          .getContext("2d")
          .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
      }
      if (valid()) {
        canvas.setAttribute("aria-label", `Миниатюра ${r.file.name}`);
        r.host.replaceChildren(canvas);
      }
    } catch (e) {
      if (valid()) r.host.textContent = placeholder(r.file);
    } finally {
      await task?.destroy().catch(() => {});
      if (r.generation === generation) r.task = null;
    }
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const r = records.get(entry.target);
        if (!r) continue;
        r.visible = entry.isIntersecting;
        if (r.visible) {
          jobs.push(r);
          pump();
        } else {
          r.generation++;
          r.controller?.abort();
          r.render?.cancel();
          r.task?.destroy().catch(() => {});
          r.started = false;
          r.host.textContent = placeholder(r.file);
        }
      }
    },
    { rootMargin: "80px" },
  );
  function mount(file, { width = 80, height = 64 } = {}) {
    const host = document.createElement("span");
    host.className = "ac-thumbnail";
    host.setAttribute("aria-hidden", "true");
    host.textContent = window.ITDViewer.supported(file) ? placeholder(file) : "Файл";
    if (file.size <= 2 * 1024 * 1024 && window.ITDViewer.supported(file)) {
      records.set(host, {
        host,
        file,
        width,
        height,
        visible: false,
        started: false,
        generation: 0,
      });
      observer.observe(host);
    }
    return host;
  }
  function clear(root) {
    for (const [host, r] of records)
      if (root.contains(host)) {
        observer.unobserve(host);
        r.visible = false;
        r.generation++;
        r.controller?.abort();
        r.render?.cancel();
        r.task?.destroy().catch(() => {});
        records.delete(host);
      }
    jobs = jobs.filter((r) => r.visible);
  }
  window.ITDApprovalThumbnails = { mount, clear };
})();

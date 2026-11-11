"use strict";
(() => {
  const { node, button, materialTitle } = window.ITDUI;
  const selections = new Map();
  function render(project) {
    const host = document.getElementById("project-gallery");
    window.ITDViewer.releaseWithin(host);
    host.replaceChildren();
    const images = project.files.filter(
      (f) =>
        f.category === "result" &&
        window.ITDViewer.image(f) &&
        (!f.review || f.review.isCurrent),
    );
    if (!images.length) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const selected =
        images.find((f) => f.id === selections.get(project.id)) || images[0],
      index = images.indexOf(selected);
    function choose(file) {
      selections.set(project.id, file.id);
      render(project);
    }
    const frame = node("section", undefined, "album-frame"),
      top = node("div", undefined, "album-topline");
    top.append(
      node("span", "ВИЗУАЛИЗАЦИИ"),
      node(
        "span",
        `${index + 1} / ${images.length}${selected.review ? ` · Версия ${selected.review.versionNumber}` : ""}`,
      ),
    );
    const media = window.ITDViewer.thumbnail(selected, images);
    media.className = "album-hero-media";
    const prev = button(
        "←",
        () => choose(images[(index - 1 + images.length) % images.length]),
        "album-prev",
      ),
      next = button(
        "→",
        () => choose(images[(index + 1) % images.length]),
        "album-next",
      );
    prev.setAttribute("aria-label", "Предыдущее изображение в альбоме");
    next.setAttribute("aria-label", "Следующее изображение в альбоме");
    prev.disabled = next.disabled = images.length < 2;
    const main = node("div", undefined, "album-image-stage");
    main.append(prev, media, next);
    const bottom = node("div", undefined, "album-bottom"),
      caption = node("div");
    caption.append(
      node("h3", materialTitle(selected.name)),
      node(
        "p",
        "Откройте изображение, чтобы рассмотреть детали.",
        "album-hint",
      ),
    );
    const thumbs = node("div", undefined, "album-thumbnails");
    thumbs.setAttribute("aria-label", "Ракурсы проекта");
    for (const file of images) {
      const thumb = window.ITDViewer.thumbnail(file, images, {
        onOpen: choose,
        label: `Выбрать ракурс: ${file.name}`,
      });
      thumb.className = "album-thumbnail";
      const b = thumb.querySelector("button");
      b.setAttribute("aria-pressed", String(file.id === selected.id));
      thumbs.append(thumb);
    }
    bottom.append(caption, thumbs);
    frame.append(top, main, bottom);
    host.append(frame);
    const actions = node("div", undefined, "album-material-actions");
    const original = node("a", "Скачать оригинал", "file-download");
    original.href = `/api/files/${selected.id}/download`;
    original.download = selected.name;
    actions.append(original);
    if (selected.review)
      actions.append(window.ITDReview.reviewControl(selected));
    host.append(actions);
  }
  function reset() {
    selections.clear();
    const host = document.getElementById("project-gallery");
    window.ITDViewer.releaseWithin(host);
    host?.replaceChildren();
  }
  window.ITDGallery = { render, reset };
})();

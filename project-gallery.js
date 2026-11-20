"use strict";
(() => {
  const { node, button } = window.ITDUI;
  const selections = new Map();
  function render(project, reviewStatus) {
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
    function choose(file, focusSelector) {
      if (file.id === selected.id) return;
      const scroll = host.querySelector(".album-thumbnails").scrollLeft;
      selections.set(project.id, file.id);
      render(project, reviewStatus);
      const strip = host.querySelector(".album-thumbnails");
      strip.scrollLeft = scroll;
      const current = strip.querySelector('[aria-pressed="true"]').getBoundingClientRect();
      const bounds = strip.getBoundingClientRect();
      strip.scrollLeft += Math.min(0, current.left - bounds.left) + Math.max(0, current.right - bounds.right);
      host.querySelector(focusSelector)?.focus({ preventScroll: true });
    }
    const title = window.ITDUI.materialLabel({ file: selected });
    const frame = node("section", undefined, "album-frame"),
      top = node("div", undefined, "album-topline");
    top.append(node("span", images.length > 1 ? `Изображение ${index + 1} из ${images.length}` : "Изображение"));
    if (selected.review) {
      top.append(node("span", `Версия ${selected.review.versionNumber} · ${reviewStatus(selected.review)}`));
    }
    const media = window.ITDViewer.thumbnail(selected, images, { label: `Увеличить изображение: ${title}` });
    media.className = "album-hero-media";
    const main = node("div", undefined, "album-image-stage");
    main.append(media);
    if (images.length > 1) {
      const prev = button("←", () => choose(images[(index - 1 + images.length) % images.length], ".album-prev"), "album-prev");
      const next = button("→", () => choose(images[(index + 1) % images.length], ".album-next"), "album-next");
      prev.setAttribute("aria-label", "Предыдущее изображение в альбоме");
      next.setAttribute("aria-label", "Следующее изображение в альбоме");
      main.prepend(prev);
      main.append(next);
    }
    const bottom = node("div", undefined, "album-bottom"),
      caption = node("div");
    caption.append(
      node("h3", title),
      node("p", selected.name, "album-filename"),
      node(
        "p",
        "Откройте изображение, чтобы рассмотреть детали.",
        "album-hint",
      ),
    );
    caption.querySelector("h3").title = title;
    caption.querySelector(".album-filename").title = selected.name;
    bottom.append(caption);
    if (images.length > 1) {
      const thumbs = node("div", undefined, "album-thumbnails");
      thumbs.setAttribute("role", "group");
      thumbs.setAttribute("aria-label", "Изображения альбома");
      for (const [position, file] of images.entries()) {
        const thumb = window.ITDViewer.thumbnail(file, images, {
          onOpen: (file) => choose(file, '.album-thumbnail [aria-pressed="true"]'),
          label: `Изображение ${position + 1} из ${images.length}: ${window.ITDUI.materialLabel({ file })}`,
        });
        thumb.className = "album-thumbnail";
        thumb.querySelector("button").setAttribute("aria-pressed", String(file.id === selected.id));
        thumbs.append(thumb);
      }
      bottom.append(thumbs);
    }
    frame.append(top, main, bottom);
    host.append(frame);
    const actions = node("div", undefined, "album-material-actions");
    const original = node("a", "Скачать оригинал", "file-download");
    original.href = `/api/files/${selected.id}/download`;
    original.download = selected.name;
    actions.append(original);
    if (selected.review) {
      const discuss = window.ITDReview.reviewControl(selected, window.ITDLibrary.openReview);
      discuss.textContent = "Обсудить в Центре согласования";
      actions.append(discuss);
    }
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

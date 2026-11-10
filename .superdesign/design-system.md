# ITD Studio — cabinet concepts, 10 November 2026

## Product and boundaries
Interior design studio. Russian-language cabinet for studio administrator and customer. Existing Node/vanilla HTML/CSS application, no React/Tailwind requirement. Design only; do not connect application APIs, VPS, real users, documents, payments or databases. All demo names, deadlines, tasks, messages and counts are fictional. Public portfolio imagery is illustrative.

## Verified brand, separate from existing cabinet
Live https://itdstudio.ru/ inspected with Chromium on 2026-11-10, including computed styles and screenshot. Heading: «Интерьер складывается из решений, которых сначала не замечают.»
Current site uses Manrope for interface/body and Prata for editorial headings. Final computed palette: canvas #171815; panel #20211e; paper/text #f4f0e8; muted #acafa4; border #363832; accent #cfbd98. Exact source: https://forms.itdstudio.ru/itd/site.css (final override at line 280). Thin architectural rules, generous whitespace, interior photographs, restrained square geometry.
IMPORTANT: Superdesign extract-website returned a stale /testovaya page dated October 22 with a three-dot logo. That result is rejected and MUST NOT guide designs.

Official logo assetKey: itd-official-logo.svg
Official logo URL: https://vgbujcuwptvheqijyjbe.supabase.co/storage/v1/object/public/hmac-uploads/projects/0a91e369-2692-4bb7-8c12-0055f988924c/brand-assets/itd-official-logo.svg/logo.svg
Use this exact image at EVERY logo position, never recreate with text, initials, generic icon or SVG. The downloaded SVG is dark artwork: CSS brightness(0) invert(1) on dark, brightness(0) on light. The live site also applies an inversion for dark surfaces. Preserve aspect ratio.

Content photo URL: https://vgbujcuwptvheqijyjbe.supabase.co/storage/v1/object/public/hmac-uploads/projects/0a91e369-2692-4bb7-8c12-0055f988924c/content-assets/itd-public-portfolio-living-room/interior.webp
This public ITD portfolio photo illustrates a fictional demo project. Never imply this project's names/deadlines are live customer data.

## Baseline reproduction mode
When prompt asks for current UI reproduction, original source CSS and rendered source branch are absolute authority. Do NOT restyle current UI with the live public site. Current cabinet uses Arial/system-ui, light #f6f5f2 background, #ffffff surfaces, #272a27 ink, #767970 muted, #e2dfd8 lines, #aa9171 accent, 228px sidebar, 760px mobile breakpoint. Keep existing render functions, labels, spacing, review list then detail and dashboard groups exactly. Only fictional values substitute for data. No brand-new UX in baseline.

## Shared redesign foundations
Use Manrope (body, buttons, metrics) and Prata (large project headings in editorial mode only). Load fonts with Google Fonts CSS family Manrope and Prata, Cyrillic supported; Arial/Georgia fallback. Body 14–16px, mobile inputs 16px. Small labels 11–12px, never reduce key text to microtype. Desktop H1 32–40px; mobile 26–30px. Line height 1.45–1.65.
Spacing: 4,8,12,16,24,32,40,48,64px. Radius: 0–4px (8px only modal); no rounded card bubbles. Rules 1px; shadows only modal, subtle. Hover/focus visible, focus outline 2px with offset 3px, motion 120–180ms and reduced-motion support.
Allowed light palette: #f4f0e8 canvas, #fffefa surface, #24231f ink, #6c6860 muted, #d8d2c8 border, #786649 accent text, #cfbd98 accent fill. Allowed dark palette: #171815 canvas, #20211e panel, #f4f0e8 text, #acafa4 muted, #363832 border, #cfbd98 accent. Semantic light: green #40634c on #e8eee7, warning #815c2d on #f5ead8, red #934c3b on #f9ede8. Dark semantic text: #b5c9b5, #e2c692, #e6b0a2, with textual statuses and icons. Text contrast at least 4.5:1, controls at least 44×44px.
Concept A «Рабочий стол»: light functional workspace, compact consistent Manrope typography, left sidebar, data rows, clear action priorities and two-pane material review. Manrope throughout, no Prata except optional project title.
Concept B «Альбом проекта»: dark editorial identity matching live website, large Prata project title, photographic lead for customer, calm asymmetric grid with generous margins. Admin stays readable and work-focused, warm accent and thin rules; avoid photograph-heavy admin dashboard.
Concept C «Маршрут»: light warm canvas with dark navigation/header, numbered active-stage timeline and clear immediate next action, predominantly Manrope. Horizontally organized project journey on desktop; vertical route and focused action cards on mobile. Not a recolor of A: stage-based hierarchy and composition.

## UX audit requirements for all redesign concepts
Admin: Главная, Проекты, Клиенты, Задачи; service area for notifications/access. First show actual studio actions, then deadlines, then waiting for customer separately. Clickable counters apply their indicated filter. Collapse empty time groups.
Customer: Главная, Мои проекты, Решения, Профиль. Home shows specific pending materials (1–3) with title/version/CTA, not just an abstract queue count. Project: Обзор, Этапы, Материалы, Документы. Do not add payment or procurement features; these are outside current implemented scope.
Review: one canonical material detail; desktop compact list on left and selected material/preview on right. Mobile separate list/detail screens with explicit back action retaining filter/scroll. Do not shrink columns to a phone. Title, actual filename, file type and version are separate visible fields. Switching version must change filename/type/preview together and retain context.
Use example material «Гостиная. Визуализация»: v2 current image/jpeg file living-room-v2.jpg, v1 historical application/pdf file living-room-v1.pdf. Render relevant viewer metadata. Historic version: clear «Предыдущая версия — только просмотр», no decision buttons; return to current version action. Download only original selected file; do not pretend a JPG is a PDF.
Current version decision: «Согласовать» opens confirmation; «На доработку» requires nonempty comment. On demo approval show local-only success. No real API requests. Comments distinguish «Дизайнер» and «Заказчик» in text, not color alone. History secondary and collapsible. Version change/conflict notice preserves draft comment, disables stale decision and offers latest version.
Show parallel active stages without inventing a single next stage. Archived projects excluded from active pending queue but available separately. No double counts or false claims of viewed state. Visual prototype interactions are not implementation/security verification.

## Responsive and demonstrator conventions
Desktop target 1440×1000; phone 390×844 and 360×800; tablet 768/1024. No horizontal document overflow. Phone primary actions reachable, metadata wraps long filenames, bottom actions do not obscure discussion. Mobile nav at most four core destinations. Use semantic buttons, labels and dialogs, keyboard focus and Escape close.
Each concept is a responsive interactive design with three primary states: customer home, administrator home, material library/detail. A small clearly marked «Демо макета» control outside product navigation switches roles for comparison; this is NOT a production role-switch feature. Provide URL hash states #client, #admin, #material where possible. Initial screen customer home; nav transitions work. All concepts use same fictional dataset and count logic.
Shared fictional dataset: project «Квартира у парка», 86 м², designer Анна Морозова, customer Мария Соколова, progress 65%; active stages «Визуализации» and «Рабочая документация»; one current pending material «Гостиная. Визуализация», v2, uploaded 10 ноября 2026; deadline 12 ноября. Admin: 8 active projects, 3 studio actions, 5 awaiting customer; show three named action rows and separate waiting section. Clear label «Демонстрационные данные» in prototype chrome.

## Selected unified direction (supersedes variant rules for final design only)
The user selected C on 10 November 2026. Use the light architectural C foundation and project route, A workbench for administrator, B imagery/gallery presentation. Shared header is now light; dark is localized to image viewing. Four primary states: #client, #admin, #material, #gallery. Details in `.superdesign/context/unified-design.md`; final links and versions in `docs/redesign/UNIFIED.json`. Earlier variants remain historical references. The combined design is awaiting final approval; application implementation is not authorized by this design task.

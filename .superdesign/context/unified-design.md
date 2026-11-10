# Selected final direction: Route / Маршрут

User selected concept C, with client journey from C, admin workbench from A, photographic gallery from B. This is one proposed final direction, awaiting final visual approval. Do not implement application changes or deploy. Source: `.superdesign/prototypes/unified.html`. Earlier A/B/C prototypes remain historical options.

## Structure
- Shared light cream architectural shell, exact official ITD logo, Manrope UI and Prata on editorial client/gallery headings. Dark only around visualization previews/fullscreen viewer and restrained active controls.
- Client: project/progress, five numbered stages (three complete, visualization active, documentation parallel), one concrete pending material and deadline, documents, gallery entry, events.
- Admin: left workbench navigation; project/action/overdue/client-wait counters; project tiles; overdue-first task rows with filters; new comments; deadlines; separate client-wait section. On mobile, new-comment shortcut stays near counters.
- Material: compact searchable/filterable library, selected material only, selected version and actual filename/type, large contained preview, decision/comments rail. Historical PDF vs current JPG is explicit. No duplicated decision cards.
- Gallery: three illustrative public portfolio images, thumbnails, previous/next; fullscreen contained image, 100–400% zoom, pan, pinch/double tap, swipe while unzoomed, keyboard controls, return to correct material/comment.
- Phone: library and detail are separate states. Selected-material preview fits viewport; discussion row stays above fixed decision buttons. Comment/change forms open a bottom sheet. Fullscreen image uses full available area with controls and comment entry.

## Interaction scope
All names/projects/versions/tasks/deadlines/statuses are fictional fixtures. Images are public portfolio examples, not documents of the fictional project. v1 PDF is a clearly labeled illustrative schematic; original downloads intentionally unavailable. Only living-room v2 is initially pending. Bedroom images show agreed material history. Comments/decisions live only in page memory and reset on refresh. Administrator/client switches above product chrome are prototype controls, not production permissions.

Core demo interactions: navigation, filtering, material selection, versions, zoom/pan/pinch/swipe, comments, mandatory change reason, approval confirmation, local status/count change. Project/user/task editing and real auth/APIs are deliberately not connected. Existing backend rights/revision checks/uploads/documents/auth must remain unchanged at future implementation; this prototype cannot validate them.

## Source and continuation
Use existing selected C draft IDs with `--into`; current versions are recorded in `docs/redesign/UNIFIED.json`. Gallery adds two sibling frames. Fetch current remote HTML before further changes. Every literal `<img` inside inline JS must stay split (`'<im'+'g'`) to avoid Superdesign's preview HTML transform breaking JavaScript. Keep exact uploaded logo URL.

CLI generation has no available team credits. A faithful retry after splitting a context file above the 50,000-character limit returned `insufficient_credits`; author/import path was used, without paid changes. For future generator context, use saved source line ranges below 50,000 characters each; never send the entire unified HTML as one context file.

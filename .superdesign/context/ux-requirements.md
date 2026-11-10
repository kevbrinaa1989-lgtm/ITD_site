# UX requirements for three comparable concept branches

Source: docs/redesign/UX-AUDIT.md, code audit at 99b7555. This is a design brief, not proof of live defects. Apply only to redesign branches, never to the faithful baseline.

## Scope and shared fictional scenario
Three alternative concepts must cover administrator home, client home, materials library/selected material and mobile. Use the same fictional project, stage counts, dates, material and conversations in all directions, so comparison concerns interface rather than differing data. No client data, production API calls, credentials, database or live integrations. Do not invent online payments or other unimplemented services.

## Daily use
- Administrator: prioritize actual actions required of studio, then deadlines; separate client waiting from studio responsibility. Collapse empty deadline groups. Counters navigate to matching filters.
- Client: show project status, completion by completed stages, all genuinely active parallel stages, and 1–3 specific decisions with name/version. Do not invent next tasks unsupported by data.
- An archive remains accessible but does not produce active required decisions. Read notification is distinct from complete action.
- Project navigation: overview, stages, materials, documents. A canonical material screen opens from stages, global decisions or library, preserving context.

## Material workflow
- Desktop: compact searchable/filterable list and one selected material detail area. No repeated full detail card below whole list. Keep selection visible when changing versions.
- Mobile 360/390px: library and selected material are separate views. Explicit back restores filter/scroll; do not squeeze desktop columns.
- Show logical material title separately from exact original selected-version filename, file type and version. Example logical title: «Планировочное решение», v1 actual filename «plan-v1.pdf», type PDF/application/pdf; v2 actual filename «plan-v2.jpg», type JPG/image/jpeg. Switching v2→v1 changes preview and metadata together. Original download refers to that selected file.
- Embed a meaningful preview next to decision controls; fullscreen preview remains an option. Include zoom/page controls when PDF is selected.
- Current and historic versions are unmistakable before action. Historical version cannot be approved; button to current version remains available.
- Approval requires explicit confirmation naming material and current version. Changes require a non-empty comment. Preserve existing revision checks as implementation requirements, do not represent stale decisions as saved.
- Studio can upload a new version with project/client destination visible. Previous versions and decisions survive. Do not turn the mock into a real upload.
- Separate search, stage, decision-status and viewed-state filters; show only useful client filters. Sort by update.
- Dialogue identifies studio/client role with text and placement, not only color. Decisions are marked as decisions. History is secondary and collapsed, with author/date/version; avoid repeating full messages twice.

## Responsive and accessible criteria
Targets: 360, 390, 768, 1024, 1440 px. Controls at least 44×44 px, visible keyboard focus, wrapping long filenames, readable mobile inputs. Keyboard/comment composer must not cover decisions. Navigation and version changes must retain expected context. Do not hide important decisions behind hover.

## Review criteria
For each concept the user can switch role and open the same selected material, compare v1 PDF/v2 JPG, open required-comment state, confirmation state and historical-version state. Clearly mark any prototype-only role/state switcher outside product navigation. These are visual prototypes, not a shipped application or evidence that backend behavior changed.

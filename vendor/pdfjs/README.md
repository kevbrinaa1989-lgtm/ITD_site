# Local PDF.js distribution

Mozilla PDF.js (`pdfjs-dist`) version **6.4.299**, Apache-2.0. Includes upstream LICENSE and resource licenses. Source: https://github.com/mozilla/pdf.js

Files extracted unchanged from the npm package: legacy/build/pdf.min.mjs → pdf.mjs; legacy/build/pdf.worker.min.mjs → pdf.worker.mjs; cmaps/, standard_fonts/, wasm/, iccs/. No sandbox scripting module or generic web viewer is included. Documents are rendered locally to canvas; scripting, annotations, forms and external links are not executed by this application.

Package: https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz

Verified package integrity: `sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==`

`assets.json` lists the SHA-256 checksums and the only resources the HTTP server is allowed to serve from this directory. To update, obtain a reviewed pinned pdfjs-dist release through npm, verify its integrity, replace the selected files and licenses, regenerate assets.json, and run all tests including browser preview checks. Do not add a CDN fallback. No npm install or build is required by the application user.

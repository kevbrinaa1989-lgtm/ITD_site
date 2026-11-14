// The former inline review UI was replaced by Approval Center.
// Keep the documented entry point and run its current workflow, PDF and
// compatibility scenarios. Legacy API/history/security remain in material-review.test.mjs.
await import("./browser-approval-center.mjs");
await import("./browser-approval-pdf.mjs");
await import("./browser-approval-compat.mjs");

// The former inline review UI was replaced by Approval Center.
// Keep the documented entry point for approval workflow, PDF, compatibility
// and both rounds of a 40-material stage.
await import("./browser-approval-center.mjs");
await import("./browser-approval-pdf.mjs");
await import("./browser-approval-compat.mjs");
await import("./browser-approval-round.mjs");
await import("./browser-approval-layout.mjs");
await import("./browser-approval-decisions.mjs");
await import("./browser-approval-feedback.mjs");
await import("./browser-approval-marks.mjs");
await import("./browser-approval-draft-compat.mjs");
await import("./browser-approval-remarks-list.mjs");
await import("./browser-approval-version-followup.mjs");

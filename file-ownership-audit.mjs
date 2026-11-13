import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { auditFileOwnership } from "./file-ownership-migration.mjs";

if (!process.argv[2]) {
  console.error(
    "Usage: node file-ownership-audit.mjs /absolute/path/to/copy/itd.sqlite (read-only)",
  );
  process.exitCode = 2;
} else {
  const db = new DatabaseSync(resolve(process.argv[2]), { readOnly: true });
  try {
    const issues = auditFileOwnership(db);
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    console.log(
      JSON.stringify({ readOnly: true, issues, foreignKeys }, null, 2),
    );
    if (issues.length || foreignKeys.length) process.exitCode = 1;
  } finally {
    db.close();
  }
}

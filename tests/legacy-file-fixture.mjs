import { DatabaseSync } from "node:sqlite";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
// Model files already stored before content validation existed. Test databases only.
export async function replaceLegacyFixtureBytes(dataDir, fileId, bytes) {
  const db = new DatabaseSync(join(dataDir, "itd.sqlite"));
  try {
    const file = db.prepare("SELECT path FROM files WHERE id=?").get(fileId);
    if (!file || file.path.includes("/") || file.path.includes("\\"))
      throw new Error("Invalid fixture file");
    await writeFile(join(dataDir, "files", file.path), bytes);
    db.prepare("UPDATE files SET size=? WHERE id=?").run(bytes.length, fileId);
  } finally {
    db.close();
  }
}

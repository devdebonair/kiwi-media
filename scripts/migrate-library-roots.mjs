import { DatabaseSync, backup } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { importLibraryRoots } from "../packages/database/src/import-library-roots.js";

const path = resolve(process.env.KIWI_DATA_DIR || "data", "kiwi.db");
if (existsSync(path)) {
  const source = new DatabaseSync(path);
  const destination = `${path}.before-library-roots-${Date.now()}.bak`;
  await backup(source, destination);
  source.close();
  console.log(`Database backup: ${destination}`);
}
const { db } = await import("../packages/database/src/index.js");
try {
  const added = importLibraryRoots(db, process.env.KIWI_MEDIA_DIRS);
  console.log(`Imported ${added} folders. ${db.prepare("SELECT count(*) count FROM library_roots").get().count} folders stored in the database.`);
} finally { db.close(); }

import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";

// Explicit, repeatable upgrade helper; normal startup and scanning never read env folders.
export function importLibraryRoots(db, legacyValue = "") {
  const paths = [...new Set(legacyValue.split(":").filter(Boolean).map(path => resolve(path)))];
  db.exec("BEGIN IMMEDIATE");
  try {
    const insert = db.prepare("INSERT INTO library_roots (id,name,absolute_path,read_only,created_at) VALUES (?,?,?,?,?) ON CONFLICT(absolute_path) DO NOTHING");
    let added = 0;
    for (const path of paths) added += insert.run(randomUUID(), basename(path) || path, path, 1, new Date().toISOString()).changes;
    db.exec("COMMIT");
    return added;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

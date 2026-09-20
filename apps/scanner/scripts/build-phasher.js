import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const binDir = resolve(process.env.KIWI_DATA_DIR || resolve(repoRoot, "data"), "bin");
await mkdir(binDir, { recursive: true });
// Build only the upstream command; no Stash server, UI, or database is started.
const child = spawn("go", ["install", "github.com/stashapp/stash/cmd/phasher@v0.31.1"], {
  env: { ...process.env, GOBIN: binDir }, stdio: "inherit",
});
child.on("error", error => {
  console.error(error.code === "ENOENT" ? "Go 1.24.3+ is required to build phasher. Install Go and retry, or set KIWI_PHASHER_PATH to an existing standalone phasher." : error.message);
  process.exitCode = 1;
});
child.on("close", code => {
  if (code === 0) console.log(`Installed standalone phasher in ${binDir}`);
  else process.exitCode = 1;
});

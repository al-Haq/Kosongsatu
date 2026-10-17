import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
function walk(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(path, e.name)) : [join(path, e.name)],
  );
}
for (const file of ["server", "public", "scripts", "test", "e2e"]
  .flatMap(walk)
  .filter((f) => f.endsWith(".mjs"))) {
  const r = spawnSync(process.execPath, ["--check", file], {
    stdio: "inherit",
  });
  if (r.status !== 0) process.exit(r.status || 1);
}
console.log("JavaScript syntax checks passed.");

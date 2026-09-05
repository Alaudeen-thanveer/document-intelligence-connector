/**
 * Type-check every edge function.
 *
 * `deno check` without --node-modules-dir=auto cannot resolve the npm:
 * specifiers these functions import, and fails with a resolution error rather
 * than checking anything. Colour codes in that output also mean a naive
 * `grep "^error"` matches nothing — so a broken check looked exactly like a
 * clean one. This script exits non-zero on either.
 */
import { readdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const dirs = readdirSync("supabase/functions", { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "_shared")
  .map((d) => `supabase/functions/${d.name}/index.ts`)
  .filter(existsSync);

const shared = readdirSync("supabase/functions/_shared")
  .filter((f) => f.endsWith(".ts"))
  .map((f) => `supabase/functions/_shared/${f}`);

let bad = 0;
for (const file of [...shared, ...dirs]) {
  const r = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["deno", "check", "--no-lock", "--node-modules-dir=auto", file],
    { encoding: "utf8", shell: process.platform === "win32" },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const clean = r.status === 0;
  if (!clean) {
    bad++;
    const count = /Found (\d+) errors?/.exec(out)?.[1] ?? "?";
    console.log(`FAIL  ${file}  (${count} errors)`);
    for (const line of out.split("\n").filter((l) => /TS\d+ /.test(l)).slice(0, 4)) {
      console.log(`      ${line.replace(/\x1b\[[0-9;]*m/g, "").trim()}`);
    }
  } else {
    console.log(`ok    ${file}`);
  }
}
console.log(bad === 0 ? "\nAll functions type-check." : `\n${bad} file(s) failed.`);
process.exit(bad === 0 ? 0 : 1);

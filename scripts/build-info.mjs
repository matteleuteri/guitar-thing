// Stamp the build with the branch + commit it came from, so a running page can
// prove which code it is executing. dist/ is gitignored, which means switching
// branches can silently leave you testing the PREVIOUS branch's build; this file
// is what makes that visible (the page compares it against the live HEAD that
// server.mjs reports on /__git).
//
// Best-effort by design: the Pages deploy runs `npm run build` too, where the
// checkout may be shallow or git may be unavailable. Never fail a build over it.
import { writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";

function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

const branch = git("rev-parse", "--abbrev-ref", "HEAD") || "unknown";
const commit = git("rev-parse", "--short", "HEAD") || "unknown";
const dirty = git("status", "--porcelain") !== "";
const subject = git("log", "-1", "--pretty=%s");

await mkdir("dist", { recursive: true });
await writeFile(
  "dist/__build.json",
  JSON.stringify({ branch, commit, dirty, subject, builtAt: new Date().toISOString() }, null, 2) + "\n",
  "utf8",
);

console.log(`build stamp: ${branch}@${commit}${dirty ? " (dirty)" : ""}`);

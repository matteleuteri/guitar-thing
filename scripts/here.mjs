// Answer "which branch am I on, and is the served build actually from it?"
//
// dist/ is gitignored, so switching branches does NOT switch the build -- a
// stale dist/ from the previous branch is served and tested as if it were the
// new one. This compares the commit baked into dist/__build.json against the
// live HEAD and says so plainly.
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

const branch = git("rev-parse", "--abbrev-ref", "HEAD") || "unknown";
const commit = git("rev-parse", "--short", "HEAD") || "unknown";
const subject = git("log", "-1", "--pretty=%s");
const dirty = git("status", "--porcelain") !== "";
const unpushed = git("log", "--oneline", "origin/main..HEAD").split("\n").filter(Boolean);

console.log(`branch   ${branch}${dirty ? "  (uncommitted changes in the working tree)" : ""}`);
console.log(`commit   ${commit}  ${subject}`);

let stamp = null;
try {
  stamp = JSON.parse(await readFile("dist/__build.json", "utf8"));
} catch {
  /* not built yet */
}

if (!stamp) {
  console.log("build    MISSING -- run: npm start");
} else if (stamp.commit !== commit || stamp.branch !== branch) {
  console.log(`build    STALE -- dist/ is from ${stamp.branch}@${stamp.commit}, you are on ${branch}@${commit}`);
  console.log("         run: npm start   (rebuilds and re-serves)");
} else {
  console.log(`build    ok (${stamp.branch}@${stamp.commit}, built ${stamp.builtAt})`);
}

console.log(
  `pushed   ${unpushed.length === 0 ? "nothing ahead of origin/main" : `${unpushed.length} commit(s) ahead of origin/main, not pushed`}`,
);
if (branch === "main" && unpushed.length > 0) {
  console.log("\nWARNING: on main with unpushed commits -- pushing here deploys the live site.");
}
console.log("\nserve    npm start   ->  http://localhost:5173");
console.log("ear      http://localhost:5173/debug/riff-debug.html");
console.log("gate     npm test");

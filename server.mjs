import { createServer } from "node:http";
import { readFile, appendFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const root = process.cwd();
const port = Number(process.env.PORT || 5173);
/** The debug harness appends comparison stats to this gitignored JSON-lines file. */
const saveFile = join("debug", "comparisons.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    // Save endpoint: append one JSON comparison record to the gitignored
    // save file (mostly local debugging; the Pages deploy never runs this).
    if (req.method === "POST" && url.pathname === "/" + saveFile) {
      try {
        const record = JSON.parse(await readBody(req, 128 * 1024));
        await appendFile(join(root, saveFile), JSON.stringify(record) + "\n", "utf8");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("Bad JSON body");
      }
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method not allowed");
      return;
    }
    let path = normalize(join(root, url.pathname === "/" ? "index.html" : url.pathname));
    if (!path.startsWith(root)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    const data = await readFile(path);
    // Never let the browser cache during local development: a rebuilt dist/ or
    // edited page must show up on plain refresh, not a stale cached copy.
    res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}).listen(port, () => {
  console.log(`Note/Chord Finder running at http://localhost:${port}`);
});

/** Collect the request body up to a size limit (used by the save endpoint). */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
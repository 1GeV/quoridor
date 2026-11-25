// Build a static release from an explicit file list; local notes and previews stay local.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.resolve(root, "dist");
const marker = ".quoridor-site-build.json";
const entries = [
  ".nojekyll", "index.html", "board.css", "app.js", "rules.js", "sigma.js", "startup.js", "isolation-sw.js",
  "alphabeta.js", "alphabeta-worker.js", "claustrophobia.js", "detour.js",
  "endgame.js", "external-ai.js", "guided.js", "heuristic.js", "ai-assets.js",
  "privacy.html", "terms.html", "legal.css", "LICENSE", "NOTICE.md", "models", "vendor",
];

if (output !== path.join(root, "dist")) throw new Error("Unexpected build directory");
try {
  const existing = await fs.lstat(output);
  if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Build output must be a real directory");
  const previous = JSON.parse(await fs.readFile(path.join(output, marker), "utf8"));
  if (previous.generator !== "quoridor-static-site") throw new Error("Unrecognized build output");
  // Only replace a verified, previously generated directory within this project.
  await fs.rm(output, { recursive: true });
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  // An existing directory without the marker must not be overwritten.
  try { await fs.access(output); throw new Error("dist exists without a build marker"); }
  catch (check) { if (check.code !== "ENOENT") throw check; }
}
await fs.mkdir(output);
const files = [];
async function copy(relative) {
  const source = path.join(root, relative), target = path.join(output, relative);
  const info = await fs.lstat(source);
  if (info.isSymbolicLink()) throw new Error("Release entries cannot be symbolic links");
  if (info.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    for (const name of (await fs.readdir(source)).sort()) await copy(path.join(relative, name));
  } else if (info.isFile()) {
    const data = await fs.readFile(source);
    if (info.size >= 100 * 1024 * 1024) throw new Error("A release file exceeds GitHub's file-size limit");
    await fs.writeFile(target, data);
    files.push({ path: relative.split(path.sep).join("/"), bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
  } else throw new Error("Unsupported release entry");
}
for (const entry of entries) await copy(entry);
await fs.writeFile(path.join(output, marker), JSON.stringify({ generator: "quoridor-static-site", files }, null, 2) + "\n");
console.log(`Built ${files.length} static files (${(files.reduce((n, f) => n + f.bytes, 0) / 1024 / 1024).toFixed(1)} MiB) in dist/`);

// Bundles the server with a build stamp, so the running app knows which version it is (see src/server/version.ts).
// The id is the git commit when there is one (a Docker build has no .git, so it falls back to the build time).
// BUILD_ID / BUILD_NOTE in the environment override both.
import { execSync } from "node:child_process";
import { build } from "esbuild";

const git = (args) => { try { return execSync("git " + args, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };
const builtAt = new Date().toISOString();
const sha = git("rev-parse --short=7 HEAD");
const dirty = sha && git("status --porcelain") ? "+" : "";
const id = process.env.BUILD_ID || (sha ? sha + dirty : "t" + builtAt.slice(0, 16).replace(/\D/g, ""));
const note = process.env.BUILD_NOTE || git("log -1 --format=%s");

await build({
  entryPoints: ["src/server/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  packages: "external",
  external: ["node:sqlite"],
  outfile: "dist-server/index.js",
  define: { __BUILD__: JSON.stringify({ id, builtAt, note: note.slice(0, 160) }) },
});
console.log(`server built: ${id} (${builtAt})`);

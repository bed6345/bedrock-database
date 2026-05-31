const esbuild = require("esbuild");
const fsExtra = require("fs-extra");

const args = process.argv.slice(2);
const isDev = args.includes("dev");

// Allow overriding the entry point to build the two-server demo pack. Use the
// cross-platform flag `--entry=src/index.dev.ts` (works on Windows/macOS/Linux);
// the ENTRY env var is still honored for backwards compatibility. Defaults to
// the normal library entry.
const entryArg = args.find((a) => a.startsWith("--entry="));
const entry = entryArg
  ? entryArg.slice("--entry=".length)
  : process.env.ENTRY || "src/index.ts";

const dir = "./scripts";

if (!fsExtra.existsSync(dir)) {
  fsExtra.mkdirSync(dir);
}
fsExtra.emptyDirSync(dir);

esbuild
  .build({
    entryPoints: [entry],
    bundle: true,
    outfile: "scripts/index.js",
    minify: !isDev,
    platform: "neutral",
    watch: isDev,
    external: [
      "@minecraft/server",
      "@minecraft/server-net",
      "@minecraft/server-admin",
    ],
    legalComments: isDev ? "none" : "none",
  })
  .then((r) => {
    console.log(
      `\x1b[33m%s\x1b[0m`,
      `[${new Date().toLocaleTimeString()}]`,
      `Built "${entry}" for ${isDev ? "development" : "production"}...`
    );
  });
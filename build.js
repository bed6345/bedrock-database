const esbuild = require("esbuild");
const fsExtra = require("fs-extra");
const isDev = process.argv[2] === "dev";

// Allow overriding the entry point, e.g. ENTRY=src/index.dev.ts to build the
// two-server demo pack. Defaults to the normal library entry.
const entry = process.env.ENTRY || "src/index.ts";

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